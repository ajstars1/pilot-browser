import { describe, expect, it } from 'vitest';
import { InteractionLease, type OverlayEvent } from '../lease.js';

const ev = (...types: OverlayEvent['type'][]): OverlayEvent[] => types.map((type) => ({ type }));

describe('InteractionLease', () => {
  it('should start with the agent in control', () => {
    expect(new InteractionLease().snapshot()).toEqual({ state: 'agent', message: '', handbacks: 0, approvals: 0, denials: 0 });
  });

  it('should hand control to the user on their input or Pause', () => {
    const a = new InteractionLease();
    expect(a.apply(ev('input'))).toBe(true);
    expect(a.state).toBe('user');
    const b = new InteractionLease();
    b.apply(ev('pause'));
    expect(b.state).toBe('user');
  });

  it('should return control only on an explicit hand-back', () => {
    const lease = new InteractionLease();
    lease.apply(ev('input', 'input'));
    expect(lease.apply(ev('input'))).toBe(false);
    lease.apply(ev('handback'));
    expect(lease.snapshot()).toMatchObject({ state: 'agent', message: '', handbacks: 1 });
  });

  it('should ignore a hand-back when the agent already has control', () => {
    const lease = new InteractionLease();
    expect(lease.apply(ev('handback'))).toBe(false);
    expect(lease.snapshot().handbacks).toBe(0);
  });

  it('should keep a handoff open while the user works in the tab', () => {
    const lease = new InteractionLease();
    lease.requestHandoff('Please log in');
    lease.apply(ev('input', 'pause', 'input'));
    expect(lease.snapshot()).toMatchObject({ state: 'handoff', message: 'Please log in', handbacks: 0 });
    lease.apply(ev('handback'));
    expect(lease.snapshot()).toMatchObject({ state: 'agent', message: '', handbacks: 1 });
  });

  it('should make Stop terminal, even if a hand-back follows in the same batch', () => {
    const lease = new InteractionLease();
    lease.apply(ev('stop', 'handback'));
    expect(lease.state).toBe('stopped');
    expect(lease.requestHandoff('again')).toBe(false);
    lease.apply(ev('handback'));
    expect(lease.state).toBe('stopped');
  });

  it('should apply events in order', () => {
    const lease = new InteractionLease();
    lease.apply(ev('input', 'handback', 'input'));
    expect(lease.snapshot()).toMatchObject({ state: 'user', message: '', handbacks: 1 });
  });

  it('should resolve an approval request with Approve or Deny only', () => {
    const lease = new InteractionLease();
    expect(lease.requestApproval('Click “Pay”')).toBe(true);
    lease.apply(ev('input', 'handback'));
    expect(lease.snapshot()).toMatchObject({ state: 'approval', message: 'Click “Pay”' });
    lease.apply(ev('approve'));
    expect(lease.snapshot()).toMatchObject({ state: 'agent', message: '', approvals: 1, denials: 0 });
    lease.requestApproval('Click “Delete”');
    lease.apply(ev('deny'));
    expect(lease.snapshot()).toMatchObject({ state: 'agent', approvals: 1, denials: 1 });
  });

  it('should ignore Approve and Deny when nothing is pending', () => {
    const lease = new InteractionLease();
    expect(lease.apply(ev('approve', 'deny'))).toBe(false);
    expect(lease.snapshot()).toMatchObject({ approvals: 0, denials: 0 });
  });

  it('should only request approval while the agent has control', () => {
    const lease = new InteractionLease();
    lease.apply(ev('input'));
    expect(lease.requestApproval('x')).toBe(false);
    expect(lease.state).toBe('user');
  });

  it('should treat Pause during an approval as the user taking over', () => {
    const lease = new InteractionLease();
    lease.requestApproval('Click “Send”');
    lease.apply(ev('pause', 'approve'));
    expect(lease.snapshot()).toMatchObject({ state: 'user', message: '', approvals: 0 });
  });

  it('should withdraw an unanswered approval', () => {
    const lease = new InteractionLease();
    lease.requestApproval('x');
    expect(lease.cancelApproval()).toBe(true);
    expect(lease.state).toBe('agent');
    expect(lease.cancelApproval()).toBe(false);
  });
});
