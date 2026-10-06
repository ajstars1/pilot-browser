/** Browser engine family. Determines the wire protocol: CDP for chromium, WebDriver BiDi for firefox. */
export type Engine = 'chromium' | 'firefox';

export type BrowserKind = 'chrome' | 'chrome-canary' | 'chromium' | 'brave' | 'edge' | 'firefox';

/** A live, attachable browser endpoint found on this machine. */
export interface Endpoint {
  readonly engine: Engine;
  readonly browser: BrowserKind;
  readonly wsUrl: string;
  /** File the endpoint was read from (DevToolsActivePort or WebDriverBiDiServer.json). */
  readonly source: string;
}

/**
 * What a driver can do. The observer and executor degrade on these flags
 * instead of branching on engine names.
 */
export interface DriverCapabilities {
  /** Browser-computed accessibility tree (CDP yes; BiDi has none and computes one in-page). */
  readonly a11yTree: boolean;
  /** More than one client may attach at once (Firefox BiDi allows one session). */
  readonly multiClient: boolean;
  /** Page-to-driver bindings for overlay buttons (CDP Runtime.addBinding / BiDi channels). */
  readonly bindings: boolean;
  readonly screencast: boolean;
  readonly fileUpload: boolean;
  /** In-page controls let the user take over, hand back and stop (requires the overlay). */
  readonly handoff: boolean;
}

/** One line of an accessibility snapshot that carries a ref. */
export interface RefLine {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly depth: number;
  readonly attrs: readonly string[];
  /** Text after the closing bracket, e.g. a field's current value. */
  readonly value: string;
  /** The original line, for re-emitting a filtered tree without reformatting. */
  readonly raw: string;
}

export interface Observation {
  /** Changes whenever the page state the refs were taken from changes. Actions must quote it. */
  readonly observationId: string;
  readonly url: string;
  readonly title: string;
  readonly tree: string;
  readonly refs: readonly RefLine[];
  /** Interactive elements left out (e.g. below the viewport). */
  readonly omitted: number;
}

export type BrowserErrorCode =
  | 'stale_ref'
  | 'ref_changed'
  | 'blocked_by_policy'
  | 'needs_approval'
  | 'needs_user'
  | 'timeout'
  | 'not_found'
  | 'tab_gone'
  /** The user has control of the tab (took over, or is handling a handoff). Wait, don't act. */
  | 'user_control'
  /** The user pressed Stop. Do not continue. */
  | 'user_stopped'
  | 'engine_error';

export interface BrowserError {
  readonly code: BrowserErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BrowserError };
