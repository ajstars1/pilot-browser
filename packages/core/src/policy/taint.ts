const MIN_LENGTH = 6;
const MAX_ENTRIES = 40;

const originOf = (url: string): string | null => {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * Cross-origin data-flow check. Remembers recent page content per origin; if the agent is
 * about to type text that it could only have read on a *different* origin (an OTP from the
 * mail tab into some form, a token into a search box), that typing needs approval.
 *
 * Text that also appears on the current origin isn't flagged: copying within a site is fine.
 * Pixels (screenshots) are not tracked.
 */
export class TaintTracker {
  private readonly entries: { readonly origin: string; readonly content: string }[] = [];

  record(url: string, content: string): void {
    const origin = originOf(url);
    if (!origin || !content) return;
    this.entries.push({ origin, content: normalize(content) });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** Origins (other than the current one) whose content contains `value`. */
  sourcesOf(value: string, currentUrl: string): string[] {
    const needle = normalize(value.trim());
    const current = originOf(currentUrl);
    if (needle.length < MIN_LENGTH || !current) return [];
    if (this.entries.some((e) => e.origin === current && e.content.includes(needle))) return [];
    return [...new Set(this.entries.filter((e) => e.origin !== current && e.content.includes(needle)).map((e) => e.origin))];
  }
}
