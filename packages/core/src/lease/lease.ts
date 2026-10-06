/**
 * Who may drive the agent tab right now.
 * - `agent`: the agent may act.
 * - `user`: the user took over (clicked/typed in the tab, or pressed Pause). The agent waits.
 * - `handoff`: the agent asked the user to do something (login, 2FA, CAPTCHA). The agent waits.
 * - `stopped`: the user pressed Stop. Terminal for the session.
 */
export type ControlState = 'agent' | 'user' | 'handoff' | 'stopped';

/** Events the in-page overlay records; the driver drains and applies them. */
export type OverlayEventType = 'input' | 'pause' | 'handback' | 'stop';

export interface OverlayEvent {
  readonly type: OverlayEventType;
}

export interface LeaseSnapshot {
  readonly state: ControlState;
  /** Handoff request shown to the user, or '' outside handoff. */
  readonly message: string;
  /** Increments on every hand-back, so waiters can tell a fresh hand-back from an old one. */
  readonly handbacks: number;
}

/**
 * Engine-neutral interaction lease. The page only reports events; this state machine is
 * the source of truth, so it survives navigations that reset the in-page overlay.
 */
export class InteractionLease {
  private current: ControlState = 'agent';
  private request = '';
  private handbackCount = 0;

  get state(): ControlState {
    return this.current;
  }

  snapshot(): LeaseSnapshot {
    return { state: this.current, message: this.request, handbacks: this.handbackCount };
  }

  /** Apply drained overlay events in order. Returns true when the state changed. */
  apply(events: readonly OverlayEvent[]): boolean {
    const before = this.current;
    for (const { type } of events) {
      if (this.current === 'stopped') break;
      switch (type) {
        case 'stop':
          this.current = 'stopped';
          this.request = '';
          break;
        case 'input':
        case 'pause':
          // During a handoff the user is expected to interact; that doesn't change who waits.
          if (this.current === 'agent') this.current = 'user';
          break;
        case 'handback':
          if (this.current === 'user' || this.current === 'handoff') {
            this.current = 'agent';
            this.request = '';
            this.handbackCount += 1;
          }
          break;
      }
    }
    return this.current !== before;
  }

  /** The agent asks the user to take over for a specific task. */
  requestHandoff(message: string): boolean {
    if (this.current === 'stopped') return false;
    this.current = 'handoff';
    this.request = message;
    return true;
  }
}
