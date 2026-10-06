import { describe, expect, it } from 'vitest';
import type { Action } from '../../driver.js';
import { isApprovalMode, requiresApproval, type ApprovalMode } from '../mode.js';
import type { RiskLevel } from '../risk.js';

const click: Action = { type: 'click', target: { ref: '@e1' } };
const nav: Action = { type: 'navigate', url: 'https://a.example/' };
const ask = (mode: ApprovalMode, risk: RiskLevel, action: Action = click): boolean => requiresApproval(mode, risk, action);

describe('requiresApproval', () => {
  it('manual: every page-changing action, but not navigation or scrolling', () => {
    expect(ask('manual', 'none')).toBe(true);
    expect(ask('manual', 'none', { type: 'type', ref: '@e2', text: 'x' })).toBe(true);
    expect(ask('manual', 'none', nav)).toBe(false);
    expect(ask('manual', 'none', { type: 'scroll', direction: 'down' })).toBe(false);
  });

  it('supervised: write and high risk', () => {
    expect([ask('supervised', 'none'), ask('supervised', 'write'), ask('supervised', 'high')]).toEqual([false, true, true]);
  });

  it('auto: high risk only, so form submits and uploads just happen', () => {
    expect([ask('auto', 'none'), ask('auto', 'write'), ask('auto', 'high')]).toEqual([false, false, true]);
  });

  it('full-auto: never', () => {
    expect([ask('full-auto', 'none'), ask('full-auto', 'write'), ask('full-auto', 'high')]).toEqual([false, false, false]);
  });

  it('should validate mode names', () => {
    expect(isApprovalMode('auto')).toBe(true);
    expect(isApprovalMode('yolo')).toBe(false);
  });
});
