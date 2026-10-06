import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain' };

const serve = (req: IncomingMessage, res: ServerResponse): void => {
  const name = path.basename(new URL(req.url ?? '/', 'http://x').pathname) || 'index.html';
  readFile(path.join(FIXTURES_DIR, name)).then(
    (body) => {
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
      res.end(body);
    },
    () => res.writeHead(404).end(),
  );
};

const handler = (): Server => createServer(serve);

const listen = (server: Server, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });

const close = (server: Server): Promise<void> => new Promise((ok) => server.close(() => ok()));

/**
 * Serve the fixtures on two consecutive loopback ports. index.html loads its iframe from
 * `localhost:<port+1>`, a different site from `127.0.0.1:<port>`, so the frame is a real
 * out-of-process iframe. Ports are random so parallel test files never collide.
 */
export const startFixtureServer = async (): Promise<{ readonly base: string; readonly close: () => Promise<void> }> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 20_000) * 2;
    const main = handler();
    const frame = handler();
    if (!(await listen(main, port))) continue;
    if (!(await listen(frame, port + 1))) {
      await close(main);
      continue;
    }
    return { base: `http://127.0.0.1:${port}`, close: () => Promise.all([close(main), close(frame)]).then(() => undefined) };
  }
  throw new Error('could not find two free consecutive ports');
};
