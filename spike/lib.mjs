// Shared helpers for the day-1 spike. Cross-platform (Linux, macOS, Windows).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(SPIKE_DIR, '..', 'test-fixtures');
export const OUT = path.join(SPIKE_DIR, 'out');

const require = createRequire(import.meta.url);
// Run the npm launcher with node directly: avoids .cmd shims on Windows.
export const AB_LAUNCHER = require.resolve('agent-browser/bin/agent-browser.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain' };

/** Serve fixtures on two loopback ports so the iframe is genuinely cross-origin. */
export const startFixtureServers = async () => {
  const servers = [8791, 8792].map((port) =>
    createServer(async (req, res) => {
      const name = path.basename(new URL(req.url ?? '/', 'http://x').pathname) || 'index.html';
      try {
        const body = await readFile(path.join(FIXTURES, name));
        res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    }),
  );
  await Promise.all(servers.map((s, i) => new Promise((ok) => s.listen([8791, 8792][i], '127.0.0.1', ok))));
  return () => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
};

/** Run one agent-browser command and return its parsed --json envelope. */
const execFileAsync = promisify(execFile);

// Async on purpose: the fixture servers live in this process, so a sync spawn would deadlock them.
export const ab = async (globalArgs, args, { env = {}, timeoutMs = 60_000 } = {}) => {
  const started = performance.now();
  let stdout = '';
  let ok = true;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [AB_LAUNCHER, ...globalArgs, '--json', ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    }));
  } catch (error) {
    ok = false;
    stdout = `${error.stdout ?? ''}`;
    if (!stdout) stdout = JSON.stringify({ success: false, error: `${error.stderr ?? error.message}`.trim() });
  }
  const ms = Math.round(performance.now() - started);
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}';
  try {
    return { ms, ok, ...JSON.parse(line) };
  } catch {
    return { ms, ok: false, success: false, error: stdout.trim() };
  }
};

/** Find the first ref whose role and accessible name match. */
export const findRef = (snapshotEnvelope, role, nameIncludes) => {
  const refs = snapshotEnvelope?.data?.refs ?? {};
  for (const [ref, info] of Object.entries(refs)) {
    if (info.role === role && `${info.name ?? ''}`.includes(nameIncludes)) return `@${ref}`;
  }
  return null;
};

/**
 * Find a ref by parsing the rendered tree. Needed because agent-browser 0.38.2's JSON
 * `refs` map has an empty name for cursor-interactive (role-less) elements.
 */
export const findRefInTree = (tree, nameIncludes) => {
  for (const line of `${tree}`.split('\n')) {
    const m = line.match(/"([^"]*)"[^\n]*?ref=(e\d+)/);
    if (m && m[1].includes(nameIncludes)) return `@${m[2]}`;
  }
  return null;
};

/** Minimal newline-delimited JSON-RPC client for a stdio MCP server. */
export const startMcp = (args, env = {}) => {
  const child = spawn(process.execPath, [AB_LAUNCHER, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 60_000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params = {}) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { request, notify, close: () => child.kill() };
};
