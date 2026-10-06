import type { BrowserError } from '@pilot-browser/core';

/** Map an agent-browser error message (and optional code) onto pilot-browser's error vocabulary. */
export const toBrowserError = (message: string | null, code: string | null = null): BrowserError => {
  const text = message ?? 'unknown agent-browser error';
  if (code === 'tab_gone' || /\btab_gone\b/.test(text)) {
    return { code: 'tab_gone', message: `The agent's tab was closed. ${text}`, retryable: false };
  }
  if (code === 'timeout' || /timed? ?out|timeout/i.test(text)) return { code: 'timeout', message: text, retryable: true };
  if (/approv/i.test(text)) {
    return { code: 'needs_user', message: `Approve the remote-debugging prompt in the browser, then retry. ${text}`, retryable: true };
  }
  if (/unknown ref|stale|detached|no longer (attached|exists)/i.test(text)) {
    return { code: 'stale_ref', message: `The page changed; read it again. ${text}`, retryable: true };
  }
  if (/no element|not found|no such|did not match/i.test(text)) return { code: 'not_found', message: text, retryable: false };
  return { code: 'engine_error', message: text, retryable: false };
};
