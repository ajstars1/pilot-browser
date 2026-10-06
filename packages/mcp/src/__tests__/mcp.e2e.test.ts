import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, startFixtureServer } from '../../../../test-fixtures/server.js';

// Spawns the built server (dist/bin.js) over stdio and drives a real headless Chrome.
// Opt in with PILOT_E2E=1 after `npm run build`.
const enabled = process.env.PILOT_E2E === '1';
const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const chrome = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(existsSync);

const textOf = (result: unknown): string =>
  ((result as { content: { type: string; text?: string }[] }).content ?? [])
    .map((c) => c.text ?? '')
    .join('\n');
const field = (body: string, name: string): string => new RegExp(`^${name}: (.+)$`, 'm').exec(body)?.[1] ?? '';
const refFor = (body: string, label: string): string => new RegExp(`"${label}"[^\\n]*?ref=(e\\d+)`).exec(body)?.[1] ?? '';

describe.skipIf(!enabled)('pilot-browser-mcp over stdio (real Chrome)', () => {
  let client: Client;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  let profileRoot: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    profileRoot = await mkdtemp(path.join(os.tmpdir(), 'pilot-mcp-profiles-'));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PILOT_PROFILE_DIR: profileRoot, PILOT_UPLOAD_DIR: FIXTURES_DIR, PILOT_APPROVALS: 'off' };
    if (chrome) env.PILOT_CHROME = chrome;
    client = new Client({ name: 'e2e', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env }));
  }, 60_000);

  afterAll(async () => {
    await client?.callTool({ name: 'browser_disconnect', arguments: {} }).catch(() => undefined);
    await client?.close();
    await server.close();
    await rm(profileRoot, { recursive: true, force: true });
  });

  it('should run a full session: connect, navigate, act, upload, enforce policy, screenshot', async () => {
    const connected = await client.callTool({
      name: 'browser_connect',
      arguments: { mode: 'managed', headless: true, profile: 'e2e', allowedOrigins: [new URL(server.base).host] },
    });
    expect(textOf(connected)).toContain('Connected (managed)');

    let page = textOf(await client.callTool({ name: 'browser_navigate', arguments: { url: `${server.base}/index.html` } }));
    expect(page).toContain('<page_content untrusted="true">');
    expect(page).toMatch(/more elements not shown/);

    page = textOf(await client.callTool({ name: 'browser_click', arguments: { observationId: field(page, 'observationId'), ref: refFor(page, 'Go') } }));
    page = textOf(await client.callTool({ name: 'browser_click', arguments: { observationId: field(page, 'observationId'), ref: refFor(page, 'Save draft') } }));
    page = textOf(
      await client.callTool({
        name: 'browser_upload',
        arguments: { observationId: field(page, 'observationId'), ref: refFor(page, 'Resume'), paths: ['resume.txt'] },
      }),
    );
    const escaped = await client.callTool({
      name: 'browser_upload',
      arguments: { observationId: field(page, 'observationId'), ref: refFor(page, 'Resume'), paths: ['../package.json'] },
    });
    expect(textOf(escaped)).toContain('blocked_by_policy');

    const all = textOf(await client.callTool({ name: 'browser_read_page', arguments: { filter: 'all' } }));
    expect(all).toContain('clicked trusted=true');
    expect(all).toContain('div clicked trusted=true');
    expect(all).toContain('file=resume.txt');

    const blocked = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com/' } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain('blocked_by_policy');

    const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    const image = (shot.content as { type: string; data?: string }[]).find((c) => c.type === 'image');
    expect(image?.data?.length ?? 0).toBeGreaterThan(1000);

    // A real handoff through the server: nobody presses Done, so it reports that it's still
    // waiting, and the agent stays blind until the user hands back.
    const progress: number[] = [];
    const handoff = await client.callTool(
      { name: 'browser_handoff', arguments: { kind: 'login', message: 'E2E: please log in', waitSeconds: 5 } },
      undefined,
      { timeout: 60_000, onprogress: (p) => progress.push(p.progress) },
    );
    expect(textOf(handoff)).toContain('Still waiting');
    expect(progress.length).toBeGreaterThan(0);
    const blind = await client.callTool({ name: 'browser_read_page', arguments: {} });
    expect(textOf(blind)).toContain('user_control');
    expect(textOf(blind)).toContain('E2E: please log in');

    expect(textOf(await client.callTool({ name: 'browser_disconnect', arguments: {} }))).toBe('Disconnected.');
  }, 120_000);
});
