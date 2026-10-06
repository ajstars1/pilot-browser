// Day-1 spike, part 1: managed browser (throwaway profile, never your real one).
// Verifies the agent-browser engine against controlled fixtures and records results.
// Usage: node spike/run-managed.mjs   (set PILOT_CHROME to a Chrome/Brave binary to override)
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ab, findRef, findRefInTree, startFixtureServers, startMcp, FIXTURES, OUT, SPIKE_DIR } from './lib.mjs';

const BASE = 'http://127.0.0.1:8791/index.html';
const session = 'pb-spike-managed';
const exe = process.env.PILOT_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const g = ['--session', session, '--input-mode', 'smooth', ...(exe ? ['--executable-path', exe] : [])];
const results = [];

const check = (name, pass, detail, ms) => {
  results.push({ name, pass, detail, ms });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}\n`);
};
const text = (env) => `${env?.data?.text ?? env?.data?.result ?? env?.data ?? ''}`;

await mkdir(OUT, { recursive: true });
const stopServers = await startFixtureServers();
try {
  const overlay = await readFile(path.join(SPIKE_DIR, 'overlay', 'cursor.js'), 'utf8');

  const open = await ab([...g, '--init-script', path.join(SPIKE_DIR, 'overlay', 'cursor.js')], ['open', BASE]);
  check('launch + open fixture', open.success === true, open.error ?? '', open.ms);

  const snap = await ab(g, ['snapshot', '-i']);
  const snapText = `${snap.data?.snapshot ?? ''}`;
  check('interactive snapshot', snap.success === true, `${snapText.length} chars, ${Object.keys(snap.data?.refs ?? {}).length} refs`, snap.ms);
  await writeFile(path.join(OUT, 'snapshot-interactive.txt'), snapText);

  // 1. Trusted click
  const go = findRef(snap, 'button', 'Go');
  await ab(g, ['click', go]);
  const t1 = await ab(g, ['get', 'text', '#trusted-out']);
  check('trusted click (isTrusted)', text(t1).includes('trusted=true'), text(t1), t1.ms);

  // 2. Role-less clickable div gets a ref
  const jsonName = snap.data?.refs?.[`${findRefInTree(snapText, 'Save draft') ?? ''}`.slice(1)]?.name;
  const divRef = findRefInTree(snapText, 'Save draft');
  if (divRef) await ab(g, ['click', divRef]);
  const t2 = await ab(g, ['get', 'text', '#div-out']);
  check('role-less <div onclick> discovered + clicked', !!divRef && text(t2).includes('trusted=true'), `ref=${divRef ?? 'none'} ${text(t2)} (JSON refs map name=${JSON.stringify(jsonName)})`);

  // 3. File upload
  const fileRef = findRef(snap, 'button', 'Resume') ?? '#file';
  await ab(g, ['upload', fileRef, path.join(FIXTURES, 'resume.txt')]);
  const t3 = await ab(g, ['get', 'text', '#file-out']);
  check('file upload (DOM.setFileInputFiles)', text(t3).includes('resume.txt'), text(t3));

  // 4. Native select
  const selRef = findRef(snap, 'combobox', 'Country') ?? '#country';
  await ab(g, ['select', selRef, 'India']);
  const t4 = await ab(g, ['get', 'text', '#select-out']);
  check('native <select>', text(t4).includes('country=in'), text(t4));

  // 5. Cross-origin iframe fill + click
  const email = findRef(snap, 'textbox', 'Email');
  const inner = findRef(snap, 'button', 'Inner');
  await ab(g, ['fill', email, 'agent@example.com']);
  await ab(g, ['click', inner]);
  const snap2 = await ab(g, ['snapshot', '-i']);
  const iframeOk = `${snap2.data?.snapshot ?? ''}`.includes('frame-clicked trusted=true email=agent@example.com');
  check('cross-origin iframe fill + click', iframeOk, iframeOk ? 'inner button updated' : `${snap2.data?.snapshot ?? snap2.error}`.slice(0, 200));

  // 6. confirm() dialog is surfaced, not silently accepted
  const danger = findRef(snap, 'button', 'Delete account');
  await ab(g, ['click', danger], { timeoutMs: 15_000 });
  const ds = await ab(g, ['dialog', 'status']);
  const dialogOpen = JSON.stringify(ds.data ?? {}).includes('confirm');
  await ab(g, ['dialog', 'dismiss']);
  const t6 = await ab(g, ['get', 'text', '#dialog-out']);
  check('confirm() surfaced, then dismissed', dialogOpen && text(t6).includes('confirm=false'), `status=${JSON.stringify(ds.data ?? ds.error)} result=${text(t6)}`);

  // 7. Overlay: present in pixels, absent from the accessibility snapshot
  const overlayInSnapshot = snapText.toLowerCase().includes('pilot-browser');
  const shot = path.join(OUT, 'overlay.png');
  await ab(g, ['click', go]);
  await ab(g, ['screenshot', shot]);
  check('cursor overlay hidden from snapshot', !overlayInSnapshot, overlayInSnapshot ? 'LEAKED into snapshot' : 'not in a11y tree');
  check('cursor overlay screenshot written', existsSync(shot), shot);

  // 8. Hidden prompt-injection text: is it in what the model would read?
  const full = await ab(g, ['snapshot']);
  const injectionVisible = `${full.data?.snapshot ?? ''}`.includes('ignore all previous instructions');
  check('hidden injection text reaches model (expected: true -> policy layer needed)', true, `in full snapshot: ${injectionVisible}`);

  // 9. Delta snapshot size after a no-op
  const baseline = await ab(g, ['snapshot', '-i', '--delta']);
  const delta = await ab(g, ['snapshot', '-i', '--delta']);
  check('delta snapshot (2nd call, no change)', delta.success === true, `baseline ${`${baseline.data?.snapshot ?? ''}`.length} chars -> delta ${JSON.stringify(delta.data?.snapshot ?? '').length} chars`);

  // 10. Viewport clipping need: refs total vs refs actually in the viewport
  const vp = await ab(g, ['eval', `(() => { const h = innerHeight; const els = [...document.querySelectorAll('a,button,input,select,[onclick]')]; return { total: els.length, inViewport: els.filter(e => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < h; }).length }; })()`]);
  check('viewport clipping opportunity', vp.success === true, `snapshot refs=${Object.keys(snap.data?.refs ?? {}).length}, DOM interactive in viewport=${JSON.stringify(vp.data?.result ?? vp.data)}`);

  await ab(g, ['close']);

  // 11. MCP server smoke test (the zero-code integration path)
  const mcp = startMcp(['mcp', '--tools', 'core'], exe ? { AGENT_BROWSER_EXECUTABLE_PATH: exe } : {});
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pilot-spike', version: '0.0.0' } });
    mcp.notify('notifications/initialized');
    const list = await mcp.request('tools/list');
    const tools = list.result?.tools ?? [];
    const openCall = await mcp.request('tools/call', { name: 'agent_browser_open', arguments: { url: BASE, session: 'pb-spike-mcp' } });
    const snapCall = await mcp.request('tools/call', { name: 'agent_browser_snapshot', arguments: { session: 'pb-spike-mcp', interactive: true } });
    const snapOut = JSON.stringify(snapCall.result ?? snapCall.error ?? {});
    await mcp.request('tools/call', { name: 'agent_browser_close', arguments: { session: 'pb-spike-mcp' } });
    check('MCP: initialize + tools/list', !!init.result && tools.length > 0, `${init.result?.serverInfo?.name} protocol=${init.result?.protocolVersion} tools=${tools.length}`);
    check('MCP: open + snapshot via tools/call', !openCall.error && snapOut.includes('Delete account'), snapOut.slice(0, 160));
  } finally {
    mcp.close();
  }
} finally {
  await ab(['--session', session], ['close']);
  await stopServers();
  const report = { when: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, browser: exe ?? 'agent-browser default', results };
  await writeFile(path.join(OUT, 'managed-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const failed = results.filter((r) => !r.pass).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} passed. Results: spike/out/managed-results.json\n`);
  process.exitCode = failed ? 1 : 0;
}
