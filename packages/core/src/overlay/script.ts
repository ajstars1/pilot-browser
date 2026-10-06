/**
 * Live cursor overlay for agent-owned tabs. Runs in the page, so it must stay
 * self-contained: no imports, no references to module scope.
 *
 * Draws a cursor, click ripple and status pill in a closed shadow root, driven by
 * trusted pointer events (CDP Input.dispatchMouseEvent and BiDi input.performActions
 * both produce them), so it needs no coordinate mapping. Subframes get a cursor only.
 * `inert` + `aria-hidden` keep it out of accessibility snapshots.
 */
const pilotOverlay = (): void => {
  const g = globalThis as typeof globalThis & { __pilotBrowserOverlay?: { setStatus: (text: string) => void } };
  if (g.__pilotBrowserOverlay) return;
  const isTop = window === window.top;
  let root: ShadowRoot | null = null;
  let cursor: HTMLElement | null = null;
  let pill: HTMLElement | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const mount = (): void => {
    if (root || !document.documentElement) return;
    const host = document.createElement('pilot-browser-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
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
      '.pill{position:fixed;top:10px;left:50%;transform:translateX(-50%);font:600 12px system-ui,sans-serif;color:#fff;',
      'background:#111827e6;padding:6px 12px;border-radius:999px;box-shadow:0 2px 10px #0005}',
      ".pill::before{content:'';display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:#8b5cf6;animation:p 1s infinite}",
      '@keyframes p{50%{opacity:.3}}',
    ].join('');
    root.appendChild(style);
    if (isTop) {
      pill = document.createElement('div');
      pill.className = 'pill';
      pill.textContent = 'pilot-browser is controlling this tab';
      root.appendChild(pill);
    }
    cursor = document.createElement('div');
    cursor.className = 'cursor';
    root.appendChild(cursor);
    document.documentElement.appendChild(host);
  };

  const onPointer = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    mount();
    if (!cursor || !root) return;
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
  g.__pilotBrowserOverlay = {
    setStatus: (text: string) => {
      mount();
      if (pill) pill.textContent = text;
    },
  };
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
};

/** Self-invoking source for `addinitscript` / `Page.addScriptToEvaluateOnNewDocument` / `script.addPreloadScript`. */
export const OVERLAY_SCRIPT = `(${pilotOverlay.toString()})();`;

/** Expression that updates the status pill text, safe to evaluate in any agent-owned tab. */
export const overlayStatusExpression = (text: string): string =>
  `globalThis.__pilotBrowserOverlay?.setStatus(${JSON.stringify(text)})`;
