import type { ControlState, LeaseSnapshot } from './lease/lease.js';
import type { DriverCapabilities, Endpoint, Observation, Result } from './types.js';

export type ConnectMode =
  /** Attach to the user's running browser via its approval-mode endpoint. */
  | { readonly kind: 'attach'; readonly endpoint: Endpoint }
  /** Launch a dedicated browser on its own persistent profile (unattended runs). */
  | { readonly kind: 'managed'; readonly profileDir: string; readonly headless: boolean; readonly executablePath?: string };

export interface SessionInfo {
  readonly sessionId: string;
  readonly browserVersion: string;
  /** The tab this session owns. Drivers never act on tabs they did not open. */
  readonly tabId: string;
}

export interface ObserveOptions {
  readonly filter?: 'visible' | 'interactive' | 'all';
  readonly delta?: boolean;
  readonly maxChars?: number;
}

export type Target = { readonly ref: string } | { readonly x: number; readonly y: number };

export type Action =
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'click'; readonly target: Target; readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: 1 | 2 | 3 }
  | { readonly type: 'type'; readonly ref: string; readonly text: string; readonly clear?: boolean }
  | { readonly type: 'select'; readonly ref: string; readonly value: string }
  | { readonly type: 'check'; readonly ref: string; readonly checked: boolean }
  | { readonly type: 'key'; readonly keys: string }
  | { readonly type: 'scroll'; readonly direction: 'up' | 'down'; readonly amountPx?: number }
  | { readonly type: 'upload'; readonly ref: string; readonly files: readonly string[] }
  | { readonly type: 'dialog'; readonly accept: boolean; readonly promptText?: string };

/**
 * Engine-neutral contract. No CDP or BiDi types cross this boundary, so the
 * agent-browser (CDP) driver, a future BiDi (Firefox) driver and an extension
 * relay are interchangeable. Policy, approvals and verification live above it.
 */
export interface BrowserDriver {
  readonly capabilities: DriverCapabilities;
  connect(mode: ConnectMode): Promise<Result<SessionInfo>>;
  observe(options?: ObserveOptions): Promise<Result<Observation>>;
  /** `observationId` must be the latest one; otherwise the driver returns `stale_ref`. */
  act(observationId: string, action: Action): Promise<Result<Observation>>;
  screenshot(options?: { readonly annotate?: boolean }): Promise<Result<{ readonly png: Uint8Array; readonly width: number; readonly height: number }>>;
  /** Show what the agent is doing in the page overlay. Optional; drivers without an overlay omit it. */
  setStatus?(text: string): Promise<void>;
  /** Current interaction lease. Drivers without handoff support always report the agent in control. */
  control?(): Promise<LeaseSnapshot>;
  /** Ask the user to take over for a task (login, 2FA, CAPTCHA, confirmation). Shown in the tab. */
  requestHandoff?(message: string): Promise<Result<LeaseSnapshot>>;
  /**
   * Wait until the agent may act again, the user stops it, or the timeout passes.
   * `onTick` is called about once a second while waiting (for progress reporting).
   */
  waitForUser?(timeoutMs: number, onTick?: (elapsedMs: number) => void): Promise<ControlState>;
  /** Attach mode: detach only, never close the user's browser. */
  disconnect(): Promise<void>;
}
