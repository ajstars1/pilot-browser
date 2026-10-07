import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildOverlayScript,
  CAPTCHA_PROBE,
  InteractionLease,
  overlayCall,
  parseCaptcha,
  parseOverlayDrain,
  parseSnapshotTree,
  parseTargetFacts,
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
  type TargetFacts,
} from '@pilot-browser/core';
import { resolveAgentBrowser, type Invocation } from './binary.js';
import { actionToCommands, dependsOnObservation, normalizeRef, refsOf } from './commands.js';
import { toBrowserError } from './errors.js';
import { pngSize } from './png.js';
import { browsersForProfile, daemonPid, daemonSessions, isAlive, listProcesses, terminate } from './process.js';
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
  /**
   * Whether clicking or typing in the tab takes control from the agent. Default true. Turn it
   * off for unattended runs, where any input is the page's own doing; the overlay's Pause,
   * Hand back and Stop buttons still work.
   */
  readonly inputTakeover?: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

interface Latest {
  readonly observation: Observation;
  readonly refs: ReadonlyMap<string, RefLine>;
  readonly options: ObserveOptions;
}

const fail = <T>(error: BrowserError): Result<T> => ({ ok: false, error });
const engineError = <T>(message: string): Result<T> => fail({ code: 'engine_error', message, retryable: false });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const envelopeError = <T>(env: Envelope): Result<T> => fail(toBrowserError(env.error, env.code));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HUNG: BrowserError = {
  code: 'engine_error',
  message:
    'The browser stopped responding, so pilot-browser closed it. Anything not yet submitted is lost. Call browser_disconnect, then browser_connect to start again.',
  retryable: false,
};

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
  private readonly env: NodeJS.ProcessEnv;
  private readonly session: string;
  private readonly overlay: boolean;
  private readonly inputMode: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly leasePollMs: number;
  /** Authenticates calls into the in-page overlay; page scripts never see it. */
  private readonly token = randomUUID();
  private readonly lease: InteractionLease;
  private globalArgs: readonly string[] = [];
  private mode: ConnectMode | null = null;
  /** Managed mode: the profile this session's browser runs on, so a hung one can be found and closed. */
  private profileDir: string | null = null;
  private tabId = '';
  private latest: Latest | null = null;
  /** Options of the last observation, kept even when `latest` is invalidated, to re-read the same way. */
  private lastObserveOptions: ObserveOptions = {};
  private overlayFile: string | null = null;
  private pendingStatus = '';
  private chain: Promise<unknown> = Promise.resolve();
  private busy = false;
  private poller: ReturnType<typeof setTimeout> | null = null;
  /** An open alert/confirm/prompt blocks page scripts: eval and url reads hang until it's answered. */
  private dialog: { readonly type: string; readonly message: string } | null = null;

  constructor(options: AgentBrowserDriverOptions = {}) {
    this.runner = new AgentBrowserRunner(options.invocation ?? resolveAgentBrowser(), options.env);
    this.env = { ...process.env, ...options.env };
    this.session = options.sessionName ?? `pilot-${randomUUID().slice(0, 8)}`;
    this.overlay = options.overlay ?? true;
    this.inputMode = options.inputMode ?? 'smooth';
    this.timeoutMs = options.commandTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 90_000;
    this.leasePollMs = options.leasePollMs ?? 750;
    this.lease = new InteractionLease({ inputTakesControl: options.inputTakeover ?? true });
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
        const conflict = await this.reclaimProfile(mode.profileDir);
        if (conflict) {
          await this.removeOverlayFile();
          return engineError(conflict);
        }
        this.profileDir = mode.profileDir;
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
        // Stop the session's daemon too: left running, it would finish attaching after a late
        // Allow and leave an orphaned tab in the user's browser.
        await this.run(['close'], 5_000);
        await this.killSession();
        this.globalArgs = [];
        this.profileDir = null;
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

  // ------------------------------------------------------------ processes

  /**
   * A profile can be open in one browser only. A pilot-browser session that hung or died
   * leaves its browser (and often its daemon, which relaunches it) holding the profile, and
   * every later launch exits early. Close those leftovers; never touch a session that still
   * answers, or a browser pilot-browser didn't start.
   */
  private async reclaimProfile(profileDir: string): Promise<string | null> {
    const holders = browsersForProfile(await listProcesses(), profileDir);
    if (holders.length === 0) return null;
    const sessions = await daemonSessions(this.env);
    for (const holder of holders) {
      const owner = sessions.get(holder.ppid);
      if (owner !== undefined && isAlive(holder.ppid)) {
        const probe = await this.runner.run(['--session', owner], ['get', 'url'], { timeoutMs: 5_000 });
        if (probe.success) {
          return `The profile ${profileDir} is open in another pilot-browser session (${owner}). Disconnect that session first, or use a different profile.`;
        }
        await terminate([holder.ppid]);
      } else if (!/--remote-debugging-(port|pipe)/.test(holder.args)) {
        return `The profile ${profileDir} is open in a browser pilot-browser didn't start (pid ${holder.pid}). Close that browser, then retry.`;
      }
    }
    // Daemons first, so none relaunches a browser while it is being closed.
    await terminate(browsersForProfile(await listProcesses(), profileDir).map((b) => b.pid));
    return null;
  }

  /**
   * Last resort for a session that no longer answers: kill its daemon, then (managed mode
   * only) the browser it launched. An attached browser is the user's and is never touched.
   */
  private async killSession(): Promise<void> {
    const daemon = await daemonPid(this.session, this.env);
    if (daemon !== null && isAlive(daemon)) await terminate([daemon]);
    if (this.profileDir) await terminate(browsersForProfile(await listProcesses(), this.profileDir).map((b) => b.pid));
  }

  /**
   * agent-browser runs one command at a time, so a command that never returns blocks every
   * later one. After a timeout, check the session still answers; if it doesn't, close it so
   * its browser stops holding the profile, and say so plainly instead of timing out forever.
   */
  private async afterTimeoutLocked<T>(failure: Result<T>): Promise<Result<T>> {
    await this.checkDialogLocked();
    if (this.dialog) return failure;
    const probe = await this.run(['get', 'url'], 10_000);
    if (probe.success) return failure;
    await this.killSession();
    this.endLocked();
    return fail(HUNG);
  }

  private endLocked(): void {
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    this.mode = null;
    this.latest = null;
    this.globalArgs = [];
    this.tabId = '';
    this.profileDir = null;
    void this.removeOverlayFile();
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
    if (this.dialog) {
      await this.checkDialogLocked();
      if (this.dialog) return;
    }
    const env = await this.run(['eval', overlayCall(this.token, 'drain')], 4_000);
    if (!env.success && env.code === 'timeout') {
      // Most likely a dialog the page opened on its own.
      await this.checkDialogLocked();
      return;
    }
    if (!env.success) return;
    const drain = parseOverlayDrain(env.data.result);
    if (!drain) {
      // The page is scriptable but has no overlay: a document the init script didn't reach.
      // Install it now, so the user always has Pause / Hand back / Stop.
      if (env.data.result === null || env.data.result === undefined) await this.installOverlayLocked();
      return;
    }
    // Any change of control means the page may have changed under the agent: forget its refs.
    if (this.lease.apply(drain.events)) this.latest = null;
    const { state, message } = this.lease.snapshot();
    // The lease is the source of truth: a navigation resets the overlay, and ignored input
    // (unattended runs) may have flipped it; show the real state again.
    if (state !== drain.mode) await this.run(['eval', overlayCall(this.token, 'setMode', state, message)]);
  }

  private async installOverlayLocked(): Promise<void> {
    const installed = await this.run(['eval', `${buildOverlayScript(this.token)} true`], 4_000);
    if (!installed.success) return;
    const { state, message } = this.lease.snapshot();
    await this.run(['eval', overlayCall(this.token, 'setMode', state, message)], 4_000);
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
      case 'approval':
        return { code: 'needs_approval', message: `Waiting for the user to approve: ${message}`, retryable: true };
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

  async waitForUser(timeoutMs: number, onTick?: (elapsedMs: number) => void, signal?: AbortSignal): Promise<ControlState> {
    const started = Date.now();
    for (;;) {
      const { state } = await this.control();
      if (state === 'agent' || state === 'stopped') {
        // Whatever the user did, the agent must look again before acting.
        this.latest = null;
        return state;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs || signal?.aborted) return state;
      onTick?.(elapsed);
      await sleep(Math.min(this.leasePollMs, timeoutMs - elapsed));
    }
  }

  // -------------------------------------------------------------- dialogs

  private async checkDialogLocked(): Promise<void> {
    const status = await this.run(['dialog', 'status'], 5_000);
    this.dialog = status.success && status.data.hasDialog === true ? { type: str(status.data.type) || 'dialog', message: str(status.data.message) } : null;
  }

  /** What the agent sees while a dialog blocks the page: the dialog, and nothing else to act on. */
  private dialogObservationLocked(options: ObserveOptions): Observation {
    const { type, message } = this.dialog ?? { type: 'dialog', message: '' };
    const url = this.latest?.observation.url ?? '';
    const tree = `- dialog (${type}) ${JSON.stringify(message)}: the page is blocked until this is answered with browser_dialog.`;
    const observationId = createHash('sha256').update(`${this.tabId}\n${url}\ndialog\n${type}\n${message}`).digest('hex').slice(0, 12);
    const observation: Observation = { observationId, url, title: '', tree, refs: [], omitted: 0 };
    this.latest = { observation, refs: new Map(), options };
    return observation;
  }

  private dialogBlocks(action: Action): BrowserError | null {
    if (!this.dialog || action.type === 'dialog') return null;
    return {
      code: 'engine_error',
      message: `A ${this.dialog.type} dialog is open (${JSON.stringify(this.dialog.message)}). Answer it with browser_dialog first.`,
      retryable: true,
    };
  }

  // ------------------------------------------------------------ approvals

  async describeTarget(observationId: string, action: Action): Promise<Result<TargetFacts | null>> {
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      const blocked = this.gate();
      if (blocked) return fail(blocked);
      if (this.dialog) await this.checkDialogLocked();
      const dialogBlocked = this.dialogBlocks(action);
      if (dialogBlocked) return fail(dialogBlocked);
      if (action.type === 'dialog') {
        const status = await this.run(['dialog', 'status']);
        if (!status.success) return envelopeError(status);
        if (status.data.hasDialog !== true) return { ok: true, value: null };
        return {
          ok: true,
          value: {
            tag: 'DIALOG',
            type: null,
            role: null,
            text: str(status.data.message),
            href: null,
            inForm: false,
            formMethod: null,
            formAction: null,
            dialogType: str(status.data.type) || null,
          },
        };
      }
      if (!this.overlay) return { ok: true, value: null };
      let point: [number, number] | null = null;
      if (action.type === 'click') {
        if ('ref' in action.target) {
          if (!this.latest || this.latest.observation.observationId !== observationId) {
            return fail({ code: 'stale_ref', message: 'This observation is out of date; call read_page and use the new observationId.', retryable: true });
          }
          const ref = normalizeRef(action.target.ref);
          if (!ref || !this.latest.refs.has(ref.slice(1))) return fail({ code: 'not_found', message: `Ref ${action.target.ref} is not in the latest observation.`, retryable: false });
          // Same scroll the click itself would do, so the point we inspect is the point that gets clicked.
          const box = await this.runner.batch(this.globalArgs, [['scrollintoview', ref], ['get', 'box', ref]], { timeoutMs: this.timeoutMs, bail: true });
          if (!Array.isArray(box)) return envelopeError(box);
          const r = box[1]?.result;
          if (!r || box.some((e) => e.error !== null)) return { ok: true, value: null };
          point = [num(r.x) + num(r.width) / 2, num(r.y) + num(r.height) / 2];
        } else {
          point = [action.target.x, action.target.y];
        }
      } else if (action.type !== 'key') {
        return { ok: true, value: null };
      }
      const expr = point ? overlayCall(this.token, 'describe', point[0], point[1]) : overlayCall(this.token, 'describe');
      const env = await this.run(['eval', expr]);
      return { ok: true, value: env.success ? parseTargetFacts(env.data.result) : null };
    });
  }

  async requestApproval(summary: string): Promise<Result<LeaseSnapshot>> {
    if (!this.overlay) return engineError('Approvals need the in-page overlay, which is disabled for this driver.');
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      if (!this.lease.requestApproval(summary)) return fail(this.gate() ?? { code: 'user_control', message: 'The user has control.', retryable: true });
      await this.run(['eval', overlayCall(this.token, 'setMode', 'approval', summary)]);
      await this.run(['tab', this.tabId]);
      return { ok: true, value: this.lease.snapshot() };
    });
  }

  async waitForDecision(
    timeoutMs: number,
    onTick?: (elapsedMs: number) => void,
    signal?: AbortSignal,
  ): Promise<'approved' | 'denied' | 'timeout' | 'user' | 'stopped'> {
    const started = Date.now();
    const before = this.lease.snapshot();
    for (;;) {
      const now = await this.control();
      if (now.approvals > before.approvals) return 'approved';
      if (now.denials > before.denials) return 'denied';
      if (now.state === 'stopped') return 'stopped';
      if (now.state === 'user') return 'user';
      const elapsed = Date.now() - started;
      if (now.state !== 'approval' || elapsed >= timeoutMs || signal?.aborted) {
        await this.exclusive(async () => {
          if (this.lease.cancelApproval()) await this.run(['eval', overlayCall(this.token, 'setMode', 'agent', 'pilot-browser is controlling this tab')]);
        });
        return 'timeout';
      }
      onTick?.(elapsed);
      await sleep(Math.min(this.leasePollMs, timeoutMs - elapsed));
    }
  }

  async isCurrent(observationId: string): Promise<boolean> {
    return this.exclusive(async () => {
      // Deliberately independent of `latest`: resolving an approval changes the lease, which clears it.
      if (!this.mode) return false;
      const fresh = await this.observeLocked(this.lastObserveOptions);
      return fresh.ok && fresh.value.observationId === observationId;
    });
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
    this.lastObserveOptions = options;
    await this.checkDialogLocked();
    if (this.dialog) return { ok: true, value: this.dialogObservationLocked(options) };
    const filter = options.filter ?? 'visible';
    const page = await this.runner.batch(
      this.globalArgs,
      [['get', 'url'], ['get', 'title'], filter === 'all' ? ['snapshot'] : ['snapshot', '-i'], ['eval', '[innerWidth, innerHeight]'], ['eval', CAPTCHA_PROBE]],
      { timeoutMs: this.timeoutMs },
    );
    if (!Array.isArray(page)) return page.code === 'timeout' ? this.afterTimeoutLocked(envelopeError(page)) : envelopeError(page);
    // The CAPTCHA probe is best-effort; only the page reads must succeed.
    const failed = page.slice(0, 4).find((e) => e.error !== null);
    if (failed) return fail(toBrowserError(failed.error));
    const [urlEntry, titleEntry, snapEntry, vpEntry, captchaEntry] = page as [BatchEntry, BatchEntry, BatchEntry, BatchEntry, BatchEntry | undefined];
    const captcha = captchaEntry && captchaEntry.error === null ? parseCaptcha(captchaEntry.result.result) : null;

    const url = str(urlEntry.result.url);
    const fullTree = str(snapEntry.result.snapshot);
    const lines = parseSnapshotTree(fullTree);
    let tree = fullTree;
    let shown: readonly RefLine[] = lines;

    if (filter === 'visible' && lines.length > 0) {
      const boxes = await this.runner.batch(this.globalArgs, lines.map((l) => ['get', 'box', `@${l.ref}`]), { timeoutMs: this.timeoutMs });
      if (!Array.isArray(boxes)) return boxes.code === 'timeout' ? this.afterTimeoutLocked(envelopeError(boxes)) : envelopeError(boxes);
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
    const observation: Observation = { observationId, url, title: str(titleEntry.result.title), tree, refs: shown, omitted, captcha };
    this.latest = { observation, refs: new Map(lines.map((l) => [l.ref, l])), options };
    return { ok: true, value: observation };
  }

  // --------------------------------------------------------------- acting

  async act(observationId: string, action: Action): Promise<Result<Observation>> {
    return this.exclusive(async () => {
      if (!this.mode) return engineError('Not connected.');
      await this.pollLocked();
      const blocked = this.gate();
      if (blocked) return fail(blocked);
      if (this.dialog) await this.checkDialogLocked();
      const dialogBlocked = this.dialogBlocks(action);
      if (dialogBlocked) return fail(dialogBlocked);
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
      // Page scripts are frozen while a dialog is open, so answering one can't be bracketed.
      const bracket = this.overlay && action.type !== 'dialog';
      const begin = bracket ? [['eval', overlayCall(this.token, 'begin', status)]] : [];
      const end = bracket ? [['eval', overlayCall(this.token, 'end')]] : [];
      const entries = await this.runner.batch(this.globalArgs, [...begin, ...commands.value], { timeoutMs: this.timeoutMs, bail: true });
      if (!Array.isArray(entries)) {
        // Close the agent-input window even when the action hung, so the user's controls work again.
        if (end.length > 0) await this.runner.batch(this.globalArgs, end, { timeoutMs: 4_000 });
        return entries.code === 'timeout' ? this.afterTimeoutLocked(envelopeError(entries)) : envelopeError(entries);
      }
      if (entries.some((e) => e.result.dialogOpened === true)) {
        // The action opened a dialog: page scripts are frozen, so don't touch the page until it's answered.
        await this.checkDialogLocked();
        if (this.dialog) return { ok: true, value: this.dialogObservationLocked({}) };
      }
      if (end.length > 0) await this.runner.batch(this.globalArgs, end, { timeoutMs: 4_000 });
      const failed = entries.find((e) => e.error !== null);
      if (failed) return fail(toBrowserError(failed.error));
      if (action.type === 'dialog') this.dialog = null;
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
  async overlayLayout(): Promise<{ readonly mode: string; readonly text: string; readonly buttons: Readonly<Record<string, { x: number; y: number }>> } | null> {
    return this.exclusive(async () => {
      const env = await this.run(['eval', overlayCall(this.token, 'layout')]);
      const raw = env.success ? env.data.result : null;
      return typeof raw === 'string' ? (JSON.parse(raw) as { mode: string; text: string; buttons: Record<string, { x: number; y: number }> }) : null;
    });
  }

  /** @internal Test hook: whether the overlay is on the page right now (does not count as a heartbeat). */
  async overlayMounted(): Promise<boolean | null> {
    return this.exclusive(async () => {
      const env = await this.run(['eval', overlayCall(this.token, 'mounted')]);
      const raw = env.success ? env.data.result : null;
      return typeof raw === 'boolean' ? raw : null;
    });
  }

  async disconnect(): Promise<void> {
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
    await this.exclusive(async () => {
      if (!this.mode) return;
      // Take the controls off the page first, in case the tab outlives the session.
      if (this.overlay) await this.run(['eval', overlayCall(this.token, 'dispose')], 3_000);
      // Attach: close only the agent's own tab, then detach. agent-browser never closes an attached browser.
      if (this.mode.kind === 'attach') await this.run(['tab', 'close'], 10_000);
      await this.run(['close'], 10_000);
      // agent-browser's daemon outlives `close`, and one stuck on a command can't close at all;
      // left running it keeps the browser (in managed mode, the profile) busy for later sessions.
      await this.killSession();
      this.endLocked();
    });
  }

  private async removeOverlayFile(): Promise<void> {
    if (this.overlayFile) await rm(this.overlayFile, { force: true });
    this.overlayFile = null;
  }
}
