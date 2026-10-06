import type { ControlState, OverlayEventType } from '../lease/lease.js';
import type { TargetFacts } from '../policy/risk.js';

/**
 * In-page overlay for agent-owned tabs: cursor, status pill and the user's controls
 * (Pause / Hand back / Stop). Runs in the page's main world before any page script, so it
 * must stay self-contained: no imports, no references to module scope.
 *
 * Trust model:
 * - The API on `globalThis.__pilotBrowserOverlay` is frozen and non-configurable, and every
 *   method checks a per-session token that is passed in as an argument (so it never appears
 *   in any function's source text). Page scripts can neither replace it nor drive it.
 * - Builtins are captured at install time, before page scripts can patch them.
 * - Agent input and user input are both `isTrusted`. The driver opens an "agent window"
 *   (begin/end) around each action; trusted input outside it is the user's.
 * - Buttons ignore clicks inside an agent window, so the agent cannot press them for the user.
 */
const pilotOverlay = (token: string): void => {
  const KEY = '__pilotBrowserOverlay';
  if (Object.prototype.hasOwnProperty.call(globalThis, KEY)) return;
  const now = performance.now.bind(performance);
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const isTop = window === window.top;
  // Captured before page scripts run, so a page can't patch them to lie about what's under a click.
  const getter = (proto: object, key: string): ((this: unknown) => unknown) | undefined =>
    Object.getOwnPropertyDescriptor(proto, key)?.get as ((this: unknown) => unknown) | undefined;
  const elementFromPoint = Document.prototype.elementFromPoint;
  const activeElementOf = getter(Document.prototype, 'activeElement');
  const closest = Element.prototype.closest;
  const getAttribute = Element.prototype.getAttribute;
  const tagNameOf = getter(Element.prototype, 'tagName');
  const innerTextOf = getter(HTMLElement.prototype, 'innerText');
  const anchorHref = getter(HTMLAnchorElement.prototype, 'href');
  const formAction = getter(HTMLFormElement.prototype, 'action');
  const formMethod = getter(HTMLFormElement.prototype, 'method');
  const inputValue = getter(HTMLInputElement.prototype, 'value');
  const iframeSrc = getter(HTMLIFrameElement.prototype, 'src');
  const isConnectedOf = getter(Node.prototype, 'isConnected');
  const appendChild = Node.prototype.appendChild;
  const removeChild = Node.prototype.removeChild;
  const every = setInterval.bind(window);
  const later = setTimeout.bind(window);
  const GRACE_MS = 400;
  const FAILSAFE_MS = 20_000;
  /** No word from the driver for this long means its session is gone: take the overlay down. */
  const ORPHAN_MS = 20_000;
  const IDLE = 'pilot-browser is controlling this tab';
  // Challenge widgets (reCAPTCHA, hCaptcha, Turnstile, Arkose) move focus into their own frames
  // on their own; that focus change is the page's doing, not the user's.
  const CHALLENGE_FRAME = /\/recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com/i;

  type Mode = 'agent' | 'user' | 'handoff' | 'approval' | 'stopped';
  type Queued = { type: 'input' | 'pause' | 'handback' | 'approve' | 'deny' | 'stop' };
  let mode: Mode = 'agent';
  let status = IDLE;
  let request = '';
  let agentUntil = 0;
  let actionSeq = 0;
  let lastBeat = now();
  let disposed = false;
  const events: Queued[] = [];

  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let cursor: HTMLElement | null = null;
  let pill: HTMLElement | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const inAgentWindow = (): boolean => now() < agentUntil;

  const render = (): void => {
    if (!pill) return;
    const labels: Record<Mode, { text: string; buttons: [string, string][] }> = {
      agent: { text: status, buttons: [['pause', 'Pause'], ['stop', 'Stop']] },
      user: { text: 'You have control. pilot-browser is paused.', buttons: [['handback', 'Hand back'], ['stop', 'Stop']] },
      handoff: { text: `pilot-browser needs you: ${request}`, buttons: [['handback', 'Done, hand back'], ['stop', 'Stop']] },
      approval: { text: `pilot-browser wants to: ${request}`, buttons: [['approve', 'Approve'], ['deny', 'Deny'], ['stop', 'Stop']] },
      stopped: { text: 'pilot-browser stopped.', buttons: [] },
    };
    const { text, buttons } = labels[mode];
    pill.className = `pill ${mode}`;
    pill.replaceChildren();
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = text;
    pill.appendChild(label);
    for (const [act, caption] of buttons) {
      const button = document.createElement('button');
      // Never focusable: a focused element is exposed to accessibility snapshots despite aria-hidden,
      // which would hand the agent refs to the user's own controls.
      button.tabIndex = -1;
      button.dataset.act = act;
      button.textContent = caption;
      pill.appendChild(button);
    }
  };

  const record = (type: Queued['type']): void => {
    if (mode === 'stopped' || disposed) return;
    events.push({ type });
    if (events.length > 100) events.shift();
    if (type === 'stop') mode = 'stopped';
    else if (type === 'handback' && (mode === 'user' || mode === 'handoff')) mode = 'agent';
    else if ((type === 'approve' || type === 'deny') && mode === 'approval') mode = 'agent';
    else if (type === 'pause' && (mode === 'agent' || mode === 'approval')) mode = 'user';
    else if (type === 'input' && mode === 'agent') mode = 'user';
    render();
  };

  const attached = (el: Node): boolean => isConnectedOf?.call(el) === true;

  const mount = (): void => {
    if (disposed || !document.documentElement) return;
    if (host) {
      // Pages that hydrate or re-render the whole document (e.g. Remix on Greenhouse) drop
      // foreign nodes from <html>. Put the overlay back, or the user loses their controls.
      if (!attached(host)) appendChild.call(document.documentElement, host);
      return;
    }
    host = document.createElement('pilot-browser-overlay');
    // aria-hidden keeps the overlay out of accessibility snapshots, so the agent never gets refs to it.
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;' +
      'z-index:2147483647!important;pointer-events:none!important;';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '*{pointer-events:none!important;box-sizing:border-box}',
      '.cursor{position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px;border-radius:50%;background:#8b5cf6;',
      'border:3px solid #fff;box-shadow:0 0 0 2px #8b5cf6aa,0 2px 8px #0006;display:none;transition:transform 120ms ease-out}',
      '.cursor.down{transform:scale(.75)}',
      '.ripple{position:fixed;width:56px;height:56px;margin:-28px;border-radius:50%;border:2px solid #8b5cf6;animation:r .45s ease-out forwards}',
      '@keyframes r{from{transform:scale(.2);opacity:.9}to{transform:scale(1);opacity:0}}',
      '.pill{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:min(92vw,720px);',
      'font:600 12px/1.3 system-ui,sans-serif;color:#fff;background:#111827f0;padding:6px 6px 6px 12px;border-radius:999px;box-shadow:0 2px 12px #0006}',
      ".pill::before{content:'';flex:none;width:8px;height:8px;border-radius:50%;background:#8b5cf6;animation:p 1s infinite}",
      '.pill.user::before,.pill.handoff::before{background:#f59e0b;animation:none}',
      '.pill.handoff{background:#78350ff2}',
      '.pill.approval{background:#1e3a8af2}',
      '.pill.approval::before{background:#60a5fa;animation:none}',
      'button[data-act=approve]{background:#bbf7d0}',
      '.pill.stopped::before{background:#ef4444;animation:none}',
      '.pill.stopped{padding-right:12px}',
      '.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      'button{pointer-events:auto!important;cursor:pointer;flex:none;font:600 12px system-ui,sans-serif;color:#111827;background:#fff;',
      'border:0;border-radius:999px;padding:4px 10px}',
      'button[data-act=stop]{background:#fecaca}',
      '@keyframes p{50%{opacity:.3}}',
    ].join('');
    root.appendChild(style);
    if (isTop) {
      pill = document.createElement('div');
      root.appendChild(pill);
      // Keep focus where it was when a button is pressed (see tabIndex above).
      pill.addEventListener('mousedown', (event) => event.preventDefault());
      pill.addEventListener('click', (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        const act = target?.dataset.act;
        if (!event.isTrusted || !act || inAgentWindow()) return;
        const events: Record<string, Queued['type']> = { pause: 'pause', handback: 'handback', approve: 'approve', deny: 'deny', stop: 'stop' };
        const type = events[act];
        if (type) record(type);
      });
      render();
    }
    cursor = document.createElement('div');
    cursor.className = 'cursor';
    root.appendChild(cursor);
    appendChild.call(document.documentElement, host);
  };

  /** Take the overlay off the page (the session ended); the next sign of life brings it back. */
  const detach = (): void => {
    const parent = host?.parentNode;
    if (host && parent) removeChild.call(parent, host);
  };

  /** The driver is alive: note it, and make sure the controls are on the page. */
  const beat = (): void => {
    lastBeat = now();
    mount();
  };

  const fromOverlay = (event: globalThis.Event): boolean => host !== null && event.composedPath().includes(host);

  const onUserInput = (event: globalThis.Event): void => {
    if (!event.isTrusted || fromOverlay(event) || inAgentWindow()) return;
    if (isTop) record('input');
    // Cross-origin frames can't see the top frame's state; report and let the top frame decide.
    else window.top?.postMessage({ __pilotBrowser: 'input' }, '*');
  };

  const onPointer = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    mount();
    // Only the agent's pointer gets the purple cursor; the user's own mouse is left alone.
    if (!cursor || !root || (isTop && !inAgentWindow())) return;
    const c = cursor;
    c.style.display = 'block';
    c.style.left = `${event.clientX}px`;
    c.style.top = `${event.clientY}px`;
    c.classList.toggle('down', event.buttons !== 0);
    if (!isTop) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        c.style.display = 'none';
      }, 1200);
    }
    if (event.type === 'pointerdown') {
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      root.appendChild(ripple);
    }
  };

  for (const type of ['pointermove', 'pointerdown', 'pointerup'] as const) {
    addEventListener(type, onPointer, { capture: true, passive: true });
  }
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    addEventListener(type, onUserInput, { capture: true, passive: true });
  }
  if (isTop) {
    // Init scripts may not reach out-of-process iframes, so a click inside one never reaches this
    // document. Focus moving into the frame does: the window blurs and the iframe becomes active.
    addEventListener('blur', () => {
      later(() => {
        const active = activeElementOf?.call(document) as Element | null;
        if (!active || tagNameOf?.call(active) !== 'IFRAME' || inAgentWindow()) return;
        if (CHALLENGE_FRAME.test(String(iframeSrc?.call(active) ?? ''))) return;
        record('input');
      }, 0);
    });
    addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      // A frame can only ever report input (which pauses the agent); it can never resume it.
      if (event.source === window || typeof data !== 'object' || data === null) return;
      if ((data as { __pilotBrowser?: unknown }).__pilotBrowser === 'input' && !inAgentWindow()) record('input');
    });
  }

  const api = freeze({
    version: 2,
    /** Open an agent-input window and show what the agent is doing. */
    begin(t: string, text?: string): boolean {
      if (t !== token) return false;
      actionSeq += 1;
      agentUntil = now() + FAILSAFE_MS;
      if (typeof text === 'string' && text) status = text;
      beat();
      render();
      return true;
    },
    end(t: string): boolean {
      if (t !== token) return false;
      agentUntil = now() + GRACE_MS;
      lastBeat = now();
      // Once the action is over, stop describing it ("Clicking “Submit”" would be stale).
      const seq = actionSeq;
      later(() => {
        if (seq !== actionSeq || status === IDLE) return;
        status = IDLE;
        if (mode === 'agent') render();
      }, GRACE_MS);
      return true;
    },
    /** Display the driver's authoritative state (e.g. after a navigation reset this document). */
    setMode(t: string, next: string, text?: string): boolean {
      if (t !== token || !['agent', 'user', 'handoff', 'approval', 'stopped'].includes(next)) return false;
      mode = next as Mode;
      if (next === 'handoff' || next === 'approval') request = typeof text === 'string' ? text : '';
      else if (next === 'agent' && typeof text === 'string' && text) status = text;
      beat();
      render();
      return true;
    },
    /**
     * Return and clear queued events, as a JSON string built with the captured stringify.
     * The driver drains on every lease poll, so this doubles as its heartbeat.
     */
    drain(t: string): string | null {
      if (t !== token) return null;
      beat();
      const out = stringify({ mode, events: events.splice(0) });
      return out;
    },
    /** The session is over: remove the overlay for good and stop reporting input. */
    dispose(t: string): boolean {
      if (t !== token) return false;
      disposed = true;
      events.splice(0);
      detach();
      return true;
    },
    /** Whether the overlay is on the page right now, for tests. */
    mounted(t: string): boolean | null {
      if (t !== token) return null;
      return host !== null && attached(host);
    },
    /**
     * What is really at viewport point (x, y), or the focused element when no point is given:
     * the facts the risk check needs, read with captured builtins.
     */
    describe(t: string, x?: number, y?: number): string | null {
      if (t !== token) return null;
      const hit = typeof x === 'number' && typeof y === 'number' ? elementFromPoint.call(document, x, y) : (activeElementOf?.call(document) as Element | null);
      if (!(hit instanceof Element)) return stringify({ tag: null, type: null, role: null, text: '', href: null, inForm: false, formMethod: null, formAction: null });
      const el = (closest.call(hit, 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]') as Element | null) ?? hit;
      const link = closest.call(el, 'a[href]') as HTMLAnchorElement | null;
      const form = closest.call(el, 'form') as HTMLFormElement | null;
      const tag = String(tagNameOf?.call(el) ?? '');
      const text =
        (el instanceof HTMLInputElement ? String(inputValue?.call(el) ?? '') : '') ||
        (el instanceof HTMLElement ? String(innerTextOf?.call(el) ?? '') : '') ||
        String(getAttribute.call(el, 'aria-label') ?? '');
      return stringify({
        tag,
        type: getAttribute.call(el, 'type'),
        role: getAttribute.call(el, 'role'),
        text: text.trim().replace(/\s+/g, ' ').slice(0, 120),
        href: link ? String(anchorHref?.call(link) ?? '') : null,
        inForm: form !== null,
        formMethod: form ? String(formMethod?.call(form) ?? 'get') : null,
        formAction: form ? String(formAction?.call(form) ?? '') : null,
      });
    },
    /** Button centres in viewport pixels, for tests that act as the user. */
    layout(t: string): string | null {
      if (t !== token || !pill) return null;
      const buttons: Record<string, { x: number; y: number }> = {};
      for (const b of Array.from(pill.querySelectorAll('button'))) {
        const r = b.getBoundingClientRect();
        buttons[b.dataset.act ?? ''] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return stringify({ mode, text: mode === 'agent' ? status : request, buttons });
    },
  });
  Object.defineProperty(globalThis, KEY, { value: api, writable: false, configurable: false, enumerable: false });

  if (isTop) {
    // Without a heartbeat the driver is gone (crashed, or the session ended without closing
    // this tab): a pill with dead buttons would only mislead, so take it down. While the driver
    // lives, keep the overlay on the page even if the page removed it.
    every(() => {
      if (disposed) return;
      if (now() - lastBeat > ORPHAN_MS && !inAgentWindow()) detach();
      else mount();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
};

/** Self-invoking overlay source for one session. The token never appears in function source. */
export const buildOverlayScript = (token: string): string => `(${pilotOverlay.toString()})(${JSON.stringify(token)});`;

type OverlayMethod = 'begin' | 'end' | 'setMode' | 'drain' | 'layout' | 'describe' | 'dispose' | 'mounted';

/** Expression calling an overlay method; evaluates to null when the overlay isn't installed. */
export const overlayCall = (token: string, method: OverlayMethod, ...args: (string | number)[]): string =>
  `globalThis.__pilotBrowserOverlay?.${method}(${[token, ...args].map((a) => JSON.stringify(a)).join(', ')}) ?? null`;

export interface OverlayDrain {
  readonly mode: ControlState;
  readonly events: readonly { readonly type: OverlayEventType }[];
}

const MODES: readonly string[] = ['agent', 'user', 'handoff', 'approval', 'stopped'];
const TYPES: readonly string[] = ['input', 'pause', 'handback', 'approve', 'deny', 'stop'];

/** Parse and validate a `drain` result; page-controlled data is never trusted blindly. */
export const parseOverlayDrain = (raw: unknown): OverlayDrain | null => {
  if (typeof raw !== 'string') return null;
  try {
    const data = JSON.parse(raw) as { mode?: unknown; events?: unknown };
    if (typeof data.mode !== 'string' || !MODES.includes(data.mode) || !Array.isArray(data.events)) return null;
    const events = data.events.filter(
      (e): e is { type: OverlayDrain['events'][number]['type'] } =>
        typeof e === 'object' && e !== null && TYPES.includes(String((e as { type?: unknown }).type)),
    );
    return { mode: data.mode as ControlState, events: events.map((e) => ({ type: e.type })) };
  } catch {
    return null;
  }
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Parse and validate a `describe` result into TargetFacts. */
export const parseTargetFacts = (raw: unknown): TargetFacts | null => {
  if (typeof raw !== 'string') return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return {
      tag: str(d.tag),
      type: str(d.type),
      role: str(d.role),
      text: str(d.text) ?? '',
      href: str(d.href),
      inForm: d.inForm === true,
      formMethod: str(d.formMethod),
      formAction: str(d.formAction),
    };
  } catch {
    return null;
  }
};
