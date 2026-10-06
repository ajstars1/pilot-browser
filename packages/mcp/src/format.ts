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

/**
 * Render an observation for the model. Page content is wrapped in an untrusted block so the
 * model can tell the page's words apart from the user's instructions.
 */
export const formatObservation = (obs: Observation, prefix = ''): ToolResult => {
  const omitted =
    obs.omitted > 0
      ? `\n(${obs.omitted} more element${obs.omitted === 1 ? '' : 's'} not shown: outside the viewport or past the size limit. Scroll, or call browser_read_page with filter "all".)`
      : '';
  const body = [
    prefix,
    `observationId: ${obs.observationId}`,
    `url: ${obs.url}`,
    `title: ${obs.title}`,
    '<page_content untrusted="true">',
    obs.tree || '(no interactive elements in view)',
    `</page_content>${omitted}`,
  ]
    .filter(Boolean)
    .join('\n');
  return text(body);
};
