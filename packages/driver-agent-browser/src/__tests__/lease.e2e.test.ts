import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRef, type Observation } from '@pilot-browser/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../../../../test-fixtures/server.js';
import { resolveAgentBrowser } from '../binary.js';
import { AgentBrowserDriver } from '../driver.js';
import { AgentBrowserRunner } from '../runner.js';

// Interaction lease against real headless Chrome. "The user" is simulated by sending trusted
// input to the same browser session outside the driver, i.e. outside any agent-input window,
// which is exactly what a person clicking in the tab looks like. Opt in with PILOT_E2E=1.
const enabled = process.env.PILOT_E2E === '1';
const executablePath = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe.skipIf(!enabled)('interaction lease and handoff (real Chrome)', () => {
  const driver = new AgentBrowserDriver({ sessionName: `pilot-lease-${process.pid}`, leasePollMs: 200 });
  const userRunner = new AgentBrowserRunner(resolveAgentBrowser());
  const user = (...args: string[]) => userRunner.run(['--session', driver.sessionName], args, { timeoutMs: 30_000 });
  const pressOverlayButton = async (name: string): Promise<void> => {
    const layout = await driver.overlayLayout();
    const at = layout?.buttons[name];
    if (!at) throw new Error(`no ${name} button in ${JSON.stringify(layout)}`);
    await user('mouse', 'move', String(Math.round(at.x)), String(Math.round(at.y)));
    await user('mouse', 'down');
    await user('mouse', 'up');
  };
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileDir: string;
  let obs: Observation;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'pilot-lease-profile-'));
    must(await driver.connect({ kind: 'managed', profileDir, headless: true, ...(executablePath ? { executablePath } : {}) }));
    obs = must(await driver.act('', { type: 'navigate', url: `${server.base}/index.html` }));
  }, 120_000);

  afterAll(async () => {
    await driver.disconnect();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it("should not treat the agent's own clicks as the user taking over", async () => {
    obs = must(await driver.act(obs.observationId, { type: 'click', target: { ref: findRef(obs.refs, { name: 'Go' })?.ref ?? '' } }));
    await sleep(500);
    expect((await driver.control()).state).toBe('agent');
  });

  it('should not let the agent press the overlay buttons', async () => {
    const pause = (await driver.overlayLayout())?.buttons.pause;
    expect(pause).toBeDefined();
    obs = must(await driver.act(obs.observationId, { type: 'click', target: { x: Math.round(pause?.x ?? 0), y: Math.round(pause?.y ?? 0) } }));
    await sleep(500);
    expect((await driver.control()).state).toBe('agent');
  });

  it('should hand control to the user when they click in the tab, and blind the agent', async () => {
    await user('click', findRef(obs.refs, { name: 'Save draft' })?.ref ? `@${findRef(obs.refs, { name: 'Save draft' })?.ref}` : '@e3');
    expect((await driver.control()).state).toBe('user');
    expect((await driver.overlayLayout())?.mode).toBe('user');
    expect(await driver.act(obs.observationId, { type: 'key', keys: 'Tab' })).toMatchObject({ ok: false, error: { code: 'user_control', retryable: true } });
    expect(await driver.observe()).toMatchObject({ ok: false, error: { code: 'user_control' } });
    expect(await driver.screenshot()).toMatchObject({ ok: false, error: { code: 'user_control' } });
  });

  it('should keep the user in control across their own navigation', async () => {
    await user('open', `${server.base}/frame.html`);
    expect((await driver.control()).state).toBe('user');
    expect((await driver.overlayLayout())?.mode).toBe('user');
    await user('open', `${server.base}/index.html`);
    await driver.control();
  });

  it('should give control back only when the user presses Hand back, and invalidate old refs', async () => {
    const stale = obs;
    await pressOverlayButton('handback');
    expect(await driver.control()).toMatchObject({ state: 'agent', handbacks: 1 });
    const result = await driver.act(stale.observationId, { type: 'click', target: { ref: 'e2' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'stale_ref' } });
    obs = must(await driver.observe());
  });

  it('should treat typing in a cross-origin iframe as the user taking over', async () => {
    const email = findRef(obs.refs, { role: 'textbox', name: 'Email' });
    await user('click', `@${email?.ref ?? ''}`);
    await sleep(400);
    expect((await driver.control()).state).toBe('user');
    await pressOverlayButton('handback');
    expect((await driver.control()).state).toBe('agent');
  });

  it('should run a handoff: wait while the user works, resume on Done', async () => {
    must(await driver.requestHandoff('Log in to continue'));
    expect(await driver.control()).toMatchObject({ state: 'handoff', message: 'Log in to continue' });
    expect((await driver.overlayLayout())?.mode).toBe('handoff');
    expect(await driver.act('', { type: 'key', keys: 'Tab' })).toMatchObject({ ok: false, error: { code: 'user_control' } });

    const ticks: number[] = [];
    expect(await driver.waitForUser(600, (ms) => ticks.push(ms))).toBe('handoff');
    expect(ticks.length).toBeGreaterThan(0);

    // The user works in the page; the handoff stays open until they press Done.
    const o = (await driver.overlayLayout())?.buttons;
    expect(o?.handback).toBeDefined();
    await user('press', 'Tab');
    expect((await driver.control()).state).toBe('handoff');

    const waiting = driver.waitForUser(15_000);
    await pressOverlayButton('handback');
    expect(await waiting).toBe('agent');
    obs = must(await driver.observe());
  });

  it('should let the user pause from the agent pill', async () => {
    await pressOverlayButton('pause');
    expect((await driver.control()).state).toBe('user');
    await pressOverlayButton('handback');
    expect((await driver.control()).state).toBe('agent');
  });

  it('should stop for good when the user presses Stop', async () => {
    await pressOverlayButton('stop');
    expect((await driver.control()).state).toBe('stopped');
    expect(await driver.act('', { type: 'key', keys: 'Tab' })).toMatchObject({ ok: false, error: { code: 'user_stopped', retryable: false } });
    expect(await driver.requestHandoff('again')).toMatchObject({ ok: false, error: { code: 'user_stopped' } });
    expect(await driver.waitForUser(1000)).toBe('stopped');
  });
});
