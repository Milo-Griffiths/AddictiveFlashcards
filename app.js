'use strict';
/* Flow Cards — swipe-through Anki reviews over AnkiConnect.
   Offline-first: the morning's cards are cached in IndexedDB, answers are queued
   locally and pushed with `answerCards` whenever AnkiConnect is reachable.
   The newest answers are held back for UNDO_MS so they can still be undone. */

const $ = (s) => document.querySelector(s);
const EASE = { left: 1, down: 2, up: 3, right: 4 };          // Again, Hard, Good, Easy
const LABEL = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const COLOR = { 1: '#ff5c7a', 2: '#ffa64d', 3: '#57e39b', 4: '#5cc8ff' };
const GOLD = ['#ffd75e', '#ffc94d', '#ffb43b', '#fff1b8', '#ffe08a'];
const UNDO_MS = 12000;
const MOBILE = /iPhone|iPad|Android/.test(navigator.userAgent);

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
  { url: '', key: '', deck: '', newLimit: 20, revLimit: 300, ankiweb: true, sound: true, haptics: true, demo: false, topic: '' },
  LS.get('cfg', {})
);
if (cfg.v !== 2) { cfg.sound = true; cfg.haptics = true; cfg.v = 2; }
const saveCfg = () => LS.set('cfg', cfg);
saveCfg();

/* ---------- state ---------- */
let deck = [];        // remaining cards (cards answered "again" are re-inserted)
let queue = [];       // answers waiting to be pushed: {uid, cardId, ease, t}
let history = [];     // undo stack
let cur = null, curEl = null, nextEl = null;
let total = 0, doneCount = 0, combo = 0;
let online = false, syncing = false, lastFetch = 0, retryAt = 0;
const today = () => new Date().toLocaleDateString('en-CA');
let stats = LS.get('stats', {});
if (stats.day !== today()) stats = { day: today(), reviewed: 0, best: 0, correct: 0 };
const TOPICS = { Architecture: 'Architecture', Haskell: 'Haskell', C: 'C', SoftwareTools: 'Software Tools', Maths: 'Maths', Psychology: 'Psychology', Geography: 'Geography' };
const topicName = (t) => TOPICS[t] || t;
const inTopic = (c) => !cfg.topic || c.topic === cfg.topic;
const view = () => deck.filter(inTopic);
// index in `deck` just before the (n+1)-th card of the current topic, for re-inserting "again" cards
function posAfter(n) {
  let seen = 0;
  for (let i = 0; i < deck.length; i++) if (inTopic(deck[i])) { if (seen === n) return i; seen++; }
  return deck.length;
}
const persist = () => { IDB.set('queue', queue); IDB.set('deck', deck); IDB.set('meta', { doneCount, total, combo }); };

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
  LS.set('decks', decks);
  const roots = cfg.deck ? [cfg.deck] : decks.filter((d) => !d.includes('::'));
  let revCap = cfg.revLimit, newCap = cfg.newLimit;
  try { // respect Anki's own daily limits when available
    const st = Object.values(await anki('getDeckStats', { decks: roots }));
    revCap = Math.min(revCap, st.reduce((s, d) => s + d.review_count + d.learn_count, 0));
    newCap = Math.min(newCap, st.reduce((s, d) => s + d.new_count, 0));
  } catch {}
  const scope = cfg.deck ? `deck:${q(cfg.deck)}` : '';
  const [due, learn, fresh] = await Promise.all([
    anki('findCards', { query: `${scope} is:due -is:suspended -is:buried` }),
    anki('findCards', { query: `${scope} is:learn -is:due -is:suspended -is:buried` }), // learning cards due later today
    newCap > 0 ? anki('findCards', { query: `${scope} is:new -is:suspended -is:buried` }) : [],
  ]);
  const ids = [...new Set([...due.slice(0, Math.max(revCap, 0)), ...learn, ...fresh.slice(0, newCap)])];
  const info = [];
  for (let i = 0; i < ids.length; i += 100) info.push(...await anki('cardsInfo', { cards: ids.slice(i, i + 100) }, 20000));
  // topic tags (Topic::X) live on notes
  const noteIds = [...new Set(info.map((c) => c.note))], topicOf = {};
  for (let i = 0; i < noteIds.length; i += 200) {
    for (const n of await anki('notesInfo', { notes: noteIds.slice(i, i + 200) }, 20000)) {
      const t = (n.tags || []).find((x) => x.startsWith('Topic::'));
      if (t) topicOf[n.noteId] = t.slice(7);
    }
  }
  const ex = await loadExplanations();
  // each deck's learning / relearning steps (minutes), so offline re-shows match Anki's timing
  const steps = {};
  for (const d of new Set(info.map((c) => c.deckName))) {
    try { const k = await anki('getDeckConfig', { deck: d }); steps[d] = [k.new.delays, k.lapse.delays]; } catch {}
  }
  const cards = info.map((c) => {
    const [learnSteps, lapseSteps] = steps[c.deckName] || [[1, 10], [10]];
    const phase = c.type === 0 ? 'new' : c.type === 1 ? 'learn' : c.type === 3 ? 'relearn' : 'review';
    const list = phase === 'relearn' ? lapseSteps : learnSteps;
    const left = (c.left || 0) % 1000;
    return {
    id: c.cardId, note: c.note, deck: c.deckName, isNew: c.type === 0, learn: c.type === 1 || c.type === 3,
    phase, steps: learnSteps, lapse: lapseSteps,
    step: phase === 'learn' || phase === 'relearn' ? Math.max(0, list.length - left) : 0,
    // intraday learning cards (queue 1) carry an epoch-seconds due time
    notBefore: c.queue === 1 && c.due > 1e9 ? Math.max(0, c.due * 1000) : 0,
    topic: topicOf[c.note] || null, ex: ex[c.note] || null,
    q: clean(c.question), a: splitAnswer(c.question, c.answer),
    next: (c.nextReviews || []).map((s) => s.replace(/[⁨⁩]/g, '')),
  }; });
  await inlineMedia(cards);
  // reviews in due order, new cards woven in every ~4th slot
  const revs = cards.filter((c) => !c.isNew), news = cards.filter((c) => c.isNew), out = [];
  while (revs.length || news.length) {
    for (let k = 0; k < 3 && revs.length; k++) out.push(revs.shift());
    if (news.length) out.push(news.shift());
  }
  return out;
}

// Explanations are stored in Anki's media folder as one JSON file ({noteId: html}),
// so they sync with AnkiWeb without changing any note type.
async function loadExplanations() {
  try {
    const b64 = await anki('retrieveMediaFile', { filename: '_flowcards_explanations.json' }, 30000);
    if (!b64) return {};
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return {}; }
}

async function flush(all) {
  if (!queue.length || cfg.demo) return;
  const cutoff = all ? Infinity : Date.now() - UNDO_MS;
  const batch = queue.filter((a) => a.t <= cutoff);
  if (!batch.length) return;
  await anki('answerCards', { answers: batch.map(({ cardId, ease }) => ({ cardId, ease })) }, 20000);
  const sent = new Set(batch.map((a) => a.uid));
  queue = queue.filter((a) => !sent.has(a.uid));
  IDB.set('queue', queue);
  if (cfg.ankiweb && !queue.length) anki('sync', {}, 60000).catch(() => {});
  updateUndo();
}

let flushTimer = 0;
function scheduleFlush() {
  clearTimeout(flushTimer);
  if (!queue.length || cfg.demo) return;
  const oldest = Math.min(...queue.map((a) => a.t));
  const wait = Math.max(500, oldest + UNDO_MS - Date.now() + 200, retryAt - Date.now());
  flushTimer = setTimeout(async () => { await sync(false); scheduleFlush(); }, wait);
}

async function sync(refetch = true, all = false) {
  if (cfg.demo || syncing || !cfg.url) { setStatus(); return; }
  syncing = true; setStatus();
  try {
    await flush(all);
    online = true; retryAt = 0;
    if (refetch) {
      const fresh = await fetchDeck();
      lastFetch = Date.now();
      const pending = new Set(queue.map((a) => a.cardId));
      const keep = cur && fresh.find((c) => c.id === cur.id);
      deck = fresh.filter((c) => (!cur || c.id !== cur.id) && !pending.has(c.id));
      if (cur && keep) deck.unshift(cur);
      if (stats.day !== today()) stats = { day: today(), reviewed: 0, best: 0, correct: 0 };
      doneCount = Math.min(doneCount, stats.reviewed); total = doneCount + deck.length;
      history = []; persist(); render(true);
    }
  } catch (e) {
    online = false; retryAt = Date.now() + 30000;
    console.warn('sync failed', e);
  } finally { syncing = false; setStatus(); updateUndo(); }
}

function setStatus() {
  const el = $('#status'), t = el.querySelector('span');
  el.className = 'pill ' + (syncing ? 'busy' : queue.length ? 'pending' : online || cfg.demo ? 'ok' : '');
  const left = view().length, pre = cfg.topic ? topicName(cfg.topic) + ' · ' : '';
  t.textContent = cfg.demo ? pre + 'demo' : syncing ? 'syncing' : queue.length ? `${queue.length} to sync` : online ? `${pre}${left} left` : (cfg.url ? `offline · ${pre}${left} left` : 'set up');
}

/* ---------- rendering ---------- */
function makeCard(c, isNext) {
  const el = document.createElement('article');
  el.className = 'card' + (isNext ? ' next' : '');
  el.innerHTML = `<div class="lbl"></div>
    <div class="body"><div class="q"></div><div class="a"></div></div>
    <button class="exb" type="button" hidden>Explain</button>
    <div class="foot"><span class="tag"></span><span class="iv"></span></div><div class="tint"></div>`;
  el.querySelector('.q').innerHTML = c.q;
  el.querySelector('.a').innerHTML = c.a;
  el.querySelector('.tag').textContent = (c.topic ? topicName(c.topic) : (c.deck || '').split('::').pop()) + (c.isNew ? ' · new' : c.learn ? ' · learning' : '');
  const b = el.querySelector('.exb');
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); openExplain(c); });
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
  const v = view(), now = Date.now();
  let ready = v.filter((c) => !c.notBefore || c.notBefore <= now);
  if (!ready.length) ready = v.filter((c) => c.notBefore <= now + 20 * 60e3).sort((a, b) => a.notBefore - b.notBefore);
  if (force || !cur) { cur = ready[0] || null; }
  stage.innerHTML = '';
  curEl = nextEl = null;
  $('#done').hidden = !!cur;
  heat();
  if (!cur) { showCombo(); showDone(); updateBar(); setStatus(); return; }
  const nx = ready.find((c) => c !== cur);
  if (nx) { nextEl = makeCard(nx, true); stage.appendChild(nextEl); }
  curEl = makeCard(cur, false); stage.appendChild(curEl);
  fit(curEl);
  $('#hint').hidden = LS.get('hinted', false);
  updateBar(); setStatus();
}

function updateBar() {
  const pct = total ? (doneCount / total) * 100 : 0;
  $('#bar b').style.width = Math.min(100, pct) + '%';
}

function showDone() {
  const waiting = view().filter((c) => c.notBefore > Date.now());
  if (waiting.length) {
    const mins = Math.max(1, Math.ceil((Math.min(...waiting.map((c) => c.notBefore)) - Date.now() - 20 * 60e3) / 60e3));
    $('#refresh').textContent = 'Check for more';
    $('#doneStats').textContent = `${waiting.length} in learning · next one in ${mins} min`;
    return;
  }
  const others = cfg.topic ? view().length === 0 && deck.length : 0;
  $('#refresh').textContent = others ? 'Show all topics' : 'Check for more';
  if (others) { $('#doneStats').textContent = `No ${topicName(cfg.topic)} cards left · ${others} in other topics`; return; }
  $('#doneStats').textContent = stats.reviewed
    ? `${stats.reviewed} reviewed today · ${Math.round((stats.correct / stats.reviewed) * 100)}% recalled · best combo ×${stats.best}`
    : (cfg.url || cfg.demo ? 'Nothing due right now.' : 'Connect to AnkiConnect in settings to start.');
  if (stats.reviewed && !showDone.shown) { showDone.shown = true; celebrate(1); }
}

/* ---------- reveal & answer ---------- */
function reveal() {
  if (!curEl || curEl.classList.contains('revealed')) return;
  curEl.classList.add('revealed', 'flip');
  setTimeout(() => curEl && curEl.classList.remove('flip'), 340);
  revealedUI(curEl, cur);
  const r = curEl.getBoundingClientRect();
  FX.ring(r.left + r.width / 2, r.top + r.height / 2, 26, 'rgba(255,255,255,.9)');
  haptic(1); SFX.reveal();
}

function revealedUI(el, c) {
  fit(el);
  if (c.next && c.next.length === 4) el.querySelector('.iv').textContent = `good · ${c.next[2]}`;
  if (c.ex) el.querySelector('.exb').hidden = false;
}

/* ---------- explanation sheet ---------- */
function openExplain(c) {
  if (!c || !c.ex) return;
  $('#exBody').innerHTML = c.ex;
  $('#exTopic').textContent = c.topic ? topicName(c.topic) : '';
  $('#ex').hidden = false; $('#exPanel').scrollTop = 0;
  haptic(1); SFX.tick();
}
const closeExplain = () => { $('#ex').hidden = true; };
$('#ex .scrim').onclick = closeExplain;
$('#exClose').onclick = closeExplain;

/* ---------- topic picker ---------- */
function openTopics() {
  const counts = {};
  for (const c of deck) if (c.topic) counts[c.topic] = (counts[c.topic] || 0) + 1;
  const list = [['', 'All topics', deck.length], ...Object.keys(TOPICS).filter((t) => counts[t]).map((t) => [t, TOPICS[t], counts[t]])];
  for (const t of Object.keys(counts)) if (!TOPICS[t]) list.push([t, t, counts[t]]);
  const box = $('#topicList'); box.innerHTML = '';
  for (const [t, name, n] of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + ((cfg.topic || '') === t ? ' on' : '');
    b.innerHTML = '<span></span><b></b>';
    b.firstChild.textContent = name; b.lastChild.textContent = n;
    b.onclick = () => setTopic(t);
    box.appendChild(b);
  }
  if (list.length === 1) box.insertAdjacentHTML('beforeend', '<p class="muted">Topics appear once your cards have Topic:: tags.</p>');
  $('#topics').hidden = false;
}
function setTopic(t) {
  cfg.topic = t; saveCfg();
  $('#topics').hidden = true;
  cur = null; render(true); haptic(1);
}
$('#topicBtn').onclick = openTopics;
$('#topics .scrim').onclick = () => { $('#topics').hidden = true; };

let uidSeq = Date.now();
function answer(ease, dir, px, py) {
  if (!cur || !curEl) return;
  const card = cur, el = curEl;
  const h = { uid: ++uidSeq, card: { ...card }, ease, dir, combo, doneCount, stats: { ...stats }, reinserted: null };
  if (!cfg.demo) queue.push({ uid: h.uid, cardId: card.id, ease, t: Date.now() });
  const at = deck.indexOf(card); deck.splice(at < 0 ? 0 : at, 1);
  closeExplain();

  // Follow Anki's learning steps locally (with their real delays) so the day works offline
  // and cards come back exactly when Anki would show them, not sooner or more often.
  const ns = nextStep(card, ease);
  let again = null;
  if (ns) {
    again = { ...card, ...ns, isNew: false, learn: true, next: null, notBefore: Date.now() + ns.wait * 60e3 };
    deck.splice(posAfter(3), 0, again); h.reinserted = again;
  } else doneCount++;

  stats.reviewed++; if (ease > 1) stats.correct++;
  const broke = ease <= 2 && combo >= 3 ? combo : 0;   // Again and Hard both end the streak
  combo = ease > 2 ? combo + 1 : 0;
  stats.best = Math.max(stats.best, combo);
  LS.set('stats', stats); LS.set('hinted', true); $('#hint').hidden = true;
  history.push(h); if (history.length > 30) history.shift();
  persist();

  // feedback
  const W = innerWidth, H = innerHeight;
  const x = px ?? W / 2, y = py ?? H / 2;
  if (ease === 1) {
    FX.shatter(x, y); flash('again'); haptic(2); SFX.again();
    if (broke) comboBreak(broke);
  } else {
    reward(ease, x, y);
    if (broke) comboBreak(broke);
  }
  showCombo();

  // fly out
  const off = OFF(dir);
  el.style.transition = 'transform .28s cubic-bezier(.4,0,.6,1), opacity .28s';
  el.style.transform = `translate(${off[0]}px, ${off[1]}px) rotate(${off[2]}deg)`;
  el.style.opacity = '0';
  if (nextEl) { nextEl.classList.remove('next'); nextEl.style.transform = 'none'; nextEl.style.opacity = '1'; }
  cur = null; curEl = null;
  setTimeout(() => { el.remove(); render(true); }, 200);

  scheduleFlush(); setStatus(); updateUndo();
}
// Anki (v3) learning-step rules. Returns the card's next local state, or null if it leaves today's queue.
function nextStep(card, ease) {
  const phase = card.phase || (card.isNew ? 'new' : card.learn ? 'learn' : 'review');
  const learnSteps = card.steps && card.steps.length ? card.steps : [1, 10];
  const lapseSteps = card.lapse && card.lapse.length ? card.lapse : [10];
  if (phase === 'review') return ease === 1 ? { phase: 'relearn', step: 0, wait: lapseSteps[0] } : null;
  const list = phase === 'relearn' ? lapseSteps : learnSteps;
  const p = phase === 'relearn' ? 'relearn' : 'learn';
  const step = phase === 'new' ? 0 : Math.min(card.step || 0, list.length - 1);
  if (ease === 4) return null;                                        // Easy graduates
  if (ease === 1) return { phase: p, step: 0, wait: list[0] };        // Again: back to the first step
  if (ease === 2) {                                                   // Hard: repeat this step
    const w = step === 0 ? (list.length > 1 ? (list[0] + list[1]) / 2 : list[0] * 1.5) : list[step];
    return { phase: p, step, wait: w };
  }
  return step + 1 < list.length ? { phase: p, step: step + 1, wait: list[step + 1] } : null; // Good: next step or graduate
}

const OFF = (dir) => ({ left: [-innerWidth * 1.3, 0, -20], right: [innerWidth * 1.3, 0, 20], up: [0, -innerHeight * 1.1, 0], down: [0, innerHeight * 1.1, 0] }[dir] || [0, -innerHeight, 0]);

/* Rewards escalate with the combo. Milestones: 5, 10, 15, 20, 25, ... */
function reward(ease, x, y) {
  const c = combo, W = innerWidth, H = innerHeight;
  const power = 1 + Math.min(c, 40) / 18;
  const n = 24 + Math.min(c, 40) * 4;
  FX.burst(x, y, n, COLOR[ease], power, c >= 3 ? 0.25 + Math.min(c, 20) / 40 : 0);
  if (c >= 3) FX.wave(x, y, '#ffd75e', 60 + c * 4, 0.35);
  SFX.good(ease, c);
  haptic(c >= 5 ? 2 : 1);

  if (c && c % 10 === 0) {                // big gold explosion
    const tier = c / 10;
    setTimeout(() => {
      FX.explode(W / 2, H * 0.45, Math.min(tier, 4));
      flash('gold');
      celebrate(tier);
      milestone(`${c} in a row`);
      SFX.milestone(tier); haptic(3);
    }, 120);
  } else if (c >= 5 && c % 5 === 0) {     // medium gold pop
    setTimeout(() => {
      FX.burst(W / 2, H * 0.45, 90, '#ffc94d', 1.8, 1);
      FX.wave(W / 2, H * 0.45, '#ffd75e', 220, 0.8);
      milestone(`×${c}`, true); SFX.milestone(0.5); haptic(2);
    }, 100);
  }
}

function showCombo() {
  const el = $('#combo');
  el.textContent = combo >= 2 ? `×${combo}` : '';
  el.classList.toggle('on', combo >= 2);
  el.style.color = combo >= 25 ? '#ff7ad9' : combo >= 10 ? '#ffd75e' : '';
  el.classList.remove('pop'); void el.offsetWidth; if (combo >= 2) el.classList.add('pop');
  heat();
}
function heat() { // the card border warms up as a streak builds
  document.body.classList.toggle('warm', combo >= 5 && combo < 10);
  document.body.classList.toggle('hot', combo >= 10 && combo < 25);
  document.body.classList.toggle('blaze', combo >= 25);
}
function comboBreak(n) {
  const el = $('#broke');
  el.textContent = `×${n}`;
  el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
}
function milestone(text, small) {
  const el = $('#mile');
  el.textContent = text; el.classList.toggle('small', !!small);
  el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
}
function flash(kind) {
  const el = $('#flash');
  el.className = ''; void el.offsetWidth; el.className = kind;
  clearTimeout(flash.t); flash.t = setTimeout(() => { el.className = ''; }, 950);
}
let toastT = 0;
function toast(text) {
  const el = $('#toast'); el.textContent = text; el.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200);
}
function celebrate(tier = 1) {
  const W = innerWidth, n = 4 + Math.round(tier * 3);
  for (let i = 0; i < n; i++) setTimeout(() => FX.confetti(W * (0.1 + Math.random() * 0.8), -10, 30 + tier * 10), i * 80);
}

/* ---------- undo ---------- */
function canUndo() {
  const h = history[history.length - 1];
  return !!h && (cfg.demo || queue.some((a) => a.uid === h.uid));
}
function updateUndo() { $('#undo').classList.toggle('on', canUndo()); }
setInterval(updateUndo, 1000);
setInterval(() => { if (!cur && view().length && $('#sheet').hidden) render(true); }, 30000);

function undo() {
  const h = history[history.length - 1];
  if (!h) return;
  if (!canUndo()) { toast('Already synced to Anki'); history = []; updateUndo(); return; }
  history.pop();
  queue = queue.filter((a) => a.uid !== h.uid);
  if (h.reinserted) { const i = deck.indexOf(h.reinserted); if (i >= 0) deck.splice(i, 1); }
  deck.unshift(h.card);
  combo = h.combo; doneCount = h.doneCount; stats = h.stats;
  LS.set('stats', stats); persist();
  render(true);
  // fly back in from where it left, already flipped
  if (curEl) {
    curEl.classList.add('revealed'); revealedUI(curEl, cur);
    const off = OFF(h.dir);
    curEl.style.transition = 'none';
    curEl.style.transform = `translate(${off[0]}px, ${off[1]}px) rotate(${off[2]}deg)`;
    void curEl.offsetWidth;
    curEl.style.transition = 'transform .38s cubic-bezier(.2,1.2,.4,1)';
    curEl.style.transform = '';
  }
  showCombo(); setStatus(); updateUndo(); scheduleFlush();
  SFX.undo(); haptic(1);
}
$('#undo').onclick = undo;

/* ---------- gestures ---------- */
let drag = null;
const stage = $('#stage');

stage.addEventListener('pointerdown', (e) => {
  SFX.unlock();
  if (!curEl || !$('#sheet').hidden || !$('#ex').hidden || !$('#topics').hidden) return;
  const body = curEl.querySelector('.body');
  drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: null, armed: false,
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
    tint.style.background = COLOR[ease]; tint.style.opacity = amt * 0.2;
    lbl.style.color = COLOR[ease]; lbl.style.opacity = amt;
    const iv = cur.next && cur.next[ease - 1];
    lbl.textContent = LABEL[ease] + (iv ? ` · ${iv}` : '');
    if (amt > 0.6 && Math.random() < 0.5) FX.spark(e.clientX, e.clientY, COLOR[ease]);
    const armed = Math.hypot(dx, dy) > 90;
    if (armed && !drag.armed) { haptic(1); SFX.tick(); }
    drag.armed = armed;
  } else if (!revealed && dy < 0) {
    lbl.textContent = 'reveal'; lbl.style.color = '#fff'; lbl.style.opacity = amt * 0.7; tint.style.opacity = 0;
  } else { tint.style.opacity = 0; lbl.style.opacity = 0; }
});

const endDrag = () => {
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

// keyboard (desktop testing): space flips, arrows grade, z / backspace undoes
addEventListener('keydown', (e) => {
  if (!$('#ex').hidden) { if (e.key === 'Escape' || e.key === 'e') closeExplain(); return; }
  if (!$('#sheet').hidden || !$('#topics').hidden) return;
  if (e.key === 'e' && cur && curEl && curEl.classList.contains('revealed')) return openExplain(cur);
  if (e.key === 'z' || e.key === 'Backspace') { e.preventDefault(); return undo(); }
  if (!curEl) return;
  const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
  else if (map[e.key]) {
    e.preventDefault();
    if (!curEl.classList.contains('revealed')) { if (map[e.key] === 'up') reveal(); return; }
    answer(EASE[map[e.key]], map[e.key]);
  }
});

/* ---------- haptics ---------- */
// iOS Safari has no vibration API, but toggling an <input type=checkbox switch>
// (iOS 18+) fires the system haptic. Android uses navigator.vibrate.
const hapEl = $('#hap');
function haptic(n = 1) {
  if (!cfg.haptics) return;
  if (navigator.vibrate) { navigator.vibrate(n === 1 ? 12 : n === 2 ? [14, 50, 14] : [18, 45, 18, 45, 30]); return; }
  for (let i = 0; i < n; i++) setTimeout(() => { try { hapEl.click(); } catch {} }, i * 70);
}

/* ---------- sound ---------- */
const SFX = (() => {
  let ac, out;
  const PENTA = [0, 2, 4, 7, 9];
  // C4 pentatonic climbing gently with the streak, capped so it never gets shrill (max ~E5)
  const note = (i) => { i = Math.min(i, 7); return 261.63 * Math.pow(2, (PENTA[i % 5] + 12 * Math.floor(i / 5)) / 12); };
  function ctx() {
    if (!cfg.sound) return null;
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        const comp = ac.createDynamicsCompressor(); out = ac.createGain(); out.gain.value = 0.5;
        out.connect(comp).connect(ac.destination);
      } catch { return null; }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(f, { t = 0, dur = 0.18, type = 'sine', vol = 0.3, to = null, attack = 0.005, filter = null } = {}) {
    const a = ctx(); if (!a) return;
    const s = a.currentTime + t, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, s);
    if (to) o.frequency.exponentialRampToValueAtTime(to, s + dur);
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + attack); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    let node = o;
    if (filter) { const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = filter; node.connect(fl); node = fl; }
    node.connect(g).connect(out); o.start(s); o.stop(s + dur + 0.05);
  }
  return {
    unlock() { ctx(); },
    tick() { tone(900, { dur: 0.03, vol: 0.06 }); },
    reveal() { tone(440, { dur: 0.09, vol: 0.12, to: 587 }); },
    good(ease, c) {
      const i = Math.floor(Math.min(c, 21) / 3), f = note(i);  // steps up every 3 in a row
      if (ease === 2) { tone(f / 2, { dur: 0.22, type: 'triangle', vol: 0.25 }); return; }
      tone(f, { dur: 0.25, type: 'triangle', vol: 0.3 });
      tone(f * 1.5, { dur: 0.18, vol: 0.05, t: 0.01 });
      if (ease === 4) tone(note(i + 2), { dur: 0.25, type: 'triangle', vol: 0.25, t: 0.07 });
    },
    again() {
      tone(220, { dur: 0.35, type: 'sawtooth', vol: 0.22, to: 70, filter: 900 });
      tone(110, { dur: 0.3, vol: 0.35, to: 45 });
    },
    milestone(tier) {
      const base = tier >= 1 ? [0, 2, 4, 5, 7] : [2, 4];
      base.forEach((k, j) => tone(note(k + 2), { t: j * 0.07, dur: 0.45, type: 'triangle', vol: 0.22 }));
      if (tier >= 1) [0, 4, 7].forEach((k) => tone(261.63 * Math.pow(2, k / 12), { t: 0.35, dur: 0.8, type: 'triangle', vol: 0.12 })); // warm C major chord
    },
    undo() { tone(700, { dur: 0.16, vol: 0.12, to: 350 }); },
  };
})();

/* ---------- particles ---------- */
const FX = (() => {
  const cv = $('#fx'), cx = cv.getContext('2d');
  let W, H, dpr, P = [], waves = [], raf = 0;
  const size = () => { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener('resize', size);
  const PAL = ['#ffc94d', '#ff8a4d', '#ff5c7a', '#ff7ad9', '#5cc8ff', '#57e39b', '#ffffff'];
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const add = (p) => { if (P.length < 1400) P.push(Object.assign({ rot: 0, vr: 0, glow: true, kind: 'dot', drag: 0.94, g: 0.18 }, p)); kick(); };
  function tick() {
    cx.clearRect(0, 0, W, H);
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i]; w.t += 1 / 60;
      const k = w.t / w.dur; if (k >= 1) { waves.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      cx.globalCompositeOperation = 'lighter';
      cx.globalAlpha = (1 - k) * 0.8; cx.strokeStyle = w.c; cx.lineWidth = 2 + (1 - k) * 8;
      cx.beginPath(); cx.arc(w.x, w.y, w.r * e, 0, 6.283); cx.stroke();
    }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= p.decay;
      if (p.life <= 0 || p.y > H + 40) { P.splice(i, 1); continue; }
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      cx.globalCompositeOperation = p.glow ? 'lighter' : 'source-over';
      cx.globalAlpha = Math.min(1, p.life * 1.4);
      cx.fillStyle = p.c;
      if (p.kind === 'rect' || p.kind === 'shard') {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
        if (p.kind === 'shard') { cx.beginPath(); cx.moveTo(-p.s, -p.s * 0.6); cx.lineTo(p.s, -p.s * 0.2); cx.lineTo(-p.s * 0.2, p.s); cx.closePath(); cx.fill(); }
        else cx.fillRect(-p.s, -p.s * 0.45, p.s * 2, p.s * 0.9);
        cx.restore();
      } else if (p.kind === 'star') {
        const r = p.s * (0.5 + p.life * 0.5) * (0.7 + 0.3 * Math.sin(p.rot * 4));
        cx.fillRect(p.x - r * 2, p.y - 0.6, r * 4, 1.2); cx.fillRect(p.x - 0.6, p.y - r * 2, 1.2, r * 4);
        cx.beginPath(); cx.arc(p.x, p.y, r * 0.6, 0, 6.283); cx.fill();
      } else {
        cx.beginPath(); cx.arc(p.x, p.y, p.s * (0.4 + p.life * 0.6), 0, 6.283); cx.fill();
      }
    }
    cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
    raf = P.length || waves.length ? requestAnimationFrame(tick) : 0;
    if (!raf) cx.clearRect(0, 0, W, H);
  }
  return {
    // celebratory burst; `gold` (0..1) mixes in gold glitter as the streak grows
    burst(x, y, n, color, power = 1, gold = 0) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, sp = (2 + Math.random() * 7) * power;
        const g = Math.random() < gold;
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, s: g ? 2 + Math.random() * 2 : 1.5 + Math.random() * 3,
          life: 1, decay: 0.012 + Math.random() * 0.02, c: g ? pick(GOLD) : Math.random() < 0.25 ? '#fff' : color,
          kind: g && Math.random() < 0.4 ? 'star' : 'dot', vr: 0.2 });
      }
    },
    ring(x, y, n, color) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283, sp = 5 + Math.random();
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0, drag: 0.9, s: 1.6, life: 1, decay: 0.035, c: color });
      }
    },
    wave(x, y, c, r, dur) { waves.push({ x, y, c, r, dur, t: 0 }); kick(); },
    spark(x, y, color) {
      add({ x, y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, g: 0.05, drag: 0.95, s: 1.5 + Math.random() * 2, life: 0.8, decay: 0.03, c: color });
    },
    // "again": dull red/grey shards that crack off and drop heavily — no glow
    shatter(x, y) {
      const cols = ['#7a2a38', '#5a2430', '#4a4a55', '#3a3a44', '#ff5c7a'];
      for (let i = 0; i < 34; i++) {
        const a = Math.PI + (Math.random() - 0.5) * 2.4; // mostly sideways/down, not a radial firework
        const sp = 1 + Math.random() * 3.5;
        add({ x: x + (Math.random() - 0.5) * 40, y: y + (Math.random() - 0.5) * 40,
          vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1), vy: -Math.random() * 1.5,
          g: 0.42, drag: 0.985, s: 3 + Math.random() * 5, life: 1, decay: 0.012, c: cols[i % cols.length],
          kind: 'shard', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.25, glow: false });
      }
      for (let i = 0; i < 14; i++) add({ x: x + (Math.random() - 0.5) * 80, y, vx: (Math.random() - 0.5) * 0.6, vy: 0.5 + Math.random(),
        g: 0.03, drag: 0.98, s: 6 + Math.random() * 8, life: 0.6, decay: 0.012, c: 'rgba(60,60,70,.35)', glow: false }); // smoke
    },
    // 10-in-a-row: big gold explosion with shockwaves
    explode(x, y, tier = 1) {
      const n = 160 + tier * 70, sp0 = 6 + tier * 1.5;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, sp = Math.random() * sp0 + 2;
        add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.08, drag: 0.955, s: 1.5 + Math.random() * 3.5,
          life: 1, decay: 0.006 + Math.random() * 0.012, c: tier >= 2 && Math.random() < 0.3 ? pick(PAL) : pick(GOLD),
          kind: Math.random() < 0.3 ? 'star' : 'dot', vr: 0.3 });
      }
      for (let k = 0; k < 2 + tier; k++) setTimeout(() => this.wave(x, y, k % 2 ? '#fff1b8' : '#ffc94d', Math.max(W, H) * (0.5 + k * 0.15), 0.9), k * 110);
      setTimeout(() => { // glittering embers drifting down
        for (let i = 0; i < 60 * tier; i++) add({ x: Math.random() * W, y: -10 - Math.random() * 200, vx: (Math.random() - 0.5), vy: 1 + Math.random() * 2,
          g: 0.02, drag: 0.99, s: 1 + Math.random() * 2, life: 1, decay: 0.004, c: pick(GOLD), kind: 'star', vr: 0.2 });
      }, 250);
    },
    confetti(x, y, n) {
      for (let i = 0; i < n; i++) add({ x, y, vx: (Math.random() - 0.5) * 10, vy: Math.random() * 6 + 2, g: 0.12, drag: 0.985, s: 3 + Math.random() * 3,
        life: 1, decay: 0.006 + Math.random() * 0.006, c: pick(PAL), kind: 'rect', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
    },
  };
})();

/* ---------- settings ---------- */
function fillDecks(names) {
  const sel = $('#sDeck');
  const list = [...new Set([...(names || []), ...(cfg.deck ? [cfg.deck] : [])])].sort();
  sel.innerHTML = '<option value="">All decks</option>' + list.map(() => '<option></option>').join('');
  list.forEach((n, i) => { sel.options[i + 1].value = n; sel.options[i + 1].textContent = n.replace(/::/g, ' › '); });
  sel.value = cfg.deck;
}
function openSheet(msg, cls) {
  $('#sUrl').value = cfg.url || (MOBILE ? '' : 'http://localhost:8765');
  $('#sKey').value = cfg.key; $('#sNew').value = cfg.newLimit; $('#sRev').value = cfg.revLimit;
  $('#sWeb').checked = cfg.ankiweb; $('#sSound').checked = cfg.sound; $('#sHap').checked = cfg.haptics;
  const m = $('#sMsg'); m.textContent = msg || ''; m.className = cls || '';
  fillDecks(LS.get('decks', []));
  $('#sheet').hidden = false;
  if (cfg.url && !cfg.demo) anki('deckNames', {}, 4000).then((d) => { LS.set('decks', d); fillDecks(d); }).catch(() => {});
}
function closeSheet() { $('#sheet').hidden = true; }
$('#gear').onclick = () => openSheet();
$('#status').onclick = () => sync(true, true);
$('#sheet .scrim').onclick = closeSheet;
$('#sClose').onclick = closeSheet;
// instant-apply toggles, no connection needed
$('#sSound').onchange = (e) => { cfg.sound = e.target.checked; saveCfg(); if (cfg.sound) SFX.good(3, 2); };
$('#sHap').onchange = (e) => { cfg.haptics = e.target.checked; saveCfg(); haptic(1); };
$('#sWeb').onchange = (e) => { cfg.ankiweb = e.target.checked; saveCfg(); };

$('#sSave').onclick = async () => {
  const url = $('#sUrl').value.trim();
  const deckChanged = cfg.deck !== $('#sDeck').value || cfg.newLimit !== Math.max(0, +$('#sNew').value || 0);
  Object.assign(cfg, {
    url, key: $('#sKey').value.trim(), deck: $('#sDeck').value,
    newLimit: Math.max(0, +$('#sNew').value || 0), revLimit: Math.max(1, +$('#sRev').value || 300),
  });
  const wasDemo = cfg.demo;
  cfg.demo = false; saveCfg();       // settings are always saved, even offline
  const m = $('#sMsg'); m.className = ''; m.textContent = 'Connecting…';
  try {
    const v = await anki('version', {}, 5000);
    m.className = 'ok'; m.textContent = `Connected (AnkiConnect v${v}). Loading cards…`;
    if (wasDemo) { deck = []; queue = []; history = []; cur = null; doneCount = 0; IDB.set('queue', []); }
    await sync(true, true);
    closeSheet();
  } catch (e) {
    if (wasDemo) { cfg.demo = true; saveCfg(); }
    m.className = 'err';
    m.textContent = 'Saved. ' + (location.protocol === 'https:' && url.startsWith('http:') && !/localhost|127\.0\.0\.1/.test(url)
      ? 'iOS blocks plain http from an https page. Use an https URL (e.g. Tailscale Serve).'
      : /localhost|127\.0\.0\.1/.test(url) && MOBILE
      ? 'localhost means this phone, not your Mac. Use your Tailscale https://….ts.net address.'
      : `Can't reach Anki right now${deckChanged ? '' : ''} — you can keep reviewing cached cards; answers sync when it's back.`);
  }
};
$('#sDemo').onclick = () => {
  cfg.demo = true; saveCfg();
  deck = DEMO.map((c, i) => ({ topic: null, ex: null, ...c, id: i + 1, deck: 'Demo', isNew: false, next: ['1m', '2d', '4d', '9d'] }));
  queue = []; history = []; cur = null; doneCount = 0; combo = 0; total = deck.length; online = false; showDone.shown = false;
  closeSheet(); render(true); showCombo(); updateUndo();
};
$('#refresh').onclick = () => (cfg.topic && deck.length) ? setTopic('') : cfg.demo ? $('#sDemo').onclick() : sync(true, true);

const DEMO = [
  { q: 'Capital of Australia?', a: 'Canberra', topic: 'Geography' },
  { q: 'Big-O of binary search?', a: '<b>O(log n)</b>', topic: 'C', ex: "<p>Each comparison <b>halves</b> the part of the array still in play: n → n/2 → n/4 → … → 1. The number of halvings is log₂ n.</p><p>For a million items that's about 20 steps.</p><p><b>Requirement:</b> the array must already be sorted.</p>" },
  { q: 'Who proposed the multi-store model of memory?', a: 'Atkinson &amp; Shiffrin (1968)', topic: 'Psychology' },
  { q: 'H₂O is the chemical formula for…', a: 'Water' },
  { q: 'The powerhouse of the cell', a: 'Mitochondria' },
  { q: 'Longest river in the world?', a: 'The Nile (≈6,650 km)<br><small>Amazon is close behind</small>', topic: 'Geography' },
  { q: 'What does HTTP stand for?', a: 'HyperText Transfer Protocol', topic: 'SoftwareTools' },
  { q: 'Capacity of short-term memory (Miller)?', a: '7 ± 2 items', topic: 'Psychology' },
  { q: 'Derivative of sin(x)?', a: 'cos(x)', topic: 'Maths' },
  { q: 'Smallest prime number?', a: '2', topic: 'Maths' },
  { q: 'Capital of Canada?', a: 'Ottawa', topic: 'Geography' },
  { q: 'A stack is LIFO or FIFO?', a: 'LIFO — last in, first out', topic: 'C', ex: '<p><b>LIFO</b>: last in, first out, like a stack of plates. You add to the top and take from the top.</p><p>A <b>queue</b> is the FIFO one, like a line at a shop.</p>' },
  { q: 'Speed of light (approx.)?', a: '3 × 10⁸ m/s' },
  { q: 'Who wrote "1984"?', a: 'George Orwell' },
  { q: 'Binary for 10?', a: '1010', topic: 'Architecture' },
  { q: 'Largest planet?', a: 'Jupiter' },
  { q: 'Capital of Japan?', a: 'Tokyo', topic: 'Geography' },
  { q: 'What is a closure?', a: 'A function bundled with references to its surrounding scope', topic: 'Haskell' },
  { q: 'Milgram studied…', a: 'Obedience to authority', topic: 'Psychology' },
  { q: 'Chemical symbol for gold?', a: 'Au' },
];

/* ---------- boot ---------- */
(async function boot() {
  deck = (await IDB.get('deck')) || [];
  queue = (await IDB.get('queue')) || [];
  const meta = (await IDB.get('meta')) || {};
  doneCount = meta.doneCount || 0; total = meta.total || deck.length; combo = meta.combo || 0;
  if (stats.day !== (LS.get('stats', {}).day)) { doneCount = 0; total = deck.length; }
  render(true); showCombo();
  if (cfg.demo) { if (!deck.length) $('#sDemo').onclick(); return setStatus(); }
  if (!cfg.url) {
    if (!MOBILE) { // first run on desktop: try localhost silently
      cfg.url = 'http://localhost:8765';
      try { await anki('version', {}, 2500); saveCfg(); return sync(true, true); } catch { cfg.url = ''; }
    }
    return openSheet('Point this at your AnkiConnect, or try the demo.');
  }
  sync(true, true);
})();

document.addEventListener('visibilitychange', () => {
  if (cfg.demo) return;
  if (document.visibilityState === 'visible') sync(Date.now() - lastFetch > 5 * 60e3 || !deck.length);
  else { persist(); if (queue.length) flush(true).catch(() => {}); }  // leaving the app: push everything
});
addEventListener('online', () => sync(!deck.length));
setInterval(() => { if (queue.length && document.visibilityState === 'visible' && Date.now() > retryAt) sync(false); }, 60000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
