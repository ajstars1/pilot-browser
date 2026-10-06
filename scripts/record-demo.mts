// Records docs/images/demo.gif: the real MCP server driving a real (headless) Chrome through a
// fictional job application, with the overlay, an Approve prompt, and the submit.
// Usage: npm run build && node scripts/record-demo.mts
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentBrowserDriver, resolveAgentBrowser } from '@pilot-browser/driver-agent-browser';
import { createPilotServer, defaultSettings } from '@pilot-browser/mcp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test-fixtures');
const OUT_GIF = path.join(ROOT, 'docs', 'images', 'demo.gif');
const HOST = 'careers.acme.test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fixture site on :3000, reached as careers.acme.test via Chrome's host resolver rules.
const site = createServer(async (req, res) => {
  const file = path.join(FIXTURES, path.normalize(new URL(req.url ?? '/', 'http://x').pathname));
  if (!file.startsWith(FIXTURES + path.sep)) return void res.writeHead(403).end();
  const body = await readFile(file).catch(() => null);
  if (!body) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(body);
}).listen(3000, '127.0.0.1');
await new Promise((r) => site.once('listening', r));

const work = await mkdtemp(path.join(os.tmpdir(), 'pilot-demo-'));
const webm = path.join(work, 'demo.webm');
let driver: AgentBrowserDriver | null = null;
const server = createPilotServer({
  loadSettings: async () => ({ ...defaultSettings(work), mode: 'supervised', uploadDir: path.join(FIXTURES, 'demo'), profileDir: work }),
  createDriver: () =>
    (driver = new AgentBrowserDriver({
      sessionName: `pilot-demo-${process.pid}`,
      leasePollMs: 200,
      env: { AGENT_BROWSER_ARGS: `--host-resolver-rules=MAP ${HOST} 127.0.0.1` },
    })),
  ...(process.env.PILOT_CHROME ? { executablePath: process.env.PILOT_CHROME } : { executablePath: '/usr/bin/google-chrome' }),
});
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'demo-agent', version: '0' });
await Promise.all([server.connect(a), client.connect(b)]);

const { command, prefixArgs } = resolveAgentBrowser();
const ab = (...args: string[]) => execFileSync(command, [...prefixArgs, '--session', driver?.sessionName ?? '', ...args], { stdio: 'ignore' });
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  if (r.isError) throw new Error(`${name}: ${text(r)}`);
  await sleep(350); // let viewers follow
  return text(r);
};
const id = (page: string) => /observationId: (\w+)/.exec(page)?.[1] ?? '';
const ref = (page: string, label: string) => new RegExp(`"${label}"[^\\n]*?ref=(e\\d+)`).exec(page)?.[1] ?? '';

/** Play the human: wait for the blue prompt, let it be read, then press Approve. */
const approveWhenAsked = async () => {
  for (;;) {
    const layout = await driver?.overlayLayout();
    const at = layout?.mode === 'approval' ? layout.buttons.approve : undefined;
    if (at) {
      await sleep(1600);
      ab('mouse', 'move', String(Math.round(at.x)), String(Math.round(at.y)));
      ab('mouse', 'down');
      ab('mouse', 'up');
      return;
    }
    await sleep(100);
  }
};

try {
  await call('browser_connect', { mode: 'managed', headless: true, allowedOrigins: [HOST] });
  ab('set', 'viewport', '1000', '760');
  let page = await call('browser_navigate', { url: `http://${HOST}:3000/demo/apply.html` });
  ab('record', 'start', webm);
  await sleep(700);
  page = await call('browser_type', { observationId: id(page), ref: ref(page, 'Full name'), text: 'Alex Rivera' });
  page = await call('browser_type', { observationId: id(page), ref: ref(page, 'Email'), text: 'alex@example.com' });
  page = await call('browser_type', { observationId: id(page), ref: ref(page, 'LinkedIn'), text: 'https://linkedin.com/in/alex-rivera' });
  const uploading = call('browser_upload', { observationId: id(page), ref: ref(page, 'Resume'), paths: ['alex-rivera-resume.pdf'] });
  await approveWhenAsked();
  page = await uploading;
  page = await call('browser_click', { observationId: id(page), ref: ref(page, 'Yes') });
  page = await call('browser_type', { observationId: id(page), ref: ref(page, 'Why Acme\\?'), text: 'I build agents that act in real browsers, safely.' });
  const submitting = call('browser_click', { observationId: id(page), ref: ref(page, 'Submit application') });
  await approveWhenAsked();
  await submitting;
  await sleep(1800);
  ab('record', 'stop');
  await call('browser_disconnect');

  // Two-pass palette GIF: small, crisp, 12 fps.
  const palette = path.join(work, 'palette.png');
  const filters = 'fps=12,scale=820:-1:flags=lanczos';
  execFileSync('ffmpeg', ['-y', '-i', webm, '-vf', `${filters},palettegen=stats_mode=diff`, palette], { stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', webm, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, OUT_GIF], { stdio: 'ignore' });
  process.stdout.write(`wrote ${OUT_GIF}\n`);
} finally {
  await client.close();
  await server.close();
  site.close();
  await rm(work, { recursive: true, force: true });
}
