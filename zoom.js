'use strict';
/* Tap an image or diagram to enlarge it. It lifts out of the page and glides to fill the screen
   (animated from exactly where it sits), pinch or double-tap to zoom in further, drag to pan, and tap
   or swipe it away to send it back into place. Used for card images and explanation diagrams.
   Everything is one transform on .zbox: translate(x, y) scale(s), measured from the fitted frame. */
const Zoom = (() => {
  const root = $('#zoom'), scrim = root.querySelector('.zscrim'), box = root.querySelector('.zbox'), hint = root.querySelector('.zhint');
  const MAX = 5, EASE = 'cubic-bezier(.2,.9,.25,1)', TOP = 56, BOTTOM = 64;
  let src = null, L = 0, T = 0, W = 0, H = 0;                    // the fitted frame on screen
  let s = 1, x = 0, y = 0;                                         // transform on top of the frame
  const pts = new Map();
  let g = null, closing = false, finishT = 0, tapClose = 0, wasZoomed = false;        // tapClose: when a tap started closing (a 2nd tap soon after zooms instead)
  const DOUBLE = 260;

  const apply = (ms = 0) => {
    box.style.transition = ms ? `transform ${ms}ms ${EASE}, opacity ${ms}ms` : 'none';
    box.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  };
  const fade = (el, to, ms) => { el.style.transition = `opacity ${ms}ms`; el.style.opacity = to; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // zoom to `ns` keeping the content under screen point p where it is
  function scaleAt(ns, p, from = { s, x, y }) {
    const cx = (p[0] - L - from.x) / from.s, cy = (p[1] - T - from.y) / from.s;
    s = ns; x = p[0] - L - cx * ns; y = p[1] - T - cy * ns;
  }
  // keep a zoomed image covering the screen (or centred on an axis where it's smaller than the screen)
  function clamp() {
    if (s <= 1.01) { s = 1; x = 0; y = 0; return; }
    const w = W * s, h = H * s, vw = innerWidth, vh = innerHeight;
    x = w <= vw ? (vw - w) / 2 - L : Math.min(-L, Math.max(vw - L - w, x));
    y = h <= vh ? (vh - h) / 2 - T : Math.min(-T, Math.max(vh - T - h, y));
  }

  function open(el) {
    if (!el || !root.hidden) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    src = el; closing = false;
    const node = el.cloneNode(true);
    node.onclick = null;
    node.style.cssText = 'display:block;width:100%;height:100%;margin:0;max-width:none;max-height:none;visibility:visible';
    box.replaceChildren(node);
    // fit inside the screen, keeping its shape
    const ar = r.width / r.height, maxH = innerHeight - TOP - BOTTOM;
    W = innerWidth - 24; H = W / ar;
    if (H > maxH) { H = maxH; W = H * ar; }
    L = (innerWidth - W) / 2; T = TOP + (maxH - H) / 2;
    Object.assign(box.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px', opacity: 1 });
    // start exactly on top of the original, then glide to the frame
    s = r.width / W; x = r.left - L; y = r.top - T; apply(0);
    scrim.style.transition = 'none'; scrim.style.opacity = 0; hint.style.transition = 'none'; hint.style.opacity = 0;
    root.hidden = false;
    void box.offsetWidth;
    el.style.visibility = 'hidden';
    s = 1; x = 0; y = 0; apply(440);
    fade(scrim, 1, 320); root.querySelector('.zx').style.opacity = '';
    const seen = LS.get('zoomHint', 0);
    if (seen < 3) { LS.set('zoomHint', seen + 1); setTimeout(() => !root.hidden && fade(hint, 1, 400), 450); setTimeout(() => fade(hint, 0, 600), 3200); }
    haptic(1); SFX.zoomIn();
  }

  function close(instant, byTap) {
    if (root.hidden || closing) return;
    closing = true; pts.clear(); g = null; tapClose = byTap ? performance.now() : 0; wasZoomed = s > 1.05;
    if (instant === true) return finish();
    const r = src && src.isConnected ? src.getBoundingClientRect() : null;
    if (r && r.width && r.bottom > 0 && r.top < innerHeight) { s = r.width / W; x = r.left - L; y = r.top - T; apply(300); }
    else { scaleAt(s * 0.85, [innerWidth / 2, innerHeight / 2]); apply(240); box.style.opacity = 0; }   // its spot is gone: shrink and fade
    fade(scrim, 0, 260); fade(hint, 0, 150);
    haptic(1); SFX.zoomOut();
    finishT = setTimeout(finish, 310);
  }
  // a second tap right after the one that started closing: it was a double-tap, so stop closing and
  // zoom in where it landed (or, if it was zoomed in, go back to fit)
  function zoomInstead(p) {
    clearTimeout(finishT); closing = false; tapClose = 0;
    box.style.opacity = 1; fade(scrim, 1, 200);
    s = 1; x = 0; y = 0;
    if (!wasZoomed) { scaleAt(2.6, p); clamp(); }
    apply(340); SFX.pick(!wasZoomed); haptic(1);
  }
  function finish() {
    root.hidden = true; box.replaceChildren();
    if (src) src.style.visibility = '';
    src = null; closing = false;
  }

  function settle(ms = 320) {
    if (s > MAX) { scaleAt(MAX, g && g.m ? g.m : [innerWidth / 2, innerHeight / 2]); haptic(1); }
    clamp(); apply(ms); fade(scrim, 1, 200);
  }

  root.addEventListener('pointerdown', (e) => {
    if (closing) {
      if (tapClose && performance.now() - tapClose < DOUBLE && !e.target.closest('.zx')) zoomInstead([e.clientX, e.clientY]);
      return;
    }
    if (e.target.closest('.zx')) { close(); return; }
    try { root.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { kind: 'pinch', d0: dist(a, b), m0: mid(a, b), from: { s, x, y } };
    } else if (pts.size === 1) {
      g = { kind: 'one', x0: e.clientX, y0: e.clientY, from: { s, x, y }, moved: false, mode: null, hist: [[e.clientX, e.clientY, performance.now()]] };
    }
  });
  root.addEventListener('pointermove', (e) => {
    if (!g || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (g.kind === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()], m = mid(a, b);
      let ns = g.from.s * dist(a, b) / g.d0;
      if (ns > MAX) ns = MAX + (ns - MAX) * 0.3;                   // rubber-band past the limit
      if (ns < 1) ns = 1 - (1 - ns) * 0.5;
      scaleAt(ns, g.m0, g.from); x += m[0] - g.m0[0]; y += m[1] - g.m0[1]; g.m = m;
      apply(0);
      return;
    }
    if (g.kind !== 'one') return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    g.hist.push([e.clientX, e.clientY, performance.now()]); if (g.hist.length > 5) g.hist.shift();
    if (!g.moved && Math.hypot(dx, dy) > 6) { g.moved = true; g.mode = g.from.s > 1.01 ? 'pan' : 'dismiss'; }
    if (g.mode === 'pan') { x = g.from.x + dx; y = g.from.y + dy; apply(0); }
    else if (g.mode === 'dismiss') {
      // like Photos: it follows your finger and shrinks a little as you pull it away
      const k = Math.min(1, Math.hypot(dx, dy) / (innerHeight * 0.45));
      s = 1 - k * 0.28; x = dx + (W * (1 - s)) / 2; y = dy + (H * (1 - s)) / 2;
      apply(0); scrim.style.transition = 'none'; scrim.style.opacity = 1 - k * 0.85;
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size === 1) {                                         // one finger left: carry on panning with it
        const [p] = [...pts.values()];
        settle(220);
        g = { kind: 'one', x0: p[0], y0: p[1], from: { s, x, y }, moved: true, mode: s > 1.01 ? 'pan' : 'dismiss', hist: [[p[0], p[1], performance.now()]] };
      } else { settle(); g = null; }
      return;
    }
    const d = g; g = null;
    if (!d.moved) {
      close(false, true);                                           // tap closes at once; a quick second tap makes it a zoom
      return;
    }
    if (d.mode === 'dismiss') {
      const a = d.hist[0], b = d.hist[d.hist.length - 1];
      const v = Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, b[2] - a[2]);
      const far = Math.hypot(b[0] - d.x0, b[1] - d.y0);
      if (far > 110 || (v > 0.5 && far > 30)) close();
      else { s = 1; x = 0; y = 0; apply(360); fade(scrim, 1, 250); }
      return;
    }
    // pan: let it glide a little in the direction it was flung, then keep it on screen
    const a = d.hist[0], b = d.hist[d.hist.length - 1], dt = Math.max(1, b[2] - a[2]);
    x += ((b[0] - a[0]) / dt) * 120; y += ((b[1] - a[1]) / dt) * 120;
    settle(420);
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  addEventListener('resize', () => { if (!root.hidden) close(true); });

  return { open, close, get isOpen() { return !root.hidden; } };
})();
