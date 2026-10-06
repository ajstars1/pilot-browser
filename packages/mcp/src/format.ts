import type { BrowserError, Observation } from '@pilot-browser/core';

export interface ToolResult {
  [key: string]: unknown;
  readonly content: ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly data: string; readonly mimeType: string })[];
  readonly isError?: boolean;
}

export const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });

export const errorResult = (error: BrowserError): ToolResult => ({
  content: [{ type: 'text', text: `Error [${error.code}]${error.retryable ? ' (retryable)' : ''}: ${error.message}` }],
  isError: true,
});

/** Neutralize anything in page text that could close or reopen the untrusted block. */
export const escapeUntrusted = (value: string): string => value.replace(/<(\/?)(page_content)/gi, '<\u200b$1$2');

/**
 * Render an observation for the model. Everything the page controls (URL, title, tree) goes
 * inside the untrusted block, escaped so page text can't close the block early.
 */
export const formatObservation = (obs: Observation, prefix = ''): ToolResult => {
  const omitted =
    obs.omitted > 0
      ? `\n(${obs.omitted} more element${obs.omitted === 1 ? '' : 's'} not shown: outside the viewport or past the size limit. Scroll, or call browser_read_page with filter "all".)`
      : '';
  // The CAPTCHA line is pilot-browser's own finding (one of a fixed set of strings), not page text.
  const body = [
    prefix,
    obs.captcha ? `captcha: ${obs.captcha} (a human check is on the page; it was not solved)` : '',
    `observationId: ${obs.observationId}`,
    '<page_content untrusted="true">',
    `url: ${escapeUntrusted(obs.url)}`,
    `title: ${escapeUntrusted(obs.title)}`,
    escapeUntrusted(obs.tree) || '(no interactive elements in view)',
    `</page_content>${omitted}`,
  ]
    .filter(Boolean)
    .join('\n');
  return text(body);
};
