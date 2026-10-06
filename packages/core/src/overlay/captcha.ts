/**
 * Detects a visible, unsolved CAPTCHA or bot check in the top document, so the agent can tell
 * "the page wants a human" apart from "the page is slow". Detection only: pilot-browser never
 * tries to solve one. Cross-origin challenge frames can't be read, so this works from what the
 * top document can see: frame URLs, their boxes, and the hidden response fields widgets fill in
 * once solved. An invisible reCAPTCHA badge on its own is not a challenge.
 */
const probeCaptcha = (): string | null => {
  const innerH = window.innerHeight;
  const innerW = window.innerWidth;

  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerH || r.left >= innerW) return false;
    // Hidden challenges sit in containers with visibility:hidden or opacity:0.
    for (let node: Element | null = el, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    }
    return true;
  };

  const frames = Array.from(document.querySelectorAll('iframe'));
  const visibleFrame = (pattern: RegExp): boolean => frames.some((f) => pattern.test(f.src) && shown(f));
  const unanswered = (selector: string): boolean => {
    const fields = Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(selector));
    return fields.length === 0 || fields.some((f) => !f.value);
  };

  if (visibleFrame(/\/recaptcha\/(api2|enterprise)\/bframe/)) return 'recaptcha challenge visible';
  if (frames.some((f) => /\/recaptcha\/(api2|enterprise)\/anchor/.test(f.src) && !/[?&]size=invisible/.test(f.src) && shown(f)) && unanswered('[name="g-recaptcha-response"]')) {
    return 'recaptcha checkbox unsolved';
  }
  if (frames.some((f) => /hcaptcha\.com/.test(f.src) && /frame=challenge/.test(f.src) && shown(f))) return 'hcaptcha challenge visible';
  if (frames.some((f) => /hcaptcha\.com/.test(f.src) && /frame=checkbox/.test(f.src) && shown(f)) && unanswered('[name="h-captcha-response"]')) {
    return 'hcaptcha checkbox unsolved';
  }
  if (visibleFrame(/challenges\.cloudflare\.com/) && unanswered('[name="cf-turnstile-response"]')) return 'turnstile unsolved';
  if (visibleFrame(/arkoselabs\.com|funcaptcha\.com/)) return 'arkose challenge visible';
  const title = document.title.toLowerCase();
  const body = (document.body?.innerText ?? '').slice(0, 2000).toLowerCase();
  if (
    document.getElementById('challenge-form') !== null ||
    title === 'just a moment...' ||
    /verify you are human|checking (if the site connection is secure|your browser before accessing)/.test(body)
  ) {
    return 'bot check interstitial';
  }
  return null;
};

/** Expression for the driver's eval: a short description of the challenge, or null. */
export const CAPTCHA_PROBE = `(${probeCaptcha.toString()})()`;

const KNOWN = new Set([
  'recaptcha challenge visible',
  'recaptcha checkbox unsolved',
  'hcaptcha challenge visible',
  'hcaptcha checkbox unsolved',
  'turnstile unsolved',
  'arkose challenge visible',
  'bot check interstitial',
]);

/** Accept only the probe's own fixed strings; anything else the page could fake is dropped. */
export const parseCaptcha = (raw: unknown): string | null => (typeof raw === 'string' && KNOWN.has(raw) ? raw : null);
