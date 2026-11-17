'use strict';
/* Flow Cards — swipe-through Anki reviews over AnkiConnect.
   Offline-first: cards are cached in IndexedDB, answers are queued and
   pushed with `answerCards` whenever AnkiConnect is reachable. */

const $ = (s) => document.querySelector(s);
const EASE = { left: 1, down: 2, up: 3, right: 4 };          // Again, Hard, Good, Easy
const LABEL = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const COLOR = { 1: '#ff5c7a', 2: '#ffa64d', 3: '#57e39b', 4: '#5cc8ff' };

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('fc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fc.' + k, JSON.stringify(v)); } catch {} },
};
const IDB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('flowcards', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
  };
})();

const cfg = Object.assign(
  { url: '', key: '', deck: '', newLimit: 20, revLimit: 300, ankiweb: true, sound: false, demo: false },
  LS.get('cfg', {})
);
const saveCfg = () => LS.set('cfg', cfg);

/* ---------- state ---------- */
let deck = [];        // remaining cards for this session
let queue = [];       // answers waiting to be pushed: {cardId, ease, t}
let cur = null, curEl = null, nextEl = null;
let total = 0, doneCount = 0, combo = 0;
let online = false, syncing = false, lastFetch = 0;
const today = () => new Date().toISOString().slice(0, 10);
let stats = LS.get('stats', {});
if (stats.day !== today()) stats = { day: today(), reviewed: 0, best: 0, correct: 0 };

/* ---------- AnkiConnect ---------- */
async function anki(action, params = {}, timeout = 8000) {
  if (!cfg.url) throw new Error('No AnkiConnect URL set');
  const body = { action, version: 6, params };
  if (cfg.key) body.key = cfg.key;
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(cfg.url.replace(/\/+$/, ''), { method: 'POST', body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  } finally { clearTimeout(tm); }
}

const q = (s) => '"' + s.replace(/"/g, '\\"') + '"';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

function clean(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<audio[\s\S]*?<\/audio>/gi, '')
    .trim();
}
function splitAnswer(question, answer) {
  const a = clean(answer);
  const m = a.split(/<hr id=["']?answer["']?\s*\/?>/i);
  if (m.length > 1) return m.slice(1).join('').trim();
  const qq = clean(question);
  return a.startsWith(qq) ? a.slice(qq.length).trim() : a;
}

async function inlineMedia(cards) {
  const names = new Set();
  const re = /<img[^>]+src=["']?([^"' >]+)/gi;
  for (const c of cards) for (const h of [c.q, c.a]) { let m; while ((m = re.exec(h))) if (!/^(https?:|data:)/i.test(m[1])) names.add(m[1]); }
  if (!names.size) return;
  const list = [...names];
  const map = {};
  for (let i = 0; i < list.length; i += 40) {
    const chunk = list.slice(i, i + 40);
    const res = await anki('multi', { actions: chunk.map((n) => {
      let f = n; try { f = decodeURIComponent(n); } catch {}
      return { action: 'retrieveMediaFile', params: { filename: f } };
    }) }, 30000).catch(() => []);
    chunk.forEach((n, j) => {
      const r = res[j]; const b64 = r && (r.result !== undefined ? r.result : r);
      if (typeof b64 === 'string' && b64) map[n] = `data:${MIME[n.split('.').pop().toLowerCase()] || 'image/png'};base64,${b64}`;
    });
  }
  const sub = (h) => h.replace(/(<img[^>]+src=["']?)([^"' >]+)/gi, (all, pre, src) => map[src] ? pre + map[src] : all);
  for (const c of cards) { c.q = sub(c.q); c.a = sub(c.a); }
}

async function fetchDeck() {
  const decks = await anki('deckNames');
  const roots = cfg.deck ? [cfg.deck] : decks.filter((d) => !d.includes('::'));
  let revCap = cfg.revLimit, newCap = cfg.newLimit;
  try { // respect Anki's own daily limits when available
    const st = Object.values(await anki('getDeckStats', { decks: roots }));
    revCap = Math.min(revCap, st.reduce((s, d) => s + d.review_count + d.learn_count, 0));
    newCap = Math.min(newCap, st.reduce((s, d) => s + d.new_count, 0));
  } catch {}
  const scope = cfg.deck ? `deck:${q(cfg.deck)}` : '';
  const [due, fresh] = await Promise.all([
    revCap > 0 ? anki('findCards', { query: `${scope} is:due -is:suspended -is:buried` }) : [],
    newCap > 0 ? anki('findCards', { query: `${scope} is:new -is:suspended -is:buried` }) : [],
  ]);
  const ids = [...due.slice(0, revCap), ...fresh.slice(0, newCap)];
  const info = [];
  for (let i = 0; i < ids.length; i += 100) info.push(...await anki('cardsInfo', { cards: ids.slice(i, i + 100) }, 20000));
  const cards = info.map((c) => ({
    id: c.cardId, deck: c.deckName, isNew: c.type === 0,
    q: clean(c.question), a: splitAnswer(c.question, c.answer),
    next: (c.nextReviews || []).map((s) => s.replace(/[⁨⁩]/g, '')),
  }));
  await inlineMedia(cards);
  // reviews in due order, new cards woven in every ~4th slot
  const revs = cards.filter((c) => !c.isNew), news = cards.filter((c) => c.isNew), out = [];
  while (revs.length || news.length) {
    for (let k = 0; k < 3 && revs.length; k++) out.push(revs.shift());
    if (news.length) out.push(news.shift());
  }
  return out;
}

async function flush() {
  if (!queue.length || cfg.demo) return true;
  const batch = queue.slice();
  await anki('answerCards', { answers: batch.map(({ cardId, ease }) => ({ cardId, ease })) }, 20000);
  queue = queue.slice(batch.length);
  await IDB.set('queue', queue);
  if (cfg.ankiweb) anki('sync', {}, 60000).catch(() => {});
  return true;
}

let flushTimer = 0;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => sync(false), 1200);
}

async function sync(refetch = true) {
  if (cfg.demo) { setStatus(); return; }
  if (syncing || !cfg.url) { setStatus(); return; }
  syncing = true; setStatus();
  try {
    await flush();
    online = true;
    if (refetch) {
      const fresh = await fetchDeck();
      lastFetch = Date.now();
      const keep = cur && fresh.find((c) => c.id === cur.id);
      const answered = new Set(queue.map((a) => a.cardId));
      deck = fresh.filter((c) => (!cur || c.id !== cur.id) && !answered.has(c.id));
      if (cur && keep) deck.unshift(cur);
      total = doneCount + deck.length;
      await IDB.set('deck', deck);
      render(true);
    }
  } catch (e) {
    online = false;
    console.warn('sync failed', e);
  } finally { syncing = false; setStatus(); }
}

function setStatus() {
  const el = $('#status'), t = el.querySelector('span');
  el.className = 'pill ' + (syncing ? 'busy' : queue.length ? 'pending' : online || cfg.demo ? 'ok' : '');
  t.textContent = cfg.demo ? 'demo' : syncing ? 'syncing' : queue.length ? `${queue.length} to sync` : online ? `${deck.length} left` : (cfg.url ? 'offline' : 'set up');
}

/* ---------- rendering ---------- */
function makeCard(c, isNext) {
  const el = document.createElement('article');
  el.className = 'card' + (isNext ? ' next' : '');
  el.innerHTML = `<div class="tint"></div><div class="lbl"></div>
    <div class="body"><div class="q"></div><div class="a"></div></div>
    <div class="foot"><span class="tag"></span><span class="iv"></span></div>`;
  el.querySelector('.q').innerHTML = c.q;
  el.querySelector('.a').innerHTML = c.a;
  el.querySelector('.tag').textContent = (c.deck || '').split('::').pop() + (c.isNew ? ' · new' : '');
  return el;
}

function fit(el) { // shrink text until it fits, then allow internal scrolling
  const body = el.querySelector('.body');
  body.classList.remove('long'); body.style.fontSize = '';
  let fs = 24;
  while (body.scrollHeight > body.clientHeight + 2 && fs > 15) { fs -= 1.5; body.style.fontSize = fs + 'px'; }
  if (body.scrollHeight > body.clientHeight + 2) body.classList.add('long');
}

function render(force) {
  const stage = $('#stage');
  if (force || !cur) { cur = deck[0] || null; }
  stage.innerHTML = '';
  curEl = nextEl = null;
  $('#done').hidden = !!cur;
  if (!cur) { combo = 0; showCombo(); showDone(); updateBar(); setStatus(); return; }
  if (deck[1]) { nextEl = makeCard(deck[1], true); stage.appendChild(nextEl); }
  curEl = makeCard(cur, false); stage.appendChild(curEl);
  fit(curEl);
  $('#hint').hidden = LS.get('hinted', false);
  updateBar(); setStatus();
}

function updateBar() {
  const pct = total ? (doneCount / total) * 100 : 0;
  $('#bar b').style.width = pct + '%';
}

function showDone() {
  $('#doneStats').textContent = stats.reviewed
    ? `${stats.reviewed} reviewed today · ${Math.round((stats.correct / stats.reviewed) * 100)}% recalled · best combo ×${stats.best}`
    : (cfg.url || cfg.demo ? 'Nothing due right now.' : 'Connect to AnkiConnect in settings to start.');
  if (stats.reviewed) celebrate();
}

/* ---------- reveal & answer ---------- */
function reveal() {
  if (!curEl || curEl.classList.contains('revealed')) return;
  curEl.classList.add('revealed', 'flip');
  setTimeout(() => curEl && curEl.classList.remove('flip'), 340);
  fit(curEl);
  if (cur.next && cur.next.length === 4) curEl.querySelector('.iv').textContent = `good · ${cur.next[2]}`;
  const r = curEl.getBoundingClientRect();
  FX.ring(r.left + r.width / 2, r.top + r.height / 2, 26, 'rgba(255,255,255,.9)');
  haptic(); tone(520, 0.04);
}

function answer(ease, dir, px, py) {
  if (!cur || !curEl) return;
  const card = cur, el = curEl;
  if (!cfg.demo) queue.push({ cardId: card.id, ease, t: Date.now() });
  deck.shift();
  if (ease === 1) deck.splice(Math.min(deck.length, 4), 0, card); // see it again soon
  else doneCount++;
  IDB.set('queue', queue); IDB.set('deck', deck);

  stats.reviewed++; if (ease > 1) stats.correct++;
  combo = ease > 1 ? combo + 1 : 0;
  stats.best = Math.max(stats.best, combo);
  LS.set('stats', stats); LS.set('hinted', true); $('#hint').hidden = true;

  // feedback
  const W = innerWidth, H = innerHeight;
  const x = px ?? W / 2, y = py ?? H / 2;
  if (ease === 1) { FX.fizzle(x, y); haptic(); tone(180, 0.08, 'triangle'); }
  else {
    const n = 26 + Math.min(combo, 40) * 3;
    FX.burst(x, y, n, COLOR[ease], 1 + Math.min(combo, 30) / 20);
    haptic(); if (combo >= 5) setTimeout(haptic, 70);
    tone(440 * Math.pow(2, Math.min(combo, 24) / 12), 0.06);
    if (combo && combo % 10 === 0) { celebrate(); setTimeout(haptic, 140); }
  }
  showCombo();

  // fly out
  const off = { left: [-W * 1.3, 0, -20], right: [W * 1.3, 0, 20], up: [0, -H * 1.1, 0], down: [0, H * 1.1, 0] }[dir] || [0, -H, 0];
  el.style.transition = 'transform .28s cubic-bezier(.4,0,.6,1), opacity .28s';
  el.style.transform = `translate(${off[0]}px, ${off[1]}px) rotate(${off[2]}deg)`;
  el.style.opacity = '0';
  if (nextEl) { nextEl.classList.remove('next'); nextEl.style.transform = 'none'; nextEl.style.opacity = '1'; }
  cur = null; curEl = null;
  setTimeout(() => { el.remove(); render(true); }, 200);

  if (!cfg.demo) scheduleFlush();
  setStatus();
}

function showCombo() {
  const el = $('#combo');
  el.textContent = combo >= 2 ? `×${combo}` : '';
  el.classList.toggle('on', combo >= 2);
  el.style.color = combo >= 25 ? '#ff7ad9' : combo >= 10 ? '#ff8a4d' : '';
  el.classList.remove('pop'); void el.offsetWidth; if (combo >= 2) el.classList.add('pop');
}

function celebrate() {
  const W = innerWidth;
  for (let i = 0; i < 5; i++) setTimeout(() => FX.confetti(W * (0.15 + Math.random() * 0.7), -10, 40), i * 90);
}

/* ---------- gestures ---------- */
let drag = null;
const stage = $('#stage');

stage.addEventListener('pointerdown', (e) => {
  if (!curEl || !$('#sheet').hidden) return;
  const body = curEl.querySelector('.body');
  drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: null,
    body, samples: [[e.clientX, e.clientY, performance.now()]] };
  curEl.style.transition = 'none';
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  if (!drag || !curEl) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  const stepY = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  drag.samples.push([e.clientX, e.clientY, performance.now()]); if (drag.samples.length > 6) drag.samples.shift();

  if (!drag.mode && Math.hypot(dx, dy) > 8) {
    const b = drag.body, vertical = Math.abs(dy) > Math.abs(dx);
    const scrollable = b.scrollHeight > b.clientHeight + 2;
    const canScroll = scrollable && ((dy < 0 && b.scrollTop + b.clientHeight < b.scrollHeight - 1) || (dy > 0 && b.scrollTop > 0));
    drag.mode = vertical && canScroll ? 'scroll' : 'drag';
  }
  if (drag.mode === 'scroll') { drag.body.scrollTop -= stepY; return; }
  if (drag.mode !== 'drag') return;

  const revealed = curEl.classList.contains('revealed');
  const rx = revealed ? dx : dx * 0.25; // before flip, sideways is muted
  curEl.style.transform = `translate(${rx}px, ${dy}px) rotate(${rx * 0.05}deg)`;
  const dir = dirOf(dx, dy);
  const amt = Math.min(1, Math.hypot(dx, dy) / 140);
  const tint = curEl.querySelector('.tint'), lbl = curEl.querySelector('.lbl');
  if (revealed && dir) {
    const ease = EASE[dir];
    tint.style.background = COLOR[ease]; tint.style.opacity = amt * 0.18;
    lbl.style.color = COLOR[ease]; lbl.style.opacity = amt;
    const iv = cur.next && cur.next[ease - 1];
    lbl.textContent = LABEL[ease] + (iv ? ` · ${iv}` : '');
    if (amt > 0.6 && Math.random() < 0.5) FX.spark(e.clientX, e.clientY, COLOR[ease]);
  } else if (!revealed && dy < 0) {
    lbl.textContent = 'reveal'; lbl.style.color = '#fff'; lbl.style.opacity = amt * 0.7; tint.style.opacity = 0;
  } else { tint.style.opacity = 0; lbl.style.opacity = 0; }
});

const endDrag = (e) => {
  if (!drag || !curEl) { drag = null; return; }
  const d = drag; drag = null;
  const dx = d.x - d.x0, dy = d.y - d.y0, dist = Math.hypot(dx, dy);
  const s0 = d.samples[0], s1 = d.samples[d.samples.length - 1];
  const v = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) / Math.max(1, s1[2] - s0[2]);
  const revealed = curEl.classList.contains('revealed');
  const reset = () => {
    if (!curEl) return;
    curEl.style.transition = 'transform .35s cubic-bezier(.2,1.4,.4,1)';
    curEl.style.transform = '';
    curEl.querySelector('.tint').style.opacity = 0; curEl.querySelector('.lbl').style.opacity = 0;
  };
  if (d.mode === 'scroll') return;
  if (!d.mode) { // tap
    if (performance.now() - d.t0 < 400) reveal();
    return reset();
  }
  const dir = dirOf(dx, dy);
  const flung = dist > 90 || (v > 0.55 && dist > 30);
  if (!revealed) { if (flung && dir === 'up') reveal(); return reset(); }
  if (flung && dir) return answer(EASE[dir], dir, d.x, d.y);
  reset();
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

function dirOf(dx, dy) {
  if (Math.hypot(dx, dy) < 24) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
}

// keyboard (desktop testing): space flips, arrows grade
addEventListener('keydown', (e) => {
  if (!$('#sheet').hidden || !curEl) return;
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
  else if (map[e.key]) {
    e.preventDefault();
    if (!curEl.classList.contains('revealed')) { if (map[e.key] === 'up') reveal(); return; }
    answer(EASE[map[e.key]], map[e.key]);
  }
});

/* ---------- haptics & sound ---------- */
const hapEl = $('#hap');
function haptic() {
  if (navigator.vibrate) { navigator.vibrate(10); return; }
  try { hapEl.click(); } catch {} // iOS 18+: toggling a <input switch> produces a system haptic
}
let actx;
function tone(freq, dur, type = 'sine') {
  if (!cfg.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.15);
  } catch {}
}

/* ---------- particles ---------- */
const FX = (() => {
  const cv = $('#fx'), cx = cv.getContext('2d');
  let W, H, dpr, P = [], raf = 0;
  const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener('resize', size);
  const PAL = ['#ffc94d', '#ff8a4d', '#ff5c7a', '#ff7ad9', '#5cc8ff', '#57e39b', '#ffffff'];
  const add = (p) => { if (P.length < 900) P.push(p); if (!raf) raf = requestAnimationFrame(tick); };
  function tick() {
    cx.clearRect(0, 0, W, H);
    cx.globalCompositeOperation = 'lighter';
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= p.decay;
      if (p.life <= 0 || p.y > H + 40) { P.splice(i, 1); continue; }
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      cx.globalAlpha = Math.min(1, p.life * 1.4);
      cx.fillStyle = p.c;
      if (p.kind === 'rect') {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.fillRect(-p.s, -p.s * 0.45, p.s * 2, p.s * 0.9); cx.restore();
      } else {
        cx.beginPath(); cx.arc(p.x, p.y, p.s * (0.4 + p.life * 0.6), 0, 6.283); cx.fill();
      }
    }
    cx.globalAlpha = 1;
    raf = P.length ? requestAnimationFrame(tick) : 0;
    if (!raf) cx.clearRect(0, 0, W, H);
  }
  return {
    burst(x, y, n, color, power = 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, sp = (2 + Math.random() * 7) * power;
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, g: 0.18, drag: 0.94, s: 1.5 + Math.random() * 3,
          life: 1, decay: 0.014 + Math.random() * 0.02, c: Math.random() < 0.3 ? '#fff' : (power > 1.6 && Math.random() < 0.4 ? PAL[i % PAL.length] : color), kind: 'dot', rot: 0, vr: 0 });
      }
    },
    ring(x, y, n, color) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283, sp = 5 + Math.random();
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0, drag: 0.9, s: 1.6, life: 1, decay: 0.035, c: color, kind: 'dot', rot: 0, vr: 0 });
      }
    },
    spark(x, y, color) {
      add({ x, y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, g: 0.05, drag: 0.95, s: 1.5 + Math.random() * 2, life: 0.8, decay: 0.03, c: color, kind: 'dot', rot: 0, vr: 0 });
    },
    fizzle(x, y) {
      for (let i = 0; i < 18; i++) add({ x: x + (Math.random() - 0.5) * 60, y, vx: (Math.random() - 0.5) * 1.5, vy: Math.random() * 2, g: 0.12, drag: 0.97,
        s: 1.5 + Math.random() * 2, life: 0.9, decay: 0.02, c: '#6d6d7a', kind: 'dot', rot: 0, vr: 0 });
    },
    confetti(x, y, n) {
      for (let i = 0; i < n; i++) add({ x, y, vx: (Math.random() - 0.5) * 10, vy: Math.random() * 6 + 2, g: 0.12, drag: 0.985, s: 3 + Math.random() * 3,
        life: 1, decay: 0.006 + Math.random() * 0.006, c: PAL[(Math.random() * PAL.length) | 0], kind: 'rect', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
    },
  };
})();

/* ---------- settings ---------- */
function openSheet(msg, cls) {
  $('#sUrl').value = cfg.url || (/iPhone|iPad|Android/.test(navigator.userAgent) ? '' : 'http://localhost:8765');
  $('#sKey').value = cfg.key; $('#sNew').value = cfg.newLimit; $('#sRev').value = cfg.revLimit;
  $('#sWeb').checked = cfg.ankiweb; $('#sSound').checked = cfg.sound;
  const m = $('#sMsg'); m.textContent = msg || ''; m.className = cls || '';
  $('#sheet').hidden = false;
  loadDecks();
}
async function loadDecks() {
  if (!cfg.url || cfg.demo) return;
  try {
    const names = (await anki('deckNames', {}, 4000)).sort();
    const sel = $('#sDeck');
    sel.innerHTML = '<option value="">All decks</option>' + names.map((n) => `<option></option>`).join('');
    names.forEach((n, i) => { sel.options[i + 1].value = n; sel.options[i + 1].textContent = n.replace(/::/g, ' › '); });
    sel.value = cfg.deck;
  } catch {}
}
$('#gear').onclick = () => openSheet();
$('#status').onclick = () => sync(true);
$('#sheet .scrim').onclick = () => { $('#sheet').hidden = true; };
$('#sSave').onclick = async () => {
  const url = $('#sUrl').value.trim();
  Object.assign(cfg, {
    url, key: $('#sKey').value.trim(), deck: $('#sDeck').value,
    newLimit: Math.max(0, +$('#sNew').value || 0), revLimit: Math.max(1, +$('#sRev').value || 300),
    ankiweb: $('#sWeb').checked, sound: $('#sSound').checked,
  });
  const m = $('#sMsg'); m.className = ''; m.textContent = 'Connecting…';
  const wasDemo = cfg.demo;
  try {
    cfg.demo = false;
    const v = await anki('version', {}, 5000);
    saveCfg();
    m.className = 'ok'; m.textContent = `Connected (AnkiConnect v${v}). Loading cards…`;
    if (wasDemo) { deck = []; queue = []; cur = null; doneCount = 0; await IDB.set('queue', []); }
    await loadDecks();
    await sync(true);
    $('#sheet').hidden = true;
  } catch (e) {
    cfg.demo = wasDemo; saveCfg();
    m.className = 'err';
    m.textContent = location.protocol === 'https:' && url.startsWith('http:') && !/localhost|127\.0\.0\.1/.test(url)
      ? 'iOS blocks plain http from an https page. Use an https URL (e.g. Tailscale Serve).'
      : /localhost|127\.0\.0\.1/.test(url) && /iPhone|iPad|Android/.test(navigator.userAgent)
      ? 'localhost means this phone, not your Mac. Use your Tailscale https://….ts.net address.'
      : `Couldn't reach AnkiConnect: ${e.message || e}. Is Anki open and is this origin in webCorsOriginList?`;
  }
};
$('#sDemo').onclick = () => {
  cfg.demo = true; saveCfg();
  deck = DEMO.map((c, i) => ({ ...c, id: i + 1, deck: 'Demo', isNew: false, next: ['1m', '2d', '4d', '9d'] }));
  queue = []; cur = null; doneCount = 0; total = deck.length; online = false;
  $('#sheet').hidden = true; render(true);
};
$('#refresh').onclick = () => cfg.demo ? $('#sDemo').onclick() : sync(true);

const DEMO = [
  { q: 'Capital of Australia?', a: 'Canberra' },
  { q: 'Big-O of binary search?', a: '<b>O(log n)</b>' },
  { q: 'Who proposed the multi-store model of memory?', a: 'Atkinson &amp; Shiffrin (1968)' },
  { q: 'H₂O is the chemical formula for…', a: 'Water' },
  { q: 'The powerhouse of the cell', a: 'Mitochondria' },
  { q: 'Longest river in the world?', a: 'The Nile (≈6,650 km)<br><small>Amazon is close behind</small>' },
  { q: 'What does HTTP stand for?', a: 'HyperText Transfer Protocol' },
  { q: 'Capacity of short-term memory (Miller)?', a: '7 ± 2 items' },
  { q: 'Derivative of sin(x)?', a: 'cos(x)' },
  { q: 'Smallest prime number?', a: '2' },
  { q: 'Capital of Canada?', a: 'Ottawa' },
  { q: 'A stack is LIFO or FIFO?', a: 'LIFO — last in, first out' },
];

/* ---------- boot ---------- */
(async function boot() {
  deck = (await IDB.get('deck')) || [];
  queue = (await IDB.get('queue')) || [];
  total = deck.length;
  render(true);
  if (cfg.demo) { if (!deck.length) $('#sDemo').onclick(); return setStatus(); }
  if (!cfg.url) {
    // first run on desktop: try localhost silently
    cfg.url = 'http://localhost:8765';
    try { await anki('version', {}, 2500); saveCfg(); } catch { cfg.url = ''; return openSheet('Point this at your AnkiConnect, or try the demo.'); }
  }
  sync(true);
})();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !cfg.demo) sync(Date.now() - lastFetch > 5 * 60e3 || !deck.length);
});
addEventListener('online', () => sync(!deck.length));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
