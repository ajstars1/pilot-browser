import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Action, BrowserDriver, BrowserError, ConnectMode, ControlState, Endpoint, LeaseSnapshot, Observation, Result, SessionInfo, TargetFacts } from '@pilot-browser/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPilotServer, resolveUploadPath, type PilotServerOptions } from '../server.js';
import { defaultSettings, type Settings } from '../settings.js';

/** Never read the developer's real ~/.pilot-browser/config.json in tests. */
const isolated = (over: Partial<Settings> = {}) => async (): Promise<Settings> => ({ ...defaultSettings('/tmp/pilot-test-home'), ...over });

/**
 * In-memory stand-in for a browser: a URL plus a fixed tree. It exists to test the
 * server's own logic (policy, jail, formatting); real-browser behaviour is covered by
 * the e2e suites, which never use this.
 */
class ScriptedDriver implements BrowserDriver {
  readonly capabilities = { a11yTree: true, multiClient: true, bindings: false, screencast: false, fileUpload: true, handoff: true };
  url = 'about:blank';
  /** Where the next click lands, to simulate a link that leaves the allowlist. */
  clickNavigatesTo: string | null = null;
  readonly actions: Action[] = [];
  readonly statuses: string[] = [];
  disconnected = false;
  /** Next act() fails with this error, to simulate the user taking over or pressing Stop. */
  failNextAct: BrowserError | null = null;
  /** What waitForUser resolves to, and how many progress ticks it emits first. */
  waitOutcome: ControlState = 'agent';
  waitTicks = 0;
  handoffMessage = '';
  /** What describeTarget reports for the next action, and how the user answers approvals. */
  facts: TargetFacts | null = null;
  decision: 'approved' | 'denied' | 'timeout' | 'user' | 'stopped' = 'approved';
  pageStillCurrent = true;
  readonly approvalRequests: string[] = [];
  /** Text shown on the page, so taint tests can put a code on one origin. */
  pageText = '';
  private id = 0;

  private obs(): Observation {
    return {
      observationId: `obs${this.id}`,
      url: this.url,
      title: 'Fake',
      tree: `- button "Go" [ref=e1]\n- textbox "Email" [ref=e2]${this.pageText ? `\n- StaticText ${JSON.stringify(this.pageText)}` : ''}`,
      refs: [
        { ref: 'e1', role: 'button', name: 'Go', depth: 0, attrs: [], value: '', raw: '- button "Go" [ref=e1]' },
        { ref: 'e2', role: 'textbox', name: 'Email', depth: 0, attrs: [], value: '', raw: '- textbox "Email" [ref=e2]' },
      ],
      omitted: 3,
    };
  }

  async connect(_mode: ConnectMode): Promise<Result<SessionInfo>> {
    return { ok: true, value: { sessionId: 's', browserVersion: 'Chrome/154', tabId: 't1' } };
  }
  async observe(): Promise<Result<Observation>> {
    return { ok: true, value: this.obs() };
  }
  async act(observationId: string, action: Action): Promise<Result<Observation>> {
    if (this.failNextAct) {
      const error = this.failNextAct;
      this.failNextAct = null;
      return { ok: false, error };
    }
    this.actions.push(action);
    if (action.type === 'navigate') this.url = action.url;
    if (action.type === 'click') {
      if (observationId !== `obs${this.id}`) return { ok: false, error: { code: 'stale_ref', message: 'stale', retryable: true } };
      if (this.clickNavigatesTo) this.url = this.clickNavigatesTo;
    }
    this.id += 1;
    return { ok: true, value: this.obs() };
  }
  async screenshot() {
    return { ok: false as const, error: { code: 'engine_error' as const, message: 'n/a', retryable: false } };
  }
  async setStatus(text: string): Promise<void> {
    this.statuses.push(text);
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  async control(): Promise<LeaseSnapshot> {
    return { state: 'agent', message: '', handbacks: 0, approvals: 0, denials: 0 };
  }
  async requestHandoff(message: string): Promise<Result<LeaseSnapshot>> {
    this.handoffMessage = message;
    return { ok: true, value: { state: 'handoff', message, handbacks: 0, approvals: 0, denials: 0 } };
  }
  async describeTarget(): Promise<Result<TargetFacts | null>> {
    return { ok: true, value: this.facts };
  }
  async requestApproval(summary: string): Promise<Result<LeaseSnapshot>> {
    this.approvalRequests.push(summary);
    return { ok: true, value: { state: 'approval', message: summary, handbacks: 0, approvals: 0, denials: 0 } };
  }
  async waitForDecision(): Promise<'approved' | 'denied' | 'timeout' | 'user' | 'stopped'> {
    return this.decision;
  }
  async isCurrent(): Promise<boolean> {
    return this.pageStillCurrent;
  }
  async waitForUser(_timeoutMs: number, onTick?: (elapsedMs: number) => void): Promise<ControlState> {
    for (let i = 1; i <= this.waitTicks; i++) onTick?.(i * 1000);
    return this.waitOutcome;
  }
}

const endpoint: Endpoint = { engine: 'chromium', browser: 'chrome', wsUrl: 'ws://127.0.0.1:9222/devtools/browser/x', source: 'test' };

const textOf = (result: unknown): string =>
  ((result as { content: { type: string; text?: string }[] }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');

describe('pilot-browser MCP server', () => {
  let driver: ScriptedDriver;
  let client: Client;
  let close: () => Promise<void>;

  const start = async (extra: Partial<PilotServerOptions> = {}): Promise<void> => {
    driver = new ScriptedDriver();
    const server = createPilotServer({ createDriver: () => driver, discover: async () => [endpoint], loadSettings: isolated(), ...extra });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  };
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await close();
  });

  it('should expose a small, browser_-prefixed tool surface', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'browser_check',
        'browser_click',
        'browser_connect',
        'browser_dialog',
        'browser_disconnect',
        'browser_handoff',
        'browser_navigate',
        'browser_press_key',
        'browser_read_page',
        'browser_screenshot',
        'browser_scroll',
        'browser_select',
        'browser_type',
        'browser_upload',
        'browser_wait_for_user',
      ].sort(),
    );
  });

  it('should report its package version to clients', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'pilot-browser', version: '0.2.0' });
  });

  it('should require allowedOrigins to connect', async () => {
    const result = await call('browser_connect', { mode: 'attach' });
    expect(result.isError).toBe(true);
  });

  it('should tell the user how to enable remote debugging when no browser is found', async () => {
    await close();
    await start({ discover: async () => [] });
    const result = await call('browser_connect', { allowedOrigins: ['github.com'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('chrome://inspect/#remote-debugging');
  });

  it('should block navigation outside the allowed origins before the browser sees it', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    const result = await call('browser_navigate', { url: 'https://evil.example/steal' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('blocked_by_policy');
    expect(driver.actions).toEqual([]);
  });

  it('should reset the tab when a click lands outside the allowed origins', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/notifications' });
    driver.clickNavigatesTo = 'https://evil.example/landing';
    const result = await call('browser_click', { observationId: 'obs1', ref: 'e1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('reset to about:blank');
    expect(driver.url).toBe('about:blank');
  });

  it('should wrap page content as untrusted and report omitted elements', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    const result = await call('browser_navigate', { url: 'https://github.com/' });
    const body = textOf(result);
    expect(body).toContain('observationId: obs1');
    expect(body).toMatch(/<page_content untrusted="true">\nurl: https:\/\/github.com\/\ntitle: Fake\n- button "Go" \[ref=e1\]/);
    expect(body).toContain('3 more elements not shown');
  });

  it('should surface stale observations as retryable errors', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/' });
    const result = await call('browser_click', { observationId: 'obs0', ref: 'e1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error [stale_ref] (retryable)');
  });

  it('should show each action in the overlay status pill', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/' });
    await call('browser_type', { observationId: 'obs1', ref: 'e2', text: 'hi', submit: true });
    expect(driver.statuses).toEqual(['Opening github.com', 'Typing into “Email”', 'Submitting']);
    expect(driver.actions.at(-1)).toEqual({ type: 'key', keys: 'Enter' });
  });

  it('should refuse uploads unless an upload folder is configured', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    const result = await call('browser_upload', { observationId: 'obs0', ref: 'e1', paths: ['resume.pdf'] });
    expect(textOf(result)).toContain('Uploads are disabled');
  });

  it('should hand the tab to the user and return a fresh page when they press Done', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/login' });
    const result = await call('browser_handoff', { kind: 'login', message: 'Log in to GitHub, then press Done' });
    expect(driver.handoffMessage).toBe('Log in to GitHub, then press Done');
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/^The user handed control back[\s\S]*observationId: obs1/);
  });

  it('should report progress while waiting and say when it is still waiting', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    driver.waitOutcome = 'handoff';
    driver.waitTicks = 3;
    const progress: number[] = [];
    const result = await client.callTool(
      { name: 'browser_handoff', arguments: { kind: 'mfa', message: 'Enter your 2FA code', waitSeconds: 30 } },
      undefined,
      { onprogress: (p) => progress.push(p.progress) },
    );
    expect(progress).toEqual([1, 2, 3]);
    expect(textOf(result)).toContain('Still waiting');
    expect(textOf(result)).toContain('browser_wait_for_user');
  });

  it('should tell the model to wait when the user has taken over', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/' });
    driver.failNextAct = { code: 'user_control', message: 'The user has taken control of the tab.', retryable: true };
    const result = await call('browser_click', { observationId: 'obs1', ref: 'e1' });
    expect(textOf(result)).toContain('Error [user_control] (retryable)');
    expect(textOf(result)).toContain('call browser_wait_for_user');
    expect(driver.disconnected).toBe(false);
  });

  it('should end the session when the user presses Stop', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_navigate', { url: 'https://github.com/' });
    driver.failNextAct = { code: 'user_stopped', message: 'The user pressed Stop.', retryable: false };
    const result = await call('browser_click', { observationId: 'obs1', ref: 'e1' });
    expect(textOf(result)).toContain('session has been closed');
    expect(driver.disconnected).toBe(true);
    expect(textOf(await call('browser_read_page'))).toContain('Not connected');
  });

  it('should end the session when the user presses Stop during a wait', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    driver.waitOutcome = 'stopped';
    const result = await call('browser_wait_for_user', {});
    expect(textOf(result)).toContain('user_stopped');
    expect(driver.disconnected).toBe(true);
  });

  it('should detach from the browser on disconnect', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_disconnect');
    expect(driver.disconnected).toBe(true);
    expect(textOf(await call('browser_read_page'))).toContain('Not connected');
  });
});

const submitFacts = (formAction: string, formMethod = 'post'): TargetFacts => ({
  tag: 'BUTTON',
  type: null,
  role: null,
  text: 'Continue',
  href: null,
  inForm: true,
  formMethod,
  formAction,
});

describe('pilot-browser MCP server: approvals and guards', () => {
  let driver: ScriptedDriver;
  let client: Client;
  let close: () => Promise<void>;
  const start = async (extra: Partial<PilotServerOptions> = {}): Promise<void> => {
    driver = new ScriptedDriver();
    const server = createPilotServer({ createDriver: () => driver, discover: async () => [endpoint], loadSettings: isolated(), ...extra });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    close = async () => {
      await client.close();
      await server.close();
    };
    await client.callTool({ name: 'browser_connect', arguments: { allowedOrigins: ['shop.example.com', 'mail.example.com'] } });
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://shop.example.com/cart' } });
  };
  const click = () => client.callTool({ name: 'browser_click', arguments: { observationId: 'obs1', ref: 'e1' } });

  afterEach(async () => {
    await close();
  });

  it('should ask for approval before submitting a POST form, and act once approved', async () => {
    await start();
    driver.facts = submitFacts('https://shop.example.com/order');
    const result = await click();
    expect(result.isError).toBeFalsy();
    expect(driver.approvalRequests).toEqual(['Click “Go” on shop.example.com']);
    expect(driver.actions.at(-1)).toEqual({ type: 'click', target: { ref: 'e1' }, button: 'left', clickCount: 1 });
  });

  it('should not act when the user denies, and tell the model not to retry', async () => {
    await start();
    driver.facts = submitFacts('https://shop.example.com/order');
    driver.decision = 'denied';
    const before = driver.actions.length;
    const result = await click();
    expect(textOf(result)).toContain('Error [approval_denied]');
    expect(textOf(result)).toContain('Do not retry');
    expect(driver.actions.length).toBe(before);
  });

  it('should not act if the page changed while waiting for approval', async () => {
    await start();
    driver.facts = submitFacts('https://shop.example.com/order');
    driver.pageStillCurrent = false;
    const before = driver.actions.length;
    expect(textOf(await click())).toContain('approval no longer applies');
    expect(driver.actions.length).toBe(before);
  });

  it('should block a form that posts to another origin before asking anyone', async () => {
    await start();
    driver.facts = submitFacts('https://evil.example/collect');
    const result = await click();
    expect(textOf(result)).toContain('https://evil.example/collect, which is outside the allowed origins');
    expect(driver.approvalRequests).toEqual([]);
  });

  it('should let routine clicks through without asking', async () => {
    await start();
    driver.facts = { ...submitFacts('https://shop.example.com/search', 'get'), text: 'Search' };
    expect((await click()).isError).toBeFalsy();
    expect(driver.approvalRequests).toEqual([]);
  });

  it('should ask before typing text that was read on another site', async () => {
    await start();
    driver.pageText = 'Your code is 482913';
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://mail.example.com/inbox' } });
    driver.pageText = '';
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://shop.example.com/verify' } });
    await client.callTool({ name: 'browser_type', arguments: { observationId: 'obs3', ref: 'e2', text: '482913' } });
    expect(driver.approvalRequests).toEqual(['Type “482913” on shop.example.com']);
  });

  it('auto mode: submits run without asking, payments still ask', async () => {
    await start({ loadSettings: isolated({ mode: 'auto' }) });
    driver.facts = submitFacts('https://shop.example.com/apply');
    expect((await click()).isError).toBeFalsy();
    expect(driver.approvalRequests).toEqual([]);
    driver.facts = { ...submitFacts('https://shop.example.com/pay'), text: 'Pay now' };
    await click();
    expect(driver.approvalRequests).toEqual(['Click “Go” on shop.example.com']);
  });

  it('auto mode: typing text copied from another site still asks', async () => {
    await start({ loadSettings: isolated({ mode: 'auto' }) });
    driver.pageText = 'Your code is 482913';
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://mail.example.com/inbox' } });
    driver.pageText = '';
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://shop.example.com/verify' } });
    await client.callTool({ name: 'browser_type', arguments: { observationId: 'obs3', ref: 'e2', text: '482913' } });
    expect(driver.approvalRequests).toEqual(['Type “482913” on shop.example.com']);
  });

  it('manual mode: even routine clicks and typing ask; navigation does not', async () => {
    await start({ loadSettings: isolated({ mode: 'manual' }) });
    driver.facts = { ...submitFacts('https://shop.example.com/search', 'get'), text: 'Search' };
    await click();
    await client.callTool({ name: 'browser_type', arguments: { observationId: 'obs2', ref: 'e2', text: 'hello' } });
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://shop.example.com/other' } });
    expect(driver.approvalRequests).toEqual(['Click “Go” on shop.example.com', 'Type “hello” on shop.example.com']);
  });

  it('should report the mode at connect and re-read settings on every connect', async () => {
    let mode: Settings['mode'] = 'supervised';
    await start({ loadSettings: async () => ({ ...defaultSettings('/tmp/pilot-test-home'), mode }) });
    await client.callTool({ name: 'browser_disconnect', arguments: {} });
    mode = 'auto';
    const connected = await client.callTool({ name: 'browser_connect', arguments: { allowedOrigins: ['shop.example.com'] } });
    expect(textOf(connected)).toContain('Approval mode: auto');
  });

  it('should skip approvals when the operator turned them off, but keep the origin policy', async () => {
    await start({ approvals: 'off' });
    driver.facts = submitFacts('https://shop.example.com/order');
    expect((await click()).isError).toBeFalsy();
    expect(driver.approvalRequests).toEqual([]);
    driver.facts = submitFacts('https://evil.example/collect');
    expect(textOf(await click())).toContain('outside the allowed origins');
  });

  it('should hand accepting a confirm dialog to the user', async () => {
    await start();
    driver.facts = { ...submitFacts(''), tag: 'DIALOG', inForm: false, formMethod: null, formAction: null, text: 'Delete everything?', dialogType: 'confirm' };
    const result = await client.callTool({ name: 'browser_dialog', arguments: { accept: true } });
    expect(textOf(result)).toContain('needs_approval');
    expect(textOf(result)).toContain('browser_handoff');
  });
});

describe('resolveUploadPath', () => {
  it('should allow files inside the folder and refuse escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pilot-upload-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'pilot-outside-'));
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'resume.pdf'), 'x');
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt')).catch(() => undefined);

    expect(await resolveUploadPath(root, 'docs/resume.pdf')).toMatch(/resume\.pdf$/);
    expect(await resolveUploadPath(root, '../' + path.basename(outside) + '/secret.txt')).toBeNull();
    expect(await resolveUploadPath(root, path.join(outside, 'secret.txt'))).toBeNull();
    expect(await resolveUploadPath(root, 'link.txt')).toBeNull();
    expect(await resolveUploadPath(root, 'missing.pdf')).toBeNull();
    expect(await resolveUploadPath(root, '.')).toBeNull();
  });
});
