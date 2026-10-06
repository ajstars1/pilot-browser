import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildOverlayScript,
  InteractionLease,
  overlayCall,
  parseOverlayDrain,
  parseSnapshotTree,
  type Action,
  type BrowserDriver,
  type BrowserError,
  type ConnectMode,
  type ControlState,
  type DriverCapabilities,
  type LeaseSnapshot,
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
  /**
   * Inject the overlay (cursor, status pill, Pause / Hand back / Stop) into the agent's tab.
   * Default true. Without it the user cannot take over and handoff is unavailable.
   */
  readonly overlay?: boolean;
  /** Pointer movement. `smooth` makes the overlay cursor glide. Default `smooth`. */
  readonly inputMode?: 'instant' | 'smooth' | 'human';
  readonly commandTimeoutMs?: number;
  /** Covers the user clicking Allow on the approval prompt. Default 90s. */
  readonly connectTimeoutMs?: number;
  /** How often to check the tab for the user taking over. Default 750ms. */
  readonly leasePollMs?: number;
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * BrowserDriver for Chromium browsers (Chrome, Brave, Edge), built on agent-browser.
 * Attach mode drives the user's running browser through its approval-mode endpoint and
 * only ever acts in a tab it opened itself (`--pin-tab`).
 *
 * Interaction lease: the in-page overlay reports the user's input and button presses; a
 * background poll applies them to an InteractionLease. While the user has control the agent
 * can neither act nor read the page, so whatever the user types (passwords, 2FA codes)
 * never reaches the model.
 */
export class AgentBrowserDriver implements BrowserDriver {
  readonly capabilities: DriverCapabilities;

  private readonly runner: AgentBrowserRunner;
  private readonly session: string;
  private readonly overlay: boolean;
  private readonly inputMode: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly leasePollMs: number;
  /** Authenticates calls into the in-page overlay; page scripts never see it. */
  private readonly token = randomUUID();
  private readonly lease = new InteractionLease();
  private globalArgs: readonly string[] = [];
  private mode: ConnectMode | null = null;
  private tabId = '';
  private latest: Latest | null = null;
  private overlayFile: string | null = null;
  private pendingStatus = '';
  private chain: Promise<unknown> = Promise.resolve();
  private busy = false;
  private poller: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AgentBrowserDriverOptions = {}) {
    this.runner = new AgentBrowserRunner(options.invocation ?? resolveAgentBrowser(), options.env);
    this.session = options.sessionName ?? `pilot-${randomUUID().slice(0, 8)}`;
    this.overlay = options.overlay ?? true;
    this.inputMode = options.inputMode ?? 'smooth';
    this.timeoutMs = options.commandTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 90_000;
    this.leasePollMs = options.leasePollMs ?? 750;
    this.capabilities = { a11yTree: true, multiClient: true, bindings: false, screencast: false, fileUpload: true, handoff: this.overlay };
  }

  get connected(): boolean {
    return this.mode !== null;
  }

  get sessionName(): string {
    return this.session;
  }

  /** One engine command at a time: agent actions and lease polls must never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private run(args: readonly string[], timeoutMs = this.timeoutMs): Promise<Envelope> {
    return this.runner.run(this.globalArgs, args, { timeoutMs });
  }

  async connect(mode: ConnectMode): Promise<Result<SessionInfo>> {
    return this.exclusive(async () => {
      if (this.mode) return engineError('Already connected; call disconnect() first.');
      const base = ['--session', this.session, '--input-mode', this.inputMode];
      if (this.overlay) {
        // agent-browser 0.38.2 registers init scripts from files at session start.
        this.overlayFile = path.join(os.tmpdir(), `pilot-overlay-${this.session}.js`);
        await writeFile(this.overlayFile, buildOverlayScript(this.token), { mode: 0o600 });
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
      if (this.overlay) this.schedulePoll();
      return { ok: true, value: { sessionId: this.session, browserVersion: version, tabId: this.tabId } };
    });
  }

  // ---------------------------------------------------------------- lease

  private schedulePoll(): void {
    this.poller = setTimeout(() => {
      // Skip a beat rather than queue behind a long action; the action polls for itself.
      const tick = this.busy ? Promise.resolve() : this.exclusive(() => this.pollLocked());
      void tick.finally(() => {
        if (this.mode) this.schedulePoll();
      });
    }, this.leasePollMs);
    this.poller.unref();
  }

  /** Drain overlay events into the lease, then make the page show the lease's state. */
  private async pollLocked(): Promise<void> {
    if (!this.mode || !this.overlay) return;
    const env = await this.run(['eval', overlayCall(this.token, 'drain')]);
    const drain = env.success ? parseOverlayDrain(env.data.result) : null;
    // No overlay in this document yet (or a page we can't script): nothing to learn.
    if (!drain) return;
    // Any change of control means the page may have changed under the agent: forget its refs.
    if (this.lease.apply(drain.events)) this.latest = null;
    const { state, message } = this.lease.snapshot();
    if (state !== 'agent' && state !== drain.mode) {
      // A navigation reset the overlay; show the user's control again.
      await this.run(['eval', overlayCall(this.token, 'setMode', state, message)]);
    }
  }

  private gate(): BrowserError | null {
    const { state, message } = this.lease.snapshot();
    switch (state) {
      case 'agent':
        return null;
      case 'stopped':
        return { code: 'user_stopped', message: 'The user pressed Stop in the browser. Do not continue this task.', retryable: false };
      case 'handoff':
        return { code: 'user_control', message: `Waiting for the user to finish: ${message}`, retryable: true };
      case 'user':
        return {
          code: 'user_control',
          message: 'The user has taken control of the tab (they clicked or typed in it, or pressed Pause). Wait until they hand it back.',
          retryable: true,
        };
    }
  }

  async control(): Promise<LeaseSnapshot> {
    return this.exclusive(async () => {
      await this.pollLocked();
      return this.lease.snapshot();
    });
  }

  async requestHandoff(message: string): Promise<Result<LeaseSnapshot>> {
    if (!this.overlay) return engineError('Handoff needs the in-page overlay, which is disabled for this driver.');
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      if (!this.lease.requestHandoff(message)) return fail(this.gate() ?? { code: 'user_stopped', message: 'Stopped.', retryable: false });
      await this.run(['eval', overlayCall(this.token, 'setMode', 'handoff', message)]);
      await this.run(['tab', this.tabId]);
      this.latest = null;
      return { ok: true, value: this.lease.snapshot() };
    });
  }

  async waitForUser(timeoutMs: number, onTick?: (elapsedMs: number) => void): Promise<ControlState> {
    const started = Date.now();
    for (;;) {
      const { state } = await this.control();
      if (state === 'agent' || state === 'stopped') {
        // Whatever the user did, the agent must look again before acting.
        this.latest = null;
        return state;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) return state;
      onTick?.(elapsed);
      await sleep(Math.min(this.leasePollMs, timeoutMs - elapsed));
    }
  }

  // ------------------------------------------------------------ observing

  async observe(options: ObserveOptions = {}): Promise<Result<Observation>> {
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      const blocked = this.gate();
      if (blocked) return fail(blocked);
      return this.observeLocked(options);
    });
  }

  private async observeLocked(options: ObserveOptions = {}): Promise<Result<Observation>> {
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

  // --------------------------------------------------------------- acting

  async act(observationId: string, action: Action): Promise<Result<Observation>> {
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      const blocked = this.gate();
      if (blocked) return fail(blocked);
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

      // Bracket the action in an agent-input window so the overlay can tell it from the user's input.
      const status = this.pendingStatus;
      this.pendingStatus = '';
      const begin = this.overlay ? [['eval', overlayCall(this.token, 'begin', status)]] : [];
      const end = this.overlay ? [['eval', overlayCall(this.token, 'end')]] : [];
      const entries = await this.runner.batch(this.globalArgs, [...begin, ...commands.value, ...end], { timeoutMs: this.timeoutMs, bail: true });
      if (!Array.isArray(entries)) return envelopeError(entries);
      const failed = entries.find((e) => e.error !== null);
      if (failed) {
        if (this.overlay) await this.run(['eval', overlayCall(this.token, 'end')]);
        return fail(toBrowserError(failed.error));
      }
      return this.observeLocked();
    });
  }

  private withNormalizedRefs(action: Action): Result<Action> {
    const bad = (ref: string): Result<Action> => fail({ code: 'not_found', message: `"${ref}" is not a ref like e12.`, retryable: false });
    switch (action.type) {
      case 'click': {
        if (!('ref' in action.target)) return { ok: true, value: action };
        const ref = normalizeRef(action.target.ref);
        return ref ? { ok: true, value: { ...action, target: { ref } } } : bad(action.target.ref);
      }
      case 'type':
      case 'select':
      case 'check':
      case 'upload': {
        const ref = normalizeRef(action.ref);
        return ref ? { ok: true, value: { ...action, ref } } : bad(action.ref);
      }
      default:
        return { ok: true, value: action };
    }
  }

  /** Text for the overlay's status pill, shown with the next action. */
  async setStatus(text: string): Promise<void> {
    this.pendingStatus = text;
  }

  async screenshot(options: { readonly annotate?: boolean } = {}): Promise<Result<{ readonly png: Uint8Array; readonly width: number; readonly height: number }>> {
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      const blocked = this.gate();
      if (blocked) return fail(blocked);
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
    });
  }

  /**
   * @internal Test hook: where the overlay's buttons are, in viewport pixels, so tests can
   * press them as the user would (outside any agent-input window).
   */
  async overlayLayout(): Promise<{ readonly mode: string; readonly buttons: Readonly<Record<string, { x: number; y: number }>> } | null> {
    return this.exclusive(async () => {
      const env = await this.run(['eval', overlayCall(this.token, 'layout')]);
      const raw = env.success ? env.data.result : null;
      return typeof raw === 'string' ? (JSON.parse(raw) as { mode: string; buttons: Record<string, { x: number; y: number }> }) : null;
    });
  }

  async disconnect(): Promise<void> {
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    await this.exclusive(async () => {
      if (!this.mode) return;
      // Attach: close only the agent's own tab, then detach. agent-browser never closes an attached browser.
      if (this.mode.kind === 'attach') await this.run(['tab', 'close']);
      await this.run(['close']);
      this.mode = null;
      this.latest = null;
      this.globalArgs = [];
      this.tabId = '';
      await this.removeOverlayFile();
    });
  }

  private async removeOverlayFile(): Promise<void> {
    if (this.overlayFile) await rm(this.overlayFile, { force: true });
    this.overlayFile = null;
  }
}
