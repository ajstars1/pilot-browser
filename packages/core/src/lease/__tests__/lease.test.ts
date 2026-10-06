import { describe, expect, it } from 'vitest';
import { InteractionLease, type OverlayEvent } from '../lease.js';

const ev = (...types: OverlayEvent['type'][]): OverlayEvent[] => types.map((type) => ({ type }));

describe('InteractionLease', () => {
  it('should start with the agent in control', () => {
    expect(new InteractionLease().snapshot()).toEqual({ state: 'agent', message: '', handbacks: 0 });
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
    expect(lease.snapshot()).toEqual({ state: 'agent', message: '', handbacks: 1 });
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
    expect(lease.snapshot()).toEqual({ state: 'handoff', message: 'Please log in', handbacks: 0 });
    lease.apply(ev('handback'));
    expect(lease.snapshot()).toEqual({ state: 'agent', message: '', handbacks: 1 });
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
    expect(lease.snapshot()).toEqual({ state: 'user', message: '', handbacks: 1 });
  });
});
