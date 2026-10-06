import type { Action, BrowserError, Result } from '@pilot-browser/core';

const DEFAULT_SCROLL_PX = 600;

const unsupported = (message: string): { readonly ok: false; readonly error: BrowserError } => ({
  ok: false,
  error: { code: 'engine_error', message, retryable: false },
});

/** `e12` or `@e12` → `@e12`, or null when it isn't a ref. */
export const normalizeRef = (ref: string): string | null => {
  const bare = ref.startsWith('@') ? ref.slice(1) : ref;
  return /^e\d+$/.test(bare) ? `@${bare}` : null;
};

/**
 * Translate an engine-neutral action into agent-browser commands.
 * Refs must already be validated against the latest observation.
 */
export const actionToCommands = (action: Action): Result<string[][]> => {
  switch (action.type) {
    case 'navigate':
      return { ok: true, value: [['open', action.url]] };
    case 'click': {
      const button = action.button ?? 'left';
      const count = action.clickCount ?? 1;
      if ('ref' in action.target) {
        if (button !== 'left') return unsupported('Right/middle clicks need x/y coordinates in this driver.');
        if (count === 3) return unsupported('Triple-click needs x/y coordinates in this driver.');
        return { ok: true, value: [[count === 2 ? 'dblclick' : 'click', action.target.ref]] };
      }
      const { x, y } = action.target;
      const press = [
        ['mouse', 'down', button],
        ['mouse', 'up', button],
      ];
      return { ok: true, value: [['mouse', 'move', String(x), String(y)], ...Array.from({ length: count }, () => press).flat()] };
    }
    case 'type':
      return { ok: true, value: [[action.clear === false ? 'type' : 'fill', action.ref, action.text]] };
    case 'select':
      return { ok: true, value: [['select', action.ref, action.value]] };
    case 'check':
      return { ok: true, value: [[action.checked ? 'check' : 'uncheck', action.ref]] };
    case 'key':
      return { ok: true, value: [['press', action.keys]] };
    case 'scroll':
      return { ok: true, value: [['scroll', action.direction, String(action.amountPx ?? DEFAULT_SCROLL_PX)]] };
    case 'upload':
      if (action.files.length === 0) return unsupported('upload needs at least one file.');
      return { ok: true, value: [['upload', action.ref, ...action.files]] };
    case 'dialog':
      return {
        ok: true,
        value: [action.accept ? ['dialog', 'accept', ...(action.promptText === undefined ? [] : [action.promptText])] : ['dialog', 'dismiss']],
      };
  }
};

/** Refs an action points at, for freshness and existence checks. */
export const refsOf = (action: Action): string[] => {
  switch (action.type) {
    case 'click':
      return 'ref' in action.target ? [action.target.ref] : [];
    case 'type':
    case 'select':
    case 'check':
    case 'upload':
      return [action.ref];
    default:
      return [];
  }
};

/** Whether an action depends on what the model last observed (and so needs a fresh observationId). */
export const dependsOnObservation = (action: Action): boolean =>
  refsOf(action).length > 0 || (action.type === 'click' && !('ref' in action.target));
