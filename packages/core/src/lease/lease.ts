/**
 * Who may drive the agent tab right now.
 * - `agent`: the agent may act.
 * - `user`: the user took over (clicked/typed in the tab, or pressed Pause). The agent waits.
 * - `handoff`: the agent asked the user to do something (login, 2FA, CAPTCHA). The agent waits.
 * - `approval`: the agent asked to do something consequential and waits for Approve / Deny.
 * - `stopped`: the user pressed Stop. Terminal for the session.
 */
export type ControlState = 'agent' | 'user' | 'handoff' | 'approval' | 'stopped';

/** Events the in-page overlay records; the driver drains and applies them. */
export type OverlayEventType = 'input' | 'pause' | 'handback' | 'approve' | 'deny' | 'stop';

export interface OverlayEvent {
  readonly type: OverlayEventType;
}

export interface LeaseSnapshot {
  readonly state: ControlState;
  /** Handoff request or approval summary shown to the user, or '' otherwise. */
  readonly message: string;
  /** Increments on every hand-back, so waiters can tell a fresh hand-back from an old one. */
  readonly handbacks: number;
  /** Increments on every Approve / Deny press. */
  readonly approvals: number;
  readonly denials: number;
}

/**
 * Engine-neutral interaction lease. The page only reports events; this state machine is
 * the source of truth, so it survives navigations that reset the in-page overlay.
 */
export class InteractionLease {
  private current: ControlState = 'agent';
  private request = '';
  private handbackCount = 0;
  private approvalCount = 0;
  private denialCount = 0;

  get state(): ControlState {
    return this.current;
  }

  snapshot(): LeaseSnapshot {
    return {
      state: this.current,
      message: this.request,
      handbacks: this.handbackCount,
      approvals: this.approvalCount,
      denials: this.denialCount,
    };
  }

  private toAgent(): void {
    this.current = 'agent';
    this.request = '';
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
          // During a handoff or an approval the user is expected to look around; that doesn't change who waits.
          if (this.current === 'agent') this.current = 'user';
          break;
        case 'pause':
          if (this.current === 'agent' || this.current === 'approval') {
            this.current = 'user';
            this.request = '';
          }
          break;
        case 'handback':
          if (this.current === 'user' || this.current === 'handoff') {
            this.toAgent();
            this.handbackCount += 1;
          }
          break;
        case 'approve':
          if (this.current === 'approval') {
            this.toAgent();
            this.approvalCount += 1;
          }
          break;
        case 'deny':
          if (this.current === 'approval') {
            this.toAgent();
            this.denialCount += 1;
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

  /** The agent asks permission for one consequential action. Only possible while it has control. */
  requestApproval(summary: string): boolean {
    if (this.current !== 'agent') return false;
    this.current = 'approval';
    this.request = summary;
    return true;
  }

  /** Withdraw an unanswered approval request (e.g. it timed out). */
  cancelApproval(): boolean {
    if (this.current !== 'approval') return false;
    this.toAgent();
    return true;
  }
}
