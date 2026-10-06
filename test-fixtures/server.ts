import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain', '.js': 'text/javascript' };

/** A request that reached the "attacker" origin. */
export interface Hit {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });

const serveFile = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = path.join(FIXTURES_DIR, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(FIXTURES_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // Unknown paths (e.g. an attacker's /steal endpoint) still answer, so navigations complete.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>ok</title><p>ok</p>');
  }
};

const listen = (server: Server, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });

const close = (server: Server): Promise<void> => new Promise((ok) => server.close(() => ok()));

export interface FixtureServer {
  /** The site under test: http://127.0.0.1:<port>. */
  readonly base: string;
  /** A different site (http://localhost:<port+1>) that plays the attacker and records hits. */
  readonly attacker: string;
  /** Requests the attacker origin received, excluding fixture files it serves. */
  readonly hits: Hit[];
  readonly close: () => Promise<void>;
}

/**
 * Serve the fixtures on two consecutive loopback ports. index.html loads its iframe from
 * `localhost:<port+1>`, a different site from `127.0.0.1:<port>`, so the frame is a real
 * out-of-process iframe; the same second origin doubles as the injection suite's attacker.
 * Ports are random so parallel test files never collide.
 */
export const startFixtureServer = async (): Promise<FixtureServer> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000) * 2;
    const hits: Hit[] = [];
    const main = createServer((req, res) => void serveFile(req, res));
    const attacker = createServer((req, res) => {
      void readBody(req).then((body) => {
        const url = req.url ?? '/';
        const isFixtureFile = url.startsWith('/frame.html') || url === '/favicon.ico' || /^\/injection\/[\w-]+\.(html|js)$/.test(url);
        if (!isFixtureFile) hits.push({ method: req.method ?? 'GET', url, body });
        void serveFile(req, res);
      });
    });
    if (!(await listen(main, port))) continue;
    if (!(await listen(attacker, port + 1))) {
      await close(main);
      continue;
    }
    return {
      base: `http://127.0.0.1:${port}`,
      attacker: `http://localhost:${port + 1}`,
      hits,
      close: () => Promise.all([close(main), close(attacker)]).then(() => undefined),
    };
  }
  throw new Error('could not find two free consecutive ports');
};
