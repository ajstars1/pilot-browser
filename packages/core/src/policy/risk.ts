import type { Action } from '../driver.js';

/**
 * What is actually under an action, read from the live DOM by the overlay with builtins
 * captured before page scripts ran. `null` fields mean "unknown" (e.g. inside a
 * cross-origin iframe, or the overlay is off).
 */
export interface TargetFacts {
  readonly tag: string | null;
  readonly type: string | null;
  readonly role: string | null;
  /** Visible text / value / aria-label, trimmed. */
  readonly text: string;
  /** Absolute href of the enclosing link, if any. */
  readonly href: string | null;
  readonly inForm: boolean;
  readonly formMethod: string | null;
  /** Absolute form action URL, if the target is in a form. */
  readonly formAction: string | null;
  /** For dialog actions: the open dialog's type (alert, confirm, prompt, beforeunload). */
  readonly dialogType?: string | null;
}

/**
 * - `none`: routine (navigate within the page, fill a field, pick an option).
 * - `write`: changes something on your behalf but is reversible or expected in a workflow
 *   (submit a form, upload, send, post, apply).
 * - `high`: money, destruction or data leaving its site (pay, buy, delete, transfer,
 *   accept a destructive dialog, type text copied from another origin).
 */
export type RiskLevel = 'none' | 'write' | 'high';

export interface Reason {
  readonly level: Exclude<RiskLevel, 'none'>;
  readonly text: string;
}

export interface Assessment {
  /** Needs the user's explicit approval before it runs (in the default supervised mode). */
  readonly consequential: boolean;
  /** The highest level among the reasons. */
  readonly risk: RiskLevel;
  readonly reasons: readonly string[];
  readonly details: readonly Reason[];
  /** Where the action would send the user or their data, when known before acting. */
  readonly destination: string | null;
}

export interface AssessContext {
  readonly url: string;
  readonly target: TargetFacts | null;
  /** Accessible name of the ref, from the observation. */
  readonly refName?: string;
}

/**
 * Words on a control that mean "this changes something in the world". Deliberately not
 * "accept", "ok", "save draft", "continue" or "next": cookie banners and wizards would make
 * approvals constant noise, and people stop reading prompts they see too often.
 */
const HIGH_WORDS =
  /\b(buy|purchase|pay|payment|checkout|check out|place (?:my |your )?order|order now|confirm (?:order|purchase|payment|transfer)|donate|delete|remove|erase|destroy|deactivate|close (?:my |your )?account|cancel (?:my |your )?(?:subscription|order|account|plan)|unsubscribe|transfer|withdraw|merge|deploy|grant|authori[sz]e)\b/i;
const WRITE_WORDS = /\b(subscribe|send|submit|post|publish|tweet|reply|apply|sign up|register|book|reserve|invite|share|approve)\b/i;

const SUBMIT_INPUT_TYPES = new Set(['submit', 'image']);

const isSubmitControl = (t: TargetFacts): boolean => {
  const tag = t.tag?.toUpperCase();
  const type = t.type?.toLowerCase() ?? null;
  if (tag === 'INPUT') return type !== null && SUBMIT_INPUT_TYPES.has(type);
  if (tag === 'BUTTON') return t.inForm && (type === null || type === '' || type === 'submit');
  return false;
};

const isPost = (t: TargetFacts): boolean => (t.formMethod ?? 'get').toLowerCase() !== 'get';

const sameDocument = (href: string, url: string): boolean => {
  try {
    const a = new URL(href);
    const b = new URL(url);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
};

/**
 * Decide whether an action is consequential and where it would lead. Rules are structural
 * first (what the DOM says will happen), wording second.
 */
export const assessAction = (action: Action, ctx: AssessContext): Assessment => {
  const t = ctx.target;
  const details: Reason[] = [];
  const add = (level: Reason['level'], text: string): void => {
    details.push({ level, text });
  };
  let destination: string | null = null;

  switch (action.type) {
    case 'upload':
      add('write', 'uploads files to the page');
      break;
    case 'click': {
      if (t?.href && !t.href.toLowerCase().startsWith('javascript:') && !sameDocument(t.href, ctx.url)) destination = t.href;
      if (t && isSubmitControl(t)) {
        destination = t.formAction ?? destination;
        if (isPost(t)) add('write', 'submits a form');
      }
      const high = [ctx.refName, t?.text].find((w) => w && HIGH_WORDS.test(w));
      const write = [ctx.refName, t?.text].find((w) => w && WRITE_WORDS.test(w));
      if (high) add('high', `the control says “${high.trim().slice(0, 60)}”`);
      else if (write) add('write', `the control says “${write.trim().slice(0, 60)}”`);
      break;
    }
    case 'key': {
      const pressesEnter = /(^|\+)Enter$/i.test(action.keys.trim());
      if (pressesEnter && t?.inForm && t.tag?.toUpperCase() === 'INPUT') {
        destination = t.formAction;
        if (isPost(t)) add('write', 'submits a form');
      }
      break;
    }
    case 'dialog': {
      const type = t?.dialogType?.toLowerCase();
      if (action.accept && (type === 'confirm' || type === 'prompt' || type === 'beforeunload')) {
        add('high', `accepts a ${type} dialog${t?.text ? `: “${t.text.slice(0, 80)}”` : ''}`);
      }
      break;
    }
    default:
      break;
  }
  const risk: RiskLevel = details.some((d) => d.level === 'high') ? 'high' : details.length > 0 ? 'write' : 'none';
  return { consequential: details.length > 0, risk, reasons: details.map((d) => d.text), details, destination };
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** One-line description of an action for the approval prompt shown in the tab. */
export const describeAction = (action: Action, ctx: AssessContext): string => {
  const host = hostOf(ctx.url);
  const name = (ctx.refName || ctx.target?.text || '').trim().slice(0, 60);
  switch (action.type) {
    case 'click':
      return `Click ${name ? `“${name}”` : 'here'} on ${host}`;
    case 'key':
      return `Press ${action.keys} to submit the form on ${host}`;
    case 'upload':
      return `Upload ${action.files.map((f) => f.split(/[\\/]/).pop()).join(', ')} to ${host}`;
    case 'type':
      return `Type “${action.text.slice(0, 40)}${action.text.length > 40 ? '…' : ''}” on ${host}`;
    case 'dialog':
      return `${action.accept ? 'Accept' : 'Dismiss'} the dialog on ${host}`;
    default:
      return `${action.type} on ${host}`;
  }
};
