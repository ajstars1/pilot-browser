import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Action, BrowserDriver, ConnectMode, Endpoint, Observation, Result, SessionInfo } from '@pilot-browser/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPilotServer, resolveUploadPath, type PilotServerOptions } from '../server.js';

/**
 * In-memory stand-in for a browser: a URL plus a fixed tree. It exists to test the
 * server's own logic (policy, jail, formatting); real-browser behaviour is covered by
 * the e2e suites, which never use this.
 */
class ScriptedDriver implements BrowserDriver {
  readonly capabilities = { a11yTree: true, multiClient: true, bindings: false, screencast: false, fileUpload: true };
  url = 'about:blank';
  /** Where the next click lands, to simulate a link that leaves the allowlist. */
  clickNavigatesTo: string | null = null;
  readonly actions: Action[] = [];
  readonly statuses: string[] = [];
  disconnected = false;
  private id = 0;

  private obs(): Observation {
    return {
      observationId: `obs${this.id}`,
      url: this.url,
      title: 'Fake',
      tree: '- button "Go" [ref=e1]\n- textbox "Email" [ref=e2]',
      refs: [],
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
    const server = createPilotServer({ createDriver: () => driver, discover: async () => [endpoint], ...extra });
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
        'browser_navigate',
        'browser_press_key',
        'browser_read_page',
        'browser_screenshot',
        'browser_scroll',
        'browser_select',
        'browser_type',
        'browser_upload',
      ].sort(),
    );
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
    expect(body).toMatch(/<page_content untrusted="true">\n- button "Go" \[ref=e1\]/);
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
    expect(driver.statuses).toEqual(['Opening github.com', 'Typing into e2', 'Submitting']);
    expect(driver.actions.at(-1)).toEqual({ type: 'key', keys: 'Enter' });
  });

  it('should refuse uploads unless an upload folder is configured', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    const result = await call('browser_upload', { observationId: 'obs0', ref: 'e1', paths: ['resume.pdf'] });
    expect(textOf(result)).toContain('Uploads are disabled');
  });

  it('should detach from the browser on disconnect', async () => {
    await call('browser_connect', { allowedOrigins: ['github.com'] });
    await call('browser_disconnect');
    expect(driver.disconnected).toBe(true);
    expect(textOf(await call('browser_read_page'))).toContain('Not connected');
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
