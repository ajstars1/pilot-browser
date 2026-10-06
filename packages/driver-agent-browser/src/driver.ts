import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OVERLAY_SCRIPT,
  overlayStatusExpression,
  parseSnapshotTree,
  type Action,
  type BrowserDriver,
  type BrowserError,
  type ConnectMode,
  type DriverCapabilities,
  type Observation,
  type ObserveOptions,
  type RefLine,
  type Result,
  type SessionInfo,
} from '@pilot-browser/core';
import { resolveAgentBrowser, type Invocation } from './binary.js';
import { actionToCommands, dependsOnObservation, normalizeRef, refsOf } from './commands.js';
import { toBrowserError } from './errors.js';
import { pngSize } from './png.js';
import { AgentBrowserRunner, type BatchEntry, type Envelope } from './runner.js';
import { clipToViewport, type Box } from './viewport.js';

export interface AgentBrowserDriverOptions {
  /** How to run agent-browser. Defaults to the native binary shipped in the npm package. */
  readonly invocation?: Invocation;
  /** agent-browser session name; one daemon and one browser connection per session. */
  readonly sessionName?: string;
  /** Inject the live cursor overlay into the agent's tab. Default true. */
  readonly overlay?: boolean;
  /** Pointer movement. `smooth` makes the overlay cursor glide. Default `smooth`. */
  readonly inputMode?: 'instant' | 'smooth' | 'human';
  readonly commandTimeoutMs?: number;
  /** Covers the user clicking Allow on the approval prompt. Default 90s. */
  readonly connectTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

interface Latest {
  readonly observation: Observation;
  readonly refs: ReadonlyMap<string, RefLine>;
}

const fail = <T>(error: BrowserError): Result<T> => ({ ok: false, error });
const engineError = <T>(message: string): Result<T> => fail({ code: 'engine_error', message, retryable: false });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const envelopeError = <T>(env: Envelope): Result<T> => fail(toBrowserError(env.error, env.code));

/**
 * BrowserDriver for Chromium browsers (Chrome, Brave, Edge), built on agent-browser.
 * Attach mode drives the user's running browser through its approval-mode endpoint and
 * only ever acts in a tab it opened itself (`--pin-tab`).
 */
export class AgentBrowserDriver implements BrowserDriver {
  readonly capabilities: DriverCapabilities = {
    a11yTree: true,
    multiClient: true,
    bindings: false,
    screencast: false,
    fileUpload: true,
  };

  private readonly runner: AgentBrowserRunner;
  private readonly session: string;
  private readonly overlay: boolean;
  private readonly inputMode: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private globalArgs: readonly string[] = [];
  private mode: ConnectMode | null = null;
  private tabId = '';
  private latest: Latest | null = null;
  private overlayFile: string | null = null;

  constructor(options: AgentBrowserDriverOptions = {}) {
    this.runner = new AgentBrowserRunner(options.invocation ?? resolveAgentBrowser(), options.env);
    this.session = options.sessionName ?? `pilot-${randomUUID().slice(0, 8)}`;
    this.overlay = options.overlay ?? true;
    this.inputMode = options.inputMode ?? 'smooth';
    this.timeoutMs = options.commandTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 90_000;
  }

  get connected(): boolean {
    return this.mode !== null;
  }

  get sessionName(): string {
    return this.session;
  }

  private run(args: readonly string[], timeoutMs = this.timeoutMs): Promise<Envelope> {
    return this.runner.run(this.globalArgs, args, { timeoutMs });
  }

  async connect(mode: ConnectMode): Promise<Result<SessionInfo>> {
    if (this.mode) return engineError('Already connected; call disconnect() first.');
    const base = ['--session', this.session, '--input-mode', this.inputMode];
    if (this.overlay) {
      // agent-browser 0.38.2 registers init scripts from files at session start.
      this.overlayFile = path.join(os.tmpdir(), `pilot-overlay-${this.session}.js`);
      await writeFile(this.overlayFile, OVERLAY_SCRIPT);
      base.push('--init-script', this.overlayFile);
    }
    if (mode.kind === 'attach') {
      if (mode.endpoint.engine !== 'chromium') return engineError(`agent-browser drives Chromium browsers only, not ${mode.endpoint.engine}.`);
      this.globalArgs = [...base, '--cdp', mode.endpoint.wsUrl, '--pin-tab'];
    } else {
      this.globalArgs = [
        ...base,
        '--profile',
        mode.profileDir,
        ...(mode.headless ? [] : ['--headed']),
        ...(mode.executablePath ? ['--executable-path', mode.executablePath] : []),
      ];
    }

    // With --pin-tab the first attach opens a fresh tab instead of adopting one of the user's.
    const opened = await this.run(['open', 'about:blank'], this.connectTimeoutMs);
    if (!opened.success) {
      this.globalArgs = [];
      await this.removeOverlayFile();
      return envelopeError(opened);
    }
    this.mode = mode;
    this.tabId = str(opened.data.targetId);

    const ua = await this.run(['eval', 'navigator.userAgent']);
    const userAgent = str(ua.data.result);
    const version = /(?:Chrome|Edg|HeadlessChrome)\/[\d.]+/.exec(userAgent)?.[0] ?? userAgent;
    return { ok: true, value: { sessionId: this.session, browserVersion: version, tabId: this.tabId } };
  }

  async observe(options: ObserveOptions = {}): Promise<Result<Observation>> {
    if (!this.mode) return engineError('Not connected.');
    const filter = options.filter ?? 'visible';
    const page = await this.runner.batch(
      this.globalArgs,
      [['get', 'url'], ['get', 'title'], filter === 'all' ? ['snapshot'] : ['snapshot', '-i'], ['eval', '[innerWidth, innerHeight]']],
      { timeoutMs: this.timeoutMs },
    );
    if (!Array.isArray(page)) return envelopeError(page);
    const failed = page.find((e) => e.error !== null);
    if (failed) return fail(toBrowserError(failed.error));
    const [urlEntry, titleEntry, snapEntry, vpEntry] = page as [BatchEntry, BatchEntry, BatchEntry, BatchEntry];

    const url = str(urlEntry.result.url);
    const fullTree = str(snapEntry.result.snapshot);
    const lines = parseSnapshotTree(fullTree);
    let tree = fullTree;
    let shown: readonly RefLine[] = lines;

    if (filter === 'visible' && lines.length > 0) {
      const boxes = await this.runner.batch(this.globalArgs, lines.map((l) => ['get', 'box', `@${l.ref}`]), { timeoutMs: this.timeoutMs });
      if (!Array.isArray(boxes)) return envelopeError(boxes);
      const boxMap = new Map<string, Box>();
      boxes.forEach((entry, i) => {
        const ref = lines[i]?.ref;
        if (ref && entry.error === null) {
          const r = entry.result;
          boxMap.set(ref, { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) });
        }
      });
      const [width = 0, height = 0] = Array.isArray(vpEntry.result.result) ? vpEntry.result.result.map(num) : [];
      const clipped = clipToViewport(lines, boxMap, { width, height });
      tree = clipped.tree;
      shown = clipped.visible;
    }

    let omitted = lines.length - shown.length;
    if (options.maxChars !== undefined && tree.length > options.maxChars) {
      const kept = tree.slice(0, options.maxChars);
      const cut = kept.lastIndexOf('\n');
      tree = cut > 0 ? kept.slice(0, cut) : kept;
      omitted = lines.length - parseSnapshotTree(tree).length;
    }

    const observationId = createHash('sha256').update(`${this.tabId}\n${url}\n${fullTree}`).digest('hex').slice(0, 12);
    const observation: Observation = { observationId, url, title: str(titleEntry.result.title), tree, refs: shown, omitted };
    this.latest = { observation, refs: new Map(lines.map((l) => [l.ref, l])) };
    return { ok: true, value: observation };
  }

  async act(observationId: string, action: Action): Promise<Result<Observation>> {
    if (!this.mode) return engineError('Not connected.');
    if (dependsOnObservation(action)) {
      if (!this.latest || this.latest.observation.observationId !== observationId) {
        return fail({ code: 'stale_ref', message: 'This observation is out of date; call read_page and use the new observationId.', retryable: true });
      }
    }
    const normalized = this.withNormalizedRefs(action);
    if (!normalized.ok) return normalized;
    for (const ref of refsOf(normalized.value)) {
      if (!this.latest?.refs.has(ref.slice(1))) {
        return fail({ code: 'not_found', message: `Ref ${ref.slice(1)} is not in the latest observation.`, retryable: false });
      }
    }

    const commands = actionToCommands(normalized.value);
    if (!commands.ok) return commands;
    const [single, ...rest] = commands.value;
    if (single && rest.length === 0) {
      const env = await this.run(single);
      if (!env.success) return envelopeError(env);
    } else {
      const entries = await this.runner.batch(this.globalArgs, commands.value, { timeoutMs: this.timeoutMs, bail: true });
      if (!Array.isArray(entries)) return envelopeError(entries);
      const failed = entries.find((e) => e.error !== null);
      if (failed) return fail(toBrowserError(failed.error));
    }
    return this.observe();
  }

  private withNormalizedRefs(action: Action): Result<Action> {
    const fix = (ref: string): string | null => normalizeRef(ref);
    const bad = (ref: string): Result<Action> => fail({ code: 'not_found', message: `"${ref}" is not a ref like e12.`, retryable: false });
    switch (action.type) {
      case 'click': {
        if (!('ref' in action.target)) return { ok: true, value: action };
        const ref = fix(action.target.ref);
        return ref ? { ok: true, value: { ...action, target: { ref } } } : bad(action.target.ref);
      }
      case 'type':
      case 'select':
      case 'check':
      case 'upload': {
        const ref = fix(action.ref);
        return ref ? { ok: true, value: { ...action, ref } } : bad(action.ref);
      }
      default:
        return { ok: true, value: action };
    }
  }

  /** Update the overlay's status pill (no-op when the overlay is off). */
  async setStatus(text: string): Promise<void> {
    if (this.mode && this.overlay) await this.run(['eval', overlayStatusExpression(text)]);
  }

  async screenshot(options: { readonly annotate?: boolean } = {}): Promise<Result<{ readonly png: Uint8Array; readonly width: number; readonly height: number }>> {
    if (!this.mode) return engineError('Not connected.');
    const file = path.join(os.tmpdir(), `pilot-shot-${randomUUID()}.png`);
    try {
      const env = await this.run(['screenshot', file, ...(options.annotate ? ['--annotate'] : [])]);
      if (!env.success) return envelopeError(env);
      const png = new Uint8Array(await readFile(file));
      const size = pngSize(png);
      if (!size) return engineError('Screenshot was not a PNG.');
      return { ok: true, value: { png, ...size } };
    } finally {
      await rm(file, { force: true });
    }
  }

  async disconnect(): Promise<void> {
    if (!this.mode) return;
    // Attach: close only the agent's own tab, then detach. agent-browser never closes an attached browser.
    if (this.mode.kind === 'attach') await this.run(['tab', 'close']);
    await this.run(['close']);
    this.mode = null;
    this.latest = null;
    this.globalArgs = [];
    this.tabId = '';
    await this.removeOverlayFile();
  }

  private async removeOverlayFile(): Promise<void> {
    if (this.overlayFile) await rm(this.overlayFile, { force: true });
    this.overlayFile = null;
  }
}

