import type { BrowserError, Result } from '../types.js';

/**
 * Per-task destination allowlist. Enforced by pilot-browser, not the engine:
 * agent-browser cannot contain the network in attach mode.
 *
 * Entry forms:
 * - `*`                      any http(s) URL
 * - `https://app.example.com` exact origin (scheme + host + port)
 * - `example.com`            that host and its subdomains, any port
 * - `127.0.0.1:8791`         that host and port, any scheme
 */
export interface OriginPolicy {
  readonly check: (url: string) => Result<URL>;
  readonly entries: readonly string[];
}

/** Pages the agent may always sit on. */
const NEUTRAL_URLS = new Set(['about:blank']);

const blocked = (message: string): { readonly ok: false; readonly error: BrowserError } => ({
  ok: false,
  error: { code: 'blocked_by_policy', message, retryable: false },
});

const matchesEntry = (url: URL, entry: string): boolean => {
  if (entry === '*') return true;
  if (/^https?:\/\//i.test(entry)) {
    try {
      return new URL(entry).origin === url.origin;
    } catch {
      return false;
    }
  }
  const [host = '', port] = entry.toLowerCase().split(':');
  if (port !== undefined) return url.hostname === host && url.port === port;
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
};

export const createOriginPolicy = (entries: readonly string[]): OriginPolicy => {
  const normalized = entries.map((e) => e.trim()).filter(Boolean);
  return {
    entries: normalized,
    check: (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return blocked(`Not a valid URL: ${raw}`);
      }
      if (NEUTRAL_URLS.has(url.href)) return { ok: true, value: url };
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return blocked(`Scheme ${url.protocol} is not allowed; only http and https.`);
      }
      if (url.username || url.password) return blocked('URLs with embedded credentials are not allowed.');
      if (!normalized.some((entry) => matchesEntry(url, entry))) {
        return blocked(`${url.origin} is not in this session's allowed origins (${normalized.join(', ') || 'none'}).`);
      }
      return { ok: true, value: url };
    },
  };
};
