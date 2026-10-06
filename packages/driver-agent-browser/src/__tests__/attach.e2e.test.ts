import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRef, parseDevToolsActivePort, type Endpoint } from '@pilot-browser/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer } from '../../../../test-fixtures/server.js';
import { AgentBrowserDriver } from '../driver.js';

// Attach mode against a browser this test launches itself (throwaway profile, its own
// debugging port, so no approval dialog). Same agent-browser code path as attaching to a
// user's browser: --cdp <ws> --pin-tab. Opt in with PILOT_E2E=1.
const enabled = process.env.PILOT_E2E === '1';
const chrome = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);

const waitForFile = async (file: string, timeoutMs: number): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFile(file, 'utf8').catch(() => '');
    if (content.includes('\n')) return content;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
};

describe.skipIf(!enabled || !chrome)('AgentBrowserDriver attach mode (pre-launched Chrome)', () => {
  const driver = new AgentBrowserDriver({ sessionName: `pilot-attach-${process.pid}` });
  let browser: ChildProcess;
  let userDataDir: string;
  let endpoint: Endpoint;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;

  beforeAll(async () => {
    server = await startFixtureServer();
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'pilot-attach-profile-'));
    browser = spawn(chrome ?? '', ['--headless=new', `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], {
      stdio: 'ignore',
    });
    const wsUrl = parseDevToolsActivePort(await waitForFile(path.join(userDataDir, 'DevToolsActivePort'), 20_000));
    if (!wsUrl) throw new Error('bad DevToolsActivePort');
    endpoint = { engine: 'chromium', browser: 'chrome', wsUrl, source: userDataDir };
  }, 60_000);

  afterAll(async () => {
    await driver.disconnect();
    browser?.kill();
    await server.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('should open its own tab, inject the overlay and drive the page', async () => {
    const session = await driver.connect({ kind: 'attach', endpoint });
    expect(session.ok).toBe(true);
    const nav = await driver.act('', { type: 'navigate', url: `${server.base}/index.html` });
    if (!nav.ok) throw new Error(JSON.stringify(nav.error));
    const go = findRef(nav.value.refs, { role: 'button', name: 'Go' });
    const after = await driver.act(nav.value.observationId, { type: 'click', target: { ref: go?.ref ?? '' } });
    expect(after.ok).toBe(true);
    const all = await driver.observe({ filter: 'all' });
    expect(all.ok && all.value.tree).toContain('clicked trusted=true');
  }, 60_000);

  it('should have the overlay installed and keep it out of the snapshot', async () => {
    await driver.setStatus('Testing status');
    const shot = await driver.screenshot();
    expect(shot.ok).toBe(true);
    const all = await driver.observe({ filter: 'all' });
    expect(all.ok && all.value.tree).not.toContain('pilot-browser is controlling');
  });

  it('should detach without closing the browser', async () => {
    await driver.disconnect();
    expect(browser.exitCode).toBeNull();
    expect(existsSync(path.join(userDataDir, 'DevToolsActivePort'))).toBe(true);
  });
});
