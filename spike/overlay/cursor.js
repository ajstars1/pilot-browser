// pilot-browser live cursor overlay (spike prototype).
// Draws an agent cursor, click ripple and status pill inside a closed shadow root.
// Driven by trusted pointer events, which CDP Input.dispatchMouseEvent produces,
// so position is always in the page's own coordinate space (no DPR/scroll mapping).
(() => {
  if (globalThis.__pilotBrowserOverlay) return;
  // Subframes (incl. cross-origin iframes) get a cursor only; the status pill lives in the top frame.
  const isTop = window === window.top;
  const state = { host: null, root: null, cursor: null, pill: null, idle: 0 };

  const mount = () => {
    if (state.host || !document.documentElement) return;
    const host = document.createElement('pilot-browser-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;' +
      'z-index:2147483647!important;pointer-events:none!important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      * { pointer-events: none !important; box-sizing: border-box; }
      .cursor { position: fixed; top: 0; left: 0; width: 22px; height: 22px; margin: -11px;
        border-radius: 50%; background: #8b5cf6; border: 3px solid #fff;
        box-shadow: 0 0 0 2px #8b5cf6aa, 0 2px 8px #0006; display: none;
        transition: transform 120ms ease-out; }
      .cursor.down { transform: scale(.75); }
      .ripple { position: fixed; width: 56px; height: 56px; margin: -28px; border-radius: 50%;
        border: 2px solid #8b5cf6; animation: r .45s ease-out forwards; }
      @keyframes r { from { transform: scale(.2); opacity: .9 } to { transform: scale(1); opacity: 0 } }
      .pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        font: 600 12px system-ui, sans-serif; color: #fff; background: #111827e6;
        padding: 6px 12px; border-radius: 999px; box-shadow: 0 2px 10px #0005; }
      .pill::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 8px;
        border-radius: 50%; background: #8b5cf6; animation: p 1s infinite; }
      @keyframes p { 50% { opacity: .3 } }
    </style>${isTop ? '<div class="pill">pilot-browser is controlling this tab</div>' : ''}<div class="cursor"></div>`;
    state.host = host;
    state.root = root;
    state.cursor = root.querySelector('.cursor');
    state.pill = root.querySelector('.pill');
    document.documentElement.appendChild(host);
  };

  const onPointer = (event) => {
    if (!event.isTrusted) return;
    mount();
    const c = state.cursor;
    if (!c) return;
    c.style.display = 'block';
    c.style.left = `${event.clientX}px`;
    c.style.top = `${event.clientY}px`;
    c.classList.toggle('down', event.buttons !== 0);
    if (!isTop) {
      clearTimeout(state.idle);
      state.idle = setTimeout(() => { c.style.display = 'none'; }, 1200);
    }
    if (event.type === 'pointerdown') {
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = `${event.clientX}px`;
      r.style.top = `${event.clientY}px`;
      r.addEventListener('animationend', () => r.remove(), { once: true });
      state.root.appendChild(r);
    }
  };

  for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
    addEventListener(type, onPointer, { capture: true, passive: true });
  }

  globalThis.__pilotBrowserOverlay = {
    setStatus: (text) => { mount(); if (state.pill) state.pill.textContent = text; },
  };
  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
