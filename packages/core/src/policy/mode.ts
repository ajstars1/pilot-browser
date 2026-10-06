import type { Action } from '../driver.js';
import type { RiskLevel } from './risk.js';

/**
 * How much the agent may do without asking. Chosen by the person running the server
 * (config file or env), never by the model.
 *
 * - `manual`: approve every action that changes the page (click, type, select, upload, submit…).
 * - `supervised` (default): approve consequential actions (risk `write` or `high`).
 * - `auto`: approve only `high` risk (payments, deletes, cross-site copies, destructive dialogs).
 * - `full-auto`: never ask. The hard rails (origin allowlist, upload jail, destination checks,
 *   Stop / takeover) still apply in every mode.
 */
export type ApprovalMode = 'manual' | 'supervised' | 'auto' | 'full-auto';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'supervised', 'auto', 'full-auto'];

export const isApprovalMode = (value: unknown): value is ApprovalMode =>
  typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);

/** Actions that change the page or send something; reading, navigating and scrolling don't. */
const changesPage = (action: Action): boolean => action.type !== 'navigate' && action.type !== 'scroll';

/** Whether this action needs the user's Approve under the given mode. */
export const requiresApproval = (mode: ApprovalMode, risk: RiskLevel, action: Action): boolean => {
  switch (mode) {
    case 'manual':
      return changesPage(action);
    case 'supervised':
      return risk !== 'none';
    case 'auto':
      return risk === 'high';
    case 'full-auto':
      return false;
  }
};
