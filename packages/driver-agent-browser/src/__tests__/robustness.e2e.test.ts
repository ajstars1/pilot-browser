import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRef } from '@pilot-browser/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../../../../test-fixtures/server.js';
import { resolveAgentBrowser } from '../binary.js';
import { AgentBrowserDriver } from '../driver.js';
import { browsersForProfile, daemonPid, isAlive, listProcesses } from '../process.js';
import { AgentBrowserRunner } from '../runner.js';

// Real-site failure modes, reproduced with fixtures against real headless Chrome: pages that
// throw the overlay away, CAPTCHA frames that steal focus, unattended runs, dead sessions.
// Opt in with PILOT_E2E=1.
const enabled = process.env.PILOT_E2E === '1';
const executablePath = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const IDLE = 'pilot-browser is controlling this tab';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const userOf = (driver: AgentBrowserDriver) => {
  const runner = new AgentBrowserRunner(resolveAgentBrowser());
  return (...args: string[]) => runner.run(['--session', driver.sessionName], args, { timeoutMs: 30_000 });
};

const launch = async (driver: AgentBrowserDriver): Promise<string> => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'pilot-robust-profile-'));
  must(await driver.connect({ kind: 'managed', profileDir, headless: true, ...(executablePath ? { executablePath } : {}) }));
  return profileDir;
};

describe.skipIf(!enabled)('overlay and lease robustness (real Chrome)', () => {
  const driver = new AgentBrowserDriver({ sessionName: `pilot-robust-${process.pid}`, leasePollMs: 200 });
  const user = userOf(driver);
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await launch(driver);
  }, 120_000);

  afterAll(async () => {
    await driver.disconnect();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  }, 60_000);

  it('should put the controls back when the page removes them (whole-document re-render)', async () => {
    must(await driver.act('', { type: 'navigate', url: `${server.base}/robustness/rerender.html` }));
    await sleep(800);
    await driver.control();
    expect(await driver.overlayMounted()).toBe(true);
    expect((await driver.overlayLayout())?.buttons.pause).toBeDefined();
  });

  it('should stop describing an action once it is done', async () => {
    const obs = must(await driver.observe());
    await driver.setStatus('Clicking “Continue”');
    must(await driver.act(obs.observationId, { type: 'click', target: { ref: findRef(obs.refs, { name: 'Continue' })?.ref ?? '' } }));
    await sleep(900);
    expect((await driver.overlayLayout())?.text).toBe(IDLE);
  });

  it('should not treat a CAPTCHA frame taking focus as the user taking over, and report the challenge', async () => {
    const obs = must(await driver.act('', { type: 'navigate', url: `${server.base}/robustness/captcha-focus.html` }));
    expect(obs.captcha ?? null).toBeNull();
    must(await driver.act(obs.observationId, { type: 'click', target: { ref: findRef(obs.refs, { name: 'Submit application' })?.ref ?? '' } }));
    await sleep(2500);
    expect((await driver.control()).state).toBe('agent');
    expect(must(await driver.observe()).captcha).toBe('recaptcha challenge visible');
  });

  it('should tell a visible challenge from an invisible badge, and a solved checkbox from an unsolved one', async () => {
    const badge = must(await driver.act('', { type: 'navigate', url: `${server.base}/robustness/captcha-states.html` }));
    expect(badge.captcha ?? null).toBeNull();
    await user('eval', 'showChallenge()');
    expect(must(await driver.observe()).captcha).toBe('recaptcha challenge visible');

    must(await driver.act('', { type: 'navigate', url: `${server.base}/robustness/captcha-states.html` }));
    await user('eval', 'showCheckbox()');
    expect(must(await driver.observe()).captcha).toBe('recaptcha checkbox unsolved');
    await user('eval', 'solveCheckbox()');
    expect(must(await driver.observe()).captcha ?? null).toBeNull();

    const gate = must(await driver.act('', { type: 'navigate', url: `${server.base}/robustness/interstitial.html` }));
    expect(gate.captcha).toBe('bot check interstitial');
  });
});

describe.skipIf(!enabled)('unattended lease (real Chrome)', () => {
  const driver = new AgentBrowserDriver({ sessionName: `pilot-unattended-${process.pid}`, leasePollMs: 200, inputTakeover: false });
  const user = userOf(driver);
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await launch(driver);
  }, 120_000);

  afterAll(async () => {
    await driver.disconnect();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  }, 60_000);

  it('should keep acting through input in the tab, but still obey Pause', async () => {
    const obs = must(await driver.act('', { type: 'navigate', url: `${server.base}/index.html` }));
    await user('click', `@${findRef(obs.refs, { name: 'Save draft' })?.ref ?? 'e3'}`);
    await sleep(400);
    expect((await driver.control()).state).toBe('agent');
    expect((await driver.overlayLayout())?.mode).toBe('agent');

    const pause = (await driver.overlayLayout())?.buttons.pause;
    expect(pause).toBeDefined();
    await user('mouse', 'move', String(Math.round(pause?.x ?? 0)), String(Math.round(pause?.y ?? 0)));
    await user('mouse', 'down');
    await user('mouse', 'up');
    expect((await driver.control()).state).toBe('user');
  });
});

describe.skipIf(!enabled)('orphaned overlay (real Chrome)', () => {
  // Polls (the heartbeat) effectively off, as if the driver had died.
  const driver = new AgentBrowserDriver({ sessionName: `pilot-orphan-${process.pid}`, leasePollMs: 600_000 });
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileDir: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await launch(driver);
  }, 120_000);

  afterAll(async () => {
    await driver.disconnect();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  }, 60_000);

  it('should take its controls down when the driver goes quiet, and bring them back when it returns', async () => {
    must(await driver.act('', { type: 'navigate', url: `${server.base}/index.html` }));
    expect(await driver.overlayMounted()).toBe(true);
    await sleep(23_000);
    expect(await driver.overlayMounted()).toBe(false);
    await driver.control();
    expect(await driver.overlayMounted()).toBe(true);
  }, 60_000);
});

describe.skipIf(!enabled || process.platform === 'win32')('hung sessions (real Chrome)', () => {
  // A daemon stuck on a command answers nothing, exactly like one frozen with SIGSTOP.
  const freeze = async (driver: AgentBrowserDriver): Promise<number> => {
    const pid = await daemonPid(driver.sessionName);
    if (pid === null) throw new Error('no daemon pid file');
    process.kill(pid, 'SIGSTOP');
    return pid;
  };
  const browsersOn = async (profileDir: string): Promise<number> => browsersForProfile(await listProcesses(), profileDir).length;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('should close a session that stops answering, freeing its profile', async () => {
    const driver = new AgentBrowserDriver({ sessionName: `pilot-hang-${process.pid}`, commandTimeoutMs: 4_000, leasePollMs: 600_000 });
    const profileDir = await launch(driver);
    try {
      must(await driver.act('', { type: 'navigate', url: `${server.base}/index.html` }));
      const daemon = await freeze(driver);
      const result = await driver.observe();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('stopped responding');
      expect(driver.connected).toBe(false);
      expect(isAlive(daemon)).toBe(false);
      expect(await browsersOn(profileDir)).toBe(0);
    } finally {
      await driver.disconnect();
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("should take back a profile from a hung session's browser, but not from a live one", async () => {
    const first = new AgentBrowserDriver({ sessionName: `pilot-hold-${process.pid}`, leasePollMs: 600_000 });
    const profileDir = await launch(first);
    const second = new AgentBrowserDriver({ sessionName: `pilot-take-${process.pid}`, leasePollMs: 600_000 });
    try {
      const busy = await second.connect({ kind: 'managed', profileDir, headless: true, ...(executablePath ? { executablePath } : {}) });
      expect(busy.ok).toBe(false);
      if (!busy.ok) expect(busy.error.message).toContain('open in another pilot-browser session');

      const daemon = await freeze(first);
      must(await second.connect({ kind: 'managed', profileDir, headless: true, ...(executablePath ? { executablePath } : {}) }));
      expect(isAlive(daemon)).toBe(false);
      must(await second.act('', { type: 'navigate', url: `${server.base}/index.html` }));
    } finally {
      await second.disconnect();
      await first.disconnect();
      await rm(profileDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('should leave no daemon or browser behind after disconnect', async () => {
    const driver = new AgentBrowserDriver({ sessionName: `pilot-clean-${process.pid}`, leasePollMs: 600_000 });
    const profileDir = await launch(driver);
    const daemon = await daemonPid(driver.sessionName);
    await driver.disconnect();
    expect(daemon === null || !isAlive(daemon)).toBe(true);
    expect(await browsersOn(profileDir)).toBe(0);
    await rm(profileDir, { recursive: true, force: true });
  }, 120_000);
});
