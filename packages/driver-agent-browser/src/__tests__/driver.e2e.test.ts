import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRef, type Observation } from '@pilot-browser/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, startFixtureServer } from '../../../../test-fixtures/server.js';
import { AgentBrowserDriver } from '../driver.js';

// Real browser, no mocks. Opt in with PILOT_E2E=1 (CI runs it on Linux).
const enabled = process.env.PILOT_E2E === '1';
const executablePath = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe.skipIf(!enabled)('AgentBrowserDriver (managed, headless, real Chrome)', () => {
  const driver = new AgentBrowserDriver({ sessionName: `pilot-e2e-${process.pid}` });
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileDir: string;
  let obs: Observation;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileDir = await mkdtemp(path.join(os.tmpdir(), 'pilot-e2e-profile-'));
    must(await driver.connect({ kind: 'managed', profileDir, headless: true, ...(executablePath ? { executablePath } : {}) }));
    must(await driver.act('', { type: 'navigate', url: `${server.base}/index.html` }));
    obs = must(await driver.observe());
  }, 120_000);

  afterAll(async () => {
    await driver.disconnect();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  });

  it('should clip the observation to the viewport and report what it left out', () => {
    expect(findRef(obs.refs, { role: 'button', name: 'Go' })).toBeDefined();
    expect(findRef(obs.refs, { role: 'link', name: 'Offscreen link number 150' })).toBeUndefined();
    expect(obs.omitted).toBeGreaterThan(100);
  });

  it('should find role-less clickable elements and click them with trusted input', async () => {
    const div = findRef(obs.refs, { name: 'Save draft' });
    expect(div?.role).toBe('generic');
    must(await driver.act(obs.observationId, { type: 'click', target: { ref: div?.ref ?? '' } }));
    const all = must(await driver.observe({ filter: 'all' }));
    expect(all.tree).toContain('div clicked trusted=true');
    obs = must(await driver.observe());
  });

  it('should fill and click inside a cross-origin iframe', async () => {
    const email = findRef(obs.refs, { role: 'textbox', name: 'Email' });
    const after = must(await driver.act(obs.observationId, { type: 'type', ref: email?.ref ?? '', text: 'agent@example.com' }));
    const inner = findRef(after.refs, { role: 'button', name: 'Inner' });
    obs = must(await driver.act(after.observationId, { type: 'click', target: { ref: inner?.ref ?? '' } }));
    expect(obs.tree).toContain('frame-clicked trusted=true email=agent@example.com');
  });

  it('should upload a file and select an option', async () => {
    const file = findRef(obs.refs, { role: 'button', name: 'Resume' });
    obs = must(await driver.act(obs.observationId, { type: 'upload', ref: file?.ref ?? '', files: [path.join(FIXTURES_DIR, 'resume.txt')] }));
    const country = findRef(obs.refs, { role: 'combobox', name: 'Country' });
    obs = must(await driver.act(obs.observationId, { type: 'select', ref: country?.ref ?? '', value: 'India' }));
    const all = must(await driver.observe({ filter: 'all' }));
    expect(all.tree).toContain('file=resume.txt');
    expect(all.tree).toContain('country=in');
    obs = must(await driver.observe());
  });

  it('should reject refs from an observation that is no longer current', async () => {
    const stale = obs;
    must(await driver.act(stale.observationId, { type: 'navigate', url: `${server.base}/frame.html` }));
    const result = await driver.act(stale.observationId, { type: 'click', target: { ref: 'e2' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'stale_ref', retryable: true } });
  });

  it('should reject refs that were never observed', async () => {
    obs = must(await driver.observe());
    const result = await driver.act(obs.observationId, { type: 'click', target: { ref: 'e9999' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('should take a screenshot with real dimensions', async () => {
    const shot = must(await driver.screenshot());
    expect(shot.width).toBeGreaterThan(300);
    expect(shot.png.length).toBeGreaterThan(1000);
  });
});
