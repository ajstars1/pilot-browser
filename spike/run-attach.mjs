// Day-1 spike, part 2: attach to YOUR running browser via Chrome 144+ approval mode.
// Prereq: open the browser normally, visit chrome://inspect/#remote-debugging (brave://inspect, edge://inspect)
// and tick "Allow remote debugging for this browser instance". Then run this and click Allow when prompted.
// The agent only works in a tab it opens itself, and only on local fixtures unless --real-site is given.
// Usage: node spike/run-attach.mjs [chrome|brave|edge] [--real-site https://github.com/notifications]
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ab, findRef, startFixtureServers, FIXTURES, OUT } from './lib.mjs';

const browser = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chrome';
const realSiteIdx = process.argv.indexOf('--real-site');
const realSite = realSiteIdx > 0 ? process.argv[realSiteIdx + 1] : null;

const home = os.homedir();
const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
const mac = path.join(home, 'Library', 'Application Support');
const USER_DATA = {
  linux: { chrome: '.config/google-chrome', brave: '.config/BraveSoftware/Brave-Browser', edge: '.config/microsoft-edge' },
  darwin: { chrome: `${mac}/Google/Chrome`, brave: `${mac}/BraveSoftware/Brave-Browser`, edge: `${mac}/Microsoft Edge` },
  win32: { chrome: `${local}\\Google\\Chrome\\User Data`, brave: `${local}\\BraveSoftware\\Brave-Browser\\User Data`, edge: `${local}\\Microsoft\\Edge\\User Data` },
};
const rel = USER_DATA[process.platform]?.[browser];
if (!rel) throw new Error(`unsupported platform/browser: ${process.platform}/${browser}`);
const userDataDir = path.isAbsolute(rel) ? rel : path.join(home, rel);
const portFile = path.join(userDataDir, 'DevToolsActivePort');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}\n`);
};
const text = (env) => `${env?.data?.text ?? env?.data ?? ''}`;

let wsUrl;
try {
  const [port, wsPath] = (await readFile(portFile, 'utf8')).trim().split('\n');
  wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
  check('approval-mode endpoint discovered', true, `${portFile} -> port ${port}`);
} catch {
  check('approval-mode endpoint discovered', false, `${portFile} missing: enable ${browser}://inspect/#remote-debugging first`);
  process.exit(1);
}

const session = `pb-spike-attach-${browser}`;
const g = ['--session', session, '--cdp', wsUrl, '--pin-tab', '--input-mode', 'smooth'];
await mkdir(OUT, { recursive: true });
const stopServers = await startFixtureServers();
try {
  process.stdout.write(`\n>>> Connecting. Click "Allow" in ${browser} when the remote-debugging dialog appears (you have ~60s).\n\n`);
  const t0 = performance.now();
  const open = await ab(g, ['open', 'http://127.0.0.1:8791/index.html'], { timeoutMs: 90_000 });
  check('attach + open fixture in a NEW tab', open.success === true, `${Math.round((performance.now() - t0) / 1000)}s incl. approval ${open.error ?? ''}`);
  if (!open.success) process.exit(1);

  const snap = await ab(g, ['snapshot', '-i']);
  check('snapshot in real browser', snap.success === true, `${Object.keys(snap.data?.refs ?? {}).length} refs`);

  await ab(g, ['click', findRef(snap, 'button', 'Go')]);
  const t1 = await ab(g, ['get', 'text', '#trusted-out']);
  check('trusted click in real browser', text(t1).includes('trusted=true'), text(t1));

  await ab(g, ['upload', findRef(snap, 'button', 'Resume') ?? '#file', path.join(FIXTURES, 'resume.txt')]);
  const t2 = await ab(g, ['get', 'text', '#file-out']);
  check('file upload in real browser', text(t2).includes('resume.txt'), text(t2));

  await ab(g, ['fill', findRef(snap, 'textbox', 'Email'), 'agent@example.com']);
  await ab(g, ['click', findRef(snap, 'button', 'Inner')]);
  const s2 = await ab(g, ['snapshot', '-i']);
  check('cross-origin iframe in real browser', `${s2.data?.snapshot ?? ''}`.includes('trusted=true email=agent@example.com'));

  const t3 = performance.now();
  const again = await ab(g, ['get', 'url']);
  check('later commands reuse the connection (no new prompt)', again.success === true, `${Math.round(performance.now() - t3)}ms`);

  if (realSite) {
    // Read-only: proves your existing login carries over. Only counts are printed, never page content.
    await ab(g, ['open', realSite], { timeoutMs: 60_000 });
    const real = await ab(g, ['snapshot', '-i']);
    const tree = `${real.data?.snapshot ?? ''}`;
    const loggedOut = /\b(Sign in|Log in)\b/i.test(tree.slice(0, 3000));
    check('real site uses your existing login', real.success === true && !loggedOut, `${new URL(realSite).host}: ${Object.keys(real.data?.refs ?? {}).length} refs, sign-in prompt visible=${loggedOut}`);
  }

  await ab(g, ['tab', 'close']);
  const closed = await ab(['--session', session], ['close']);
  await new Promise((r) => setTimeout(r, 1000));
  const browserStillUp = await stat(portFile).then(() => true, () => false);
  check('close = detach only (your browser stays open)', closed.success === true && browserStillUp, `DevToolsActivePort still present=${browserStillUp}`);
} finally {
  await ab(['--session', session], ['close']);
  await stopServers();
  const report = { when: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, browser, results };
  await writeFile(path.join(OUT, `attach-${browser}-results.json`), `${JSON.stringify(report, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed. Results: spike/out/attach-${browser}-results.json\n`);
}
