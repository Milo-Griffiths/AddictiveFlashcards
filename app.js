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
  { url: '', key: '', deck: '', newLimit: 20, revLimit: 300, ankiweb: true, sound: true, haptics: true, demo: false, topic: '',
    autoEx: 'hard', exSkipRead: true, pTopics: [], pSize: 50, pNew: false, pMode: 'random', mixNew: true, exams: {}, lecture: '', pLectures: [] },
  LS.get('cfg', {})
);
if (cfg.v !== 2) { cfg.sound = true; cfg.haptics = true; cfg.v = 2; }
const saveCfg = () => LS.set('cfg', cfg);
saveCfg();

/* ---------- state ---------- */
let deck = [];        // remaining cards (cards answered "again" are re-inserted)
let queue = [];       // answers waiting to be pushed: {uid, cardId, ease, t}
let tagQueue = [];    // flags waiting to be pushed as note tags: {note, on, tag} (no tag = bad explanation)
// Cards for the coming days, downloaded ahead so you can study for a week without reaching Anki.
// Each has `day` (the Anki day it's released on). `repeat` cards are the app's own re-showing of a card you
// already answered offline: their answers stay on the phone, since Anki only takes the first one (see answer()).
let ahead = [];
// the week ahead can be a few MB (images are inlined), so it's saved a moment after it changes rather than on
// every answer, and straight away when the app is hidden
let aheadT = 0;
const saveAhead = (now) => { clearTimeout(aheadT); if (now === true) IDB.set('ahead', ahead); else aheadT = setTimeout(() => IDB.set('ahead', ahead), 1500); };
const AHEAD = 6;                                               // today + 6 = a week
const ankiDay = (ms = Date.now()) => new Date(ms - 4 * 3600e3).toLocaleDateString('en-CA');   // Anki's day starts at 4am
const dayAfter = (k, n) => { const d = new Date(k + 'T12:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
// days in one of Anki's interval labels ("10m", "3d", "1.5mo"…); 0 for anything due again today
function labelDays(s) {
  const m = /([\d.]+)\s*(m|h|d|w|mo|y)\b/.exec(s || '');
  if (!m) return 0;
  return Math.round(+m[1] * ({ m: 0, h: 0, d: 1, w: 7, mo: 30, y: 365 }[m[2]]));
}
let practice = null;  // practice session: {topics, stats, saved: review state while practising}
let exAll = null;     // last downloaded explanations file {noteId: html}
const BAD_TAG = 'FlowCards::BadExplanation';
// Card reports (the flag on a revealed card). Each is a note tag, so they can all be found in Anki later,
// e.g. tag:FlowCards::Report::* in the browser. "Bad explanation" reuses the explanation sheet's flag.
const REPORTS = {
  answer: ['Wrong answer', 'FlowCards::Report::WrongAnswer'],
  question: ['Unclear question', 'FlowCards::Report::UnclearQuestion'],
  image: ['Confusing image', 'FlowCards::Report::ConfusingImage'],
};
let history = [];     // undo stack
let cur = null, curEl = null, nextEl = null;
let total = 0, doneCount = 0, combo = 0;
let online = false, syncing = false, lastFetch = 0, retryAt = 0;
const today = () => new Date().toLocaleDateString('en-CA');
let stats = LS.get('stats', {});
let records = LS.get('records', {});
// Anki logs 0 s for answers sent through AnkiConnect, so time spent here is kept on the phone instead:
// {ankiDay: [ms, answers]}. Each answer counts the time the card was on screen, capped at 60 s like Anki.
let appTime = LS.get('appTime', {}), shownAt = Date.now();   // all-time bests (best combo) and goals already celebrated
if (stats.day !== today()) stats = { day: today(), reviewed: 0, best: 0, correct: 0 };
const TOPICS = { Architecture: 'Architecture', Haskell: 'Haskell', C: 'C', SoftwareTools: 'Software Tools', Maths: 'Maths', Psychology: 'Psychology', Geography: 'Geography' };
const topicName = (t) => TOPICS[t] || t;
// Lectures come from note tags Lecture::<Topic>::<NN>_<Title>, e.g. Lecture::C::11_Pointers; a card keeps
// the part after "Lecture::" (C::11_Pointers) as `lec`.
const lecNum = (k) => { const m = /::(\d+)_/.exec(k || ''); return m ? +m[1] : 999; };
const lecTitle = (k) => (k || '').split('::').pop().replace(/^\d+_/, '').replace(/_/g, ' ');
const lecName = (k) => (lecNum(k) < 999 ? `${lecNum(k)} · ` : '') + lecTitle(k);
const byLec = (a, b) => lecNum(a) - lecNum(b) || a.localeCompare(b);
const inTopic = (c) => !!practice || ((!cfg.topic || c.topic === cfg.topic) && (!cfg.lecture || c.lec === cfg.lecture));
const view = () => deck.filter(inTopic);
// index in `deck` just before the (n+1)-th card of the current topic, for re-inserting "again" cards
function posAfter(n) {
  let seen = 0;
  for (let i = 0; i < deck.length; i++) if (inTopic(deck[i])) { if (seen === n) return i; seen++; }
  return deck.length;
}
// While practising, the review session is parked in practice.saved; only that is ever saved as "the deck".
const persist = () => {
  const r = practice ? practice.saved : { deck, doneCount, total, combo };
  IDB.set('queue', queue); IDB.set('tags', tagQueue);
  IDB.set('deck', r.deck); IDB.set('meta', { doneCount: r.doneCount, total: r.total, combo: r.combo });
};

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

/* ---------- exam dates ---------- */
// Topics with an exam get enough new cards each day for every card to have been seen EXAM_BUFFER days
// before it (so there's time left to review). Those cards come first and may go over the daily new limit.
const EXAM_BUFFER = 5;
const EXAM_MAX = 80;                                           // never more new cards than this per topic per day
const daysUntil = (iso) => Math.round((new Date(iso + 'T12:00') - new Date(new Date().toLocaleDateString('en-CA') + 'T12:00')) / 864e5);
function examPace(unseen, introducedToday, days) {
  if (days < 0 || !(unseen + introducedToday)) return 0;
  const left = Math.max(1, days - EXAM_BUFFER);
  return Math.min(EXAM_MAX, Math.max(0, Math.ceil((unseen + introducedToday) / left) - introducedToday));
}
const activeExams = () => Object.entries(cfg.exams || {}).filter(([, d]) => d && daysUntil(d) >= 0).sort((a, b) => a[1].localeCompare(b[1]));
const resIds = (r) => { const v = r && r.result !== undefined ? r.result : r; return Array.isArray(v) ? v : []; };   // one result of a `multi`

// Today's new cards. Anki hands them out in the order they were added, so a deck imported topic by topic
// gives you a whole day of one topic. With "Mix topics" on, deal them round-robin across Topic:: tags
// instead (each topic still in its own added order), so the day's quota is spread over every topic.
// Topics with an exam date (Stats → Topics) go first: enough of their new cards to see them all before the exam,
// even if that goes over the daily limit. The rest of the day's quota is then filled as usual.
async function pickNew(scope, cap, days = 1) {
  const base = `${scope} is:new -is:suspended -is:buried`;
  const exam = await examNew(scope, base, days);
  const rest = await pickNewRest(base, cap - exam.length, new Set(exam));
  return [...exam, ...rest];
}
async function examNew(scope, base, days = 1) {
  const ex = activeExams();
  if (!ex.length) return [];
  try {
    const res = await anki('multi', { actions: ex.flatMap(([t]) => [
      { action: 'findCards', params: { query: `${base} tag:${q('Topic::' + t)}` } },
      { action: 'findCards', params: { query: `${scope} -is:suspended tag:${q('Topic::' + t)} introduced:1` } },
    ]) }, 15000);
    const out = [];
    ex.forEach(([, date], i) => {
      const fresh = resIds(res[i * 2]), intro = resIds(res[i * 2 + 1]);
      out.push(...fresh.slice(0, examPace(fresh.length, intro.length, daysUntil(date)) * days));
    });
    return out;
  } catch { return []; }
}
async function pickNewRest(base, cap, skip) {
  if (cap <= 0) return [];
  const all = (await anki('findCards', { query: base })).filter((id) => !skip.has(id));
  if (!cfg.mixNew || all.length <= cap) return all.slice(0, cap);
  try {
    const topics = (await anki('getTags', {}, 5000)).filter((t) => /^Topic::[^:]+$/.test(t));
    if (topics.length < 2) return all.slice(0, cap);
    const res = await anki('multi', { actions: topics.map((t) => ({ action: 'findCards', params: { query: `${base} tag:${q(t)}` } })) }, 15000);
    const seen = new Set(), groups = [];
    for (const r of res) {
      const ids = r && (r.result !== undefined ? r.result : r);
      if (!Array.isArray(ids)) continue;
      const g = ids.filter((id) => !seen.has(id)); g.forEach((id) => seen.add(id));
      if (g.length) groups.push(g);
    }
    const rest = all.filter((id) => !seen.has(id));          // cards with no topic make a group of their own
    if (rest.length) groups.push(rest);
    groups.sort((a, b) => a[0] - b[0]);                       // stable: topics you added first go first
    const out = [];
    for (let i = 0; out.length < cap && groups.some((g) => i < g.length); i++) {
      for (const g of groups) if (i < g.length && out.length < cap) out.push(g[i]);
    }
    return out;
  } catch { return all.slice(0, cap); }
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
    pickNew(scope, newCap),
  ]);
  const ids = [...new Set([...due.slice(0, Math.max(revCap, 0)), ...learn, ...fresh])];
  // the coming week: the reviews Anki has due on each day, and each day's share of new cards
  const have = new Set(ids), dayOf = new Map(), today = ankiDay();
  try {
    const live = `${scope} -is:suspended -is:buried`;
    const res = await anki('multi', { actions: Array.from({ length: AHEAD }, (_, i) => ({ action: 'findCards', params: { query: `${live} prop:due=${i + 1}` } })) }, 15000);
    res.forEach((r, i) => { for (const id of resIds(r)) if (!have.has(id) && !dayOf.has(id)) dayOf.set(id, i + 1); });
    const later = (await pickNew(scope, fresh.length + AHEAD * cfg.newLimit, AHEAD + 1)).filter((id) => !have.has(id) && !dayOf.has(id));
    const per = Math.max(1, Math.ceil(later.length / AHEAD));
    later.forEach((id, j) => dayOf.set(id, Math.min(AHEAD, 1 + Math.floor(j / per))));
  } catch (e) { console.warn('could not fetch the week ahead', e); }
  const info = await cardsInfo([...ids, ...dayOf.keys()]);
  exAll = await loadExplanations();
  IDB.set('ex', exAll);
  // each deck's learning / relearning steps (minutes), so offline re-shows match Anki's timing
  const steps = {};
  for (const d of new Set(info.map((c) => c.deckName))) {
    try { const k = await anki('getDeckConfig', { deck: d }); steps[d] = [k.new.delays, k.lapse.delays]; } catch {}
  }
  const cards = await buildCards(info, exAll, (c) => {
    const [learnSteps, lapseSteps] = steps[c.deckName] || [[1, 10], [10]];
    const phase = c.type === 0 ? 'new' : c.type === 1 ? 'learn' : c.type === 3 ? 'relearn' : 'review';
    const list = phase === 'relearn' ? lapseSteps : learnSteps;
    const left = (c.left || 0) % 1000;
    return {
      phase, steps: learnSteps, lapse: lapseSteps,
      step: phase === 'learn' || phase === 'relearn' ? Math.max(0, list.length - left) : 0,
      // intraday learning cards (queue 1) carry an epoch-seconds due time
      notBefore: c.queue === 1 && c.due > 1e9 ? Math.max(0, c.due * 1000) : 0,
      ...(dayOf.has(c.cardId) ? { day: dayAfter(today, dayOf.get(c.cardId)), notBefore: 0 } : {}),
    };
  });
  return { today: weave(cards.filter((c) => !c.day)), ahead: cards.filter((c) => c.day) };
}
// reviews in due order, new cards woven in every ~4th slot
function weave(cards) {
  const revs = cards.filter((c) => !c.isNew), news = cards.filter((c) => c.isNew), out = [];
  while (revs.length || news.length) {
    for (let k = 0; k < 3 && revs.length; k++) out.push(revs.shift());
    if (news.length) out.push(news.shift());
  }
  return out;
}
// A new day has started: move its downloaded cards into today's deck (or the parked one while practising).
function releaseAhead() {
  const t = ankiDay(), due = ahead.filter((c) => c.day <= t);
  if (!due.length) return false;
  ahead = ahead.filter((c) => c.day > t);
  const into = practice ? practice.saved : null, list = into ? into.deck : deck, have = new Set(list.map((c) => c.id));
  const add = weave(due.filter((c) => !have.has(c.id)).map((c) => ({ ...c, day: undefined })));
  list.push(...add);
  if (into) into.total += add.length; else total += add.length;
  persist(); saveAhead();
  return add.length > 0;
}

async function cardsInfo(ids) {
  const info = [];
  for (let i = 0; i < ids.length; i += 100) info.push(...await anki('cardsInfo', { cards: ids.slice(i, i + 100) }, 20000));
  return info;
}

// Turns AnkiConnect cardsInfo rows into our card objects (topic + flag from note tags, explanation, inlined images).
async function buildCards(info, ex, extra = () => ({})) {
  const noteIds = [...new Set(info.map((c) => c.note))], topicOf = {}, lecOf = {}, bad = new Set(), reps = {};
  for (let i = 0; i < noteIds.length; i += 200) {
    for (const n of await anki('notesInfo', { notes: noteIds.slice(i, i + 200) }, 20000)) {
      const tags = n.tags || [];
      const t = tags.find((x) => x.startsWith('Topic::'));
      if (t) topicOf[n.noteId] = t.slice(7);
      const l = tags.find((x) => x.startsWith('Lecture::'));
      if (l) lecOf[n.noteId] = l.slice(9);
      if (tags.some((x) => x.toLowerCase() === BAD_TAG.toLowerCase())) bad.add(n.noteId);
      const lower = tags.map((x) => x.toLowerCase());
      reps[n.noteId] = Object.keys(REPORTS).filter((k) => lower.includes(REPORTS[k][1].toLowerCase()));
    }
  }
  // flags still waiting to be sent win over what Anki says
  for (const f of tagQueue) {
    if (!f.tag || f.tag === BAD_TAG) { f.on ? bad.add(f.note) : bad.delete(f.note); continue; }
    const k = Object.keys(REPORTS).find((x) => REPORTS[x][1] === f.tag); if (!k) continue;
    const r = new Set(reps[f.note] || []); f.on ? r.add(k) : r.delete(k); reps[f.note] = [...r];
  }
  const cards = info.map((c) => ({
    id: c.cardId, note: c.note, deck: c.deckName, isNew: c.type === 0, learn: c.type === 1 || c.type === 3,
    phase: 'review', notBefore: 0,
    topic: topicOf[c.note] || null, ex: (ex || {})[c.note] || null, bad: bad.has(c.note), reports: reps[c.note] || [], lec: lecOf[c.note] || null,
    q: clean(c.question), a: splitAnswer(c.question, c.answer),
    next: (c.nextReviews || []).map((s) => s.replace(/[⁨⁩]/g, '')),
    ...extra(c),
  }));
  await inlineMedia(cards);
  return cards;
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

// Flags become note tags in Anki (bad explanation, card reports), so a later batch can find them by tag.
async function flushTags() {
  if (!tagQueue.length || cfg.demo) return;
  const batch = tagQueue.slice(), last = new Map();
  for (const f of batch) if (f.note) last.set((f.tag || BAD_TAG) + '\n' + f.note, f.on);   // only the final state per tag and note matters
  const byTag = {};
  for (const [k, v] of last) { const [tag, note] = k.split('\n'); (byTag[tag] = byTag[tag] || { on: [], off: [] })[v ? 'on' : 'off'].push(+note); }
  for (const [tag, { on, off }] of Object.entries(byTag)) {
    if (on.length) await anki('addTags', { notes: on, tags: tag });
    if (off.length) await anki('removeTags', { notes: off, tags: tag });
  }
  tagQueue = tagQueue.slice(batch.length);
  IDB.set('tags', tagQueue);
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
    await flushTags();
    online = true; retryAt = 0;
    if (refetch) {
      const got = await fetchDeck(), fresh = got.today;
      lastFetch = Date.now();
      Search.build();   // refresh the offline search index in the background (at most every 12 hours)
      const pending = new Set(queue.map((a) => a.cardId));
      ahead = got.ahead.filter((c) => !pending.has(c.id)); saveAhead();   // Anki's own schedule replaces any offline repeats
      if (stats.day !== today()) stats = { day: today(), reviewed: 0, best: 0, correct: 0 };
      if (practice) { // refresh the parked review session; leave the practice deck alone
        const s = practice.saved;
        s.deck = fresh.filter((c) => !pending.has(c.id)); s.cur = null; s.history = [];
        s.doneCount = Math.min(s.doneCount, stats.reviewed); s.total = s.doneCount + s.deck.length;
        persist();
      } else {
        const keep = cur && fresh.find((c) => c.id === cur.id);
        deck = fresh.filter((c) => (!cur || c.id !== cur.id) && !pending.has(c.id));
        if (cur && keep) deck.unshift(cur);
        doneCount = Math.min(doneCount, stats.reviewed); total = doneCount + deck.length;
        history = []; persist(); render(true);
      }
    }
  } catch (e) {
    online = false; retryAt = Date.now() + 30000;
    console.warn('sync failed', e);
  } finally { syncing = false; setStatus(); updateUndo(); }
}

function setStatus() {
  const el = $('#status'), t = el.querySelector('.n'), st = el.querySelector('.st');
  const waiting = queue.length + tagQueue.length;
  el.className = 'pill ' + (syncing ? 'busy' : waiting ? 'pending' : online || cfg.demo ? 'ok' : '') + (practice ? ' practice' : '');
  const left = view().length;
  // the count of cards left always comes first; sync state is secondary (the dot colour shows it too)
  // (no "syncing" word: the dot blinks blue while it syncs, and the extra text crowded the header)
  // waiting answers show as "↑3" (3 waiting to upload) so it fits beside a long topic name on a phone
  const state = cfg.demo ? 'demo' : waiting ? `↑${waiting}` : online || syncing ? '' : 'offline';
  t.textContent = !cfg.url && !cfg.demo ? 'Set up' : `${left} left`;
  st.textContent = !cfg.url && !cfg.demo ? '' : state ? `· ${state}` : '';
  el.setAttribute('aria-label', `${left} cards left` + (waiting ? `, ${waiting} waiting to sync` : '') + '. Tap to sync now.');
  // the topic / practice button says what you're looking at
  const b = $('#topicBtn');
  $('#topicLbl').textContent = practice ? 'Practice' : cfg.topic ? topicName(cfg.topic) + (cfg.lecture ? ` · ${lecNum(cfg.lecture) < 999 ? 'L' + lecNum(cfg.lecture) : lecTitle(cfg.lecture)}` : '') : 'All topics';
  b.className = 'tbtn' + (practice ? ' practice' : cfg.topic ? ' topic' : '');
  fitHeader();
}
// The cards-left count never shrinks. If the header is too narrow, the topic label shortens first,
// and the small sync note (↑3 / offline / demo) is dropped before the label gets cut short.
function fitHeader() {
  const st = $('#status .st'), lbl = $('#topicLbl');
  st.hidden = false;
  if (lbl.scrollWidth > lbl.clientWidth + 1) st.hidden = true;
}

/* ---------- rendering ---------- */
function makeCard(c, isNext) {
  const el = document.createElement('article');
  el.className = 'card' + (isNext ? ' next' : '');
  el.innerHTML = `<div class="lbl"></div>
    <div class="body"><div class="q"></div><div class="a"></div></div>
    <button class="exb" type="button" hidden>Explain</button>
    <div class="foot"><span class="tag"></span><span class="iv"></span><button class="rep" type="button" aria-label="Report a problem with this card" hidden>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg></button></div><div class="tint"></div>`;
  el.querySelector('.q').innerHTML = c.q;
  el.querySelector('.a').innerHTML = c.a;
  formatCode(el.querySelector('.body'), langOf(c), true);
  el.querySelector('.tag').textContent = (c.topic ? topicName(c.topic) : (c.deck || '').split('::').pop())
    + (practice ? (c.why ? ` · ${c.why}` : ' · practice') : c.repeat ? ' · offline repeat' : c.isNew ? ' · new' : c.learn ? ' · learning' : '');
  const b = el.querySelector('.exb');
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); openExplain(c); });
  const rb = el.querySelector('.rep');
  rb.addEventListener('pointerdown', (e) => e.stopPropagation());
  rb.addEventListener('click', (e) => { e.stopPropagation(); openReport(c); });
  rb.classList.toggle('on', !!((c.reports && c.reports.length) || c.bad));
  return el;
}

function fit(el) { // shrink text until it fits, then allow internal scrolling
  const body = el.querySelector('.body');
  body.classList.remove('long'); body.style.fontSize = '';
  let fs = 24;
  while (body.scrollHeight > body.clientHeight + 2 && fs > 15) { fs -= 1.5; body.style.fontSize = fs + 'px'; }
  if (body.scrollHeight > body.clientHeight + 2) body.classList.add('long');
}

// `arrive`: a card was just graded, so spring the next one forward
function render(force, arrive) {
  const stage = $('#stage');
  const v = view(), now = Date.now();
  let ready = v.filter((c) => !c.notBefore || c.notBefore <= now);
  if (!ready.length) ready = v.filter((c) => c.notBefore <= now + 20 * 60e3).sort((a, b) => a.notBefore - b.notBefore);
  if (force || !cur) { const was = cur; cur = ready[0] || null; if (cur !== was) shownAt = Date.now(); }
  stage.innerHTML = '';
  curEl = nextEl = null;
  $('#done').hidden = !!cur;
  heat();
  if (!cur) { showCombo(); showDone(); updateBar(); setStatus(); return; }
  const nx = ready.find((c) => c !== cur);
  if (nx) { nextEl = makeCard(nx, true); if (arrive) nextEl.classList.add('enter'); stage.appendChild(nextEl); }
  curEl = makeCard(cur, false); stage.appendChild(curEl);
  if (arrive) {
    const c = curEl;
    c.classList.add('arrive');
    setTimeout(() => c.classList.remove('arrive'), 800);   // after the shine has crossed
  }
  fit(curEl);
  $('#hint').hidden = LS.get('hinted', false);
  updateBar(); setStatus();
}

function updateBar() {
  const pct = total ? (doneCount / total) * 100 : 0;
  $('#bar b').style.width = Math.min(100, pct) + '%';
}

function showDone() {
  $('#done2').hidden = !practice;
  $('#done .big').textContent = practice ? 'Practice complete' : 'All caught up';
  if (practice) {
    const s = practice.stats;
    $('#refresh').textContent = 'Practice again';
    $('#doneStats').textContent = `${practice.size} cards · ${s.reviewed ? Math.round((s.correct / s.reviewed) * 100) : 0}% recalled · best combo ×${s.best}`;
    if (!practice.cheered) { practice.cheered = true; celebrate(1); }
    return;
  }
  const waiting = view().filter((c) => c.notBefore > Date.now());
  if (waiting.length) {
    const mins = Math.max(1, Math.ceil((Math.min(...waiting.map((c) => c.notBefore)) - Date.now() - 20 * 60e3) / 60e3));
    $('#refresh').textContent = 'Check for more';
    $('#doneStats').textContent = `${waiting.length} in learning · next one in ${mins} min`;
    return;
  }
  const others = cfg.topic ? view().length === 0 && deck.length : 0;
  $('#refresh').textContent = others ? 'Show all topics' : 'Check for more';
  if (others) { $('#doneStats').textContent = `No ${cfg.lecture ? lecName(cfg.lecture) : topicName(cfg.topic)} cards left · ${others} in other topics`; return; }
  // what's already on the phone for tomorrow, so you know you can study without the Mac
  const tmr = ahead.filter((c) => c.day === dayAfter(ankiDay(), 1)).length;
  const later = tmr ? ` · ${tmr} card${tmr === 1 ? '' : 's'} ready for tomorrow` : '';
  $('#doneStats').textContent = stats.reviewed
    ? `${stats.reviewed} reviewed today · ${Math.round((stats.correct / stats.reviewed) * 100)}% recalled · best combo ×${stats.best}${later}`
    : (cfg.url || cfg.demo ? 'Nothing due right now.' + later : 'Connect to AnkiConnect in settings to start.');
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
  if (!practice && c.next && c.next.length === 4) el.querySelector('.iv').textContent = `good · ${c.next[2]}`;
  if (c.ex) el.querySelector('.exb').hidden = false;
  el.querySelector('.rep').hidden = false;
}

/* ---------- explanation sheet ---------- */
let exCard = null;
let exReadId = null;   // card whose explanation you opened yourself while it was on screen
// `auto`: opened by itself after Hard/Again, when the card has already flown away, so recap it at the top
// `auto` = 'view': opened from Stats → Struggling cards, which may have no explanation yet
function openExplain(c, auto) {
  if (!c || (!c.ex && auto !== 'view')) return;
  exCard = c;
  if (!auto) exReadId = c.id;   // read by choice: don't pop it up again when this card is graded
  const lang = langOf(c), recap = $('#exCard');
  recap.hidden = !auto;
  if (auto) {
    recap.innerHTML = '<div class="rq"></div><div class="ra"></div>';
    recap.firstChild.innerHTML = c.q; recap.lastChild.innerHTML = c.a;
    formatCode(recap, lang, true);
  }
  $('#exBody').innerHTML = c.ex ? safeHtml(c.ex) : '<p class="muted">No explanation for this card yet.</p>';
  $('#ex h2').textContent = c.ex ? 'Explanation' : 'Card';
  $('#exBad').hidden = !c.ex;
  formatCode($('#exBody'), lang, false);
  for (const d of document.querySelectorAll('#exBody svg, #exBody img, #exCard img')) d.onclick = (e) => { e.stopPropagation(); Zoom.open(d); };
  $('#exTopic').textContent = c.topic ? topicName(c.topic) : '';
  updateBadBtn();
  const wasOpen = !$('#ex').hidden;
  $('#ex').hidden = false; $('#exPanel').scrollTop = 0;
  haptic(1); if (!wasOpen) SFX.open();
}
// `silent`: closed as a side effect (grading a card), which plays its own sound
const closeExplain = (silent) => {
  const wasOpen = !$('#ex').hidden;
  $('#ex').hidden = true; exCard = null; Zoom.close(true);
  if (wasOpen && silent !== true) { haptic(1); SFX.close(); }
};

// Explanations may contain inline SVG diagrams. Strip anything that could run code before showing them.
function safeHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script, iframe, object, embed, foreignObject, style, link, meta').forEach((n) => n.remove());
  for (const el of t.content.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/href$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  return t.innerHTML;
}
$('#exPanel').addEventListener('scroll', (e) => e.currentTarget.classList.toggle('scrolled', e.currentTarget.scrollTop > 4), { passive: true });
$('#ex .scrim').onclick = closeExplain;
$('#exClose').onclick = closeExplain;

function updateBadBtn() {
  const b = $('#exBad'), on = !!(exCard && exCard.bad);
  b.classList.toggle('on', on);
  b.innerHTML = on ? '<b>Flagged for a rewrite</b><small>Tap to unflag</small>' : '<b>Bad explanation?</b><small>Flag it to be rewritten</small>';
}
// Flags apply to the note, so every copy of it (review deck, parked deck, week ahead, practice cache) is updated.
function markNote(note, card, fn) {
  const mark = (list) => { for (const c of list || []) if (c.note === note) fn(c); };
  mark(deck); mark(ahead); if (practice) mark(practice.saved.deck); mark(history.map((h) => h.card)); fn(card);
  if (curEl && cur && cur.note === note) curEl.querySelector('.rep').classList.toggle('on', !!((cur.reports && cur.reports.length) || cur.bad));
  IDB.get('pcache').then((pc) => { if (pc) { mark(Object.values(pc)); IDB.set('pcache', pc); } });
  saveAhead();
}

/* ---------- report a card ---------- */
// The faint flag at the bottom right of a revealed card. One tap per problem, tap again to undo.
let repCard = null, repChanged = false;
function openReport(c) {
  repCard = c; repChanged = false;
  const hasImg = /<img|<svg/i.test(c.q + c.a);
  const opts = [...Object.keys(REPORTS).filter((k) => k !== 'image' || hasImg).map((k) => [k, REPORTS[k][0]]), ...(c.ex ? [['ex', 'Bad explanation']] : [])];
  const box = $('#repList'); box.innerHTML = '';
  for (const [k, label] of opts) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'repopt'; b.dataset.k = k;
    b.innerHTML = '<span></span><i></i>'; b.firstChild.textContent = label;
    b.classList.toggle('on', k === 'ex' ? !!c.bad : (c.reports || []).includes(k));
    b.onclick = () => toggleReport(k, b);
    box.appendChild(b);
  }
  $('#report').hidden = false; haptic(1); SFX.open();
}
function toggleReport(k, b) {
  const c = repCard; if (!c) return;
  const on = !b.classList.contains('on'); b.classList.toggle('on', on); repChanged = true;
  if (k === 'ex') {
    markNote(c.note, c, (x) => { x.bad = on; });
    if (!cfg.demo && c.note) tagQueue.push({ note: c.note, on, tag: BAD_TAG });
  } else {
    markNote(c.note, c, (x) => { const r = new Set(x.reports || []); on ? r.add(k) : r.delete(k); x.reports = [...r]; });
    if (!cfg.demo && c.note) tagQueue.push({ note: c.note, on, tag: REPORTS[k][1] });
  }
  persist(); setStatus(); haptic(1); SFX.pick(on);
}
function closeReport() {
  if ($('#report').hidden) return;
  $('#report').hidden = true; SFX.close();
  if (repChanged) {
    const any = repCard && ((repCard.reports || []).length || repCard.bad);
    toast(any ? (cfg.demo ? 'Reported (demo: not sent)' : 'Reported · tagged in Anki on next sync') : 'Report removed');
    if (!cfg.demo) sync(false);
  }
  repCard = null;
}
$('#report .scrim').onclick = closeReport;
$('#repDone').onclick = closeReport;
$('#exBad').onclick = () => {
  if (!exCard) return;
  const on = !exCard.bad, note = exCard.note;
  markNote(note, exCard, (c) => { c.bad = on; });
  if (!cfg.demo && note) tagQueue.push({ note, on, tag: BAD_TAG });
  persist(); updateBadBtn(); setStatus();
  toast(on ? 'Flagged · tagged in Anki on next sync' : 'Flag removed');
  haptic(1); SFX.tick();
  if (!cfg.demo) sync(false);
};

/* ---------- code formatting ---------- */
// Cards keep code as <code>line<br>line</code>; explanations use <pre> and <code>.
// Multi-line <code> becomes a left-aligned block, `backticks` in card text become inline code,
// and C / Haskell get light syntax colouring (other topics just get the monospace look).
const langOf = (c) => ({ C: 'c', Haskell: 'hs' }[c && c.topic] || null);
const HL = (() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const words = (s) => new Set(s.split(' '));
  const C_KW = words('auto break case continue default do else for goto if return sizeof switch while typedef struct union enum static extern register const volatile inline restrict _Bool _Static_assert NULL true false EOF');
  const C_TY = words('int char short long float double void unsigned signed bool size_t ssize_t FILE ptrdiff_t intptr_t uintptr_t');
  const HS_KW = words('module import qualified as hiding where let in case of if then else do data type newtype class instance deriving infixl infixr infix forall');
  const OPCH = '-!#$%&*+./<=>?@\\\\^|~:';
  const RE = {
    c: new RegExp([
      String.raw`(?<com>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))`,
      String.raw`(?<pre>^[ \t]*#[^\n]*)`,
      String.raw`(?<str>"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)`,
      String.raw`(?<num>(?<![\w.])(?:0[xX][\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*)`,
      String.raw`(?<id>[A-Za-z_]\w*)`,
    ].join('|'), 'gm'),
    hs: new RegExp([
      String.raw`(?<com>(?<![${OPCH}])--+(?![${OPCH}])[^\n]*|\{-[\s\S]*?(?:-\}|$))`,
      String.raw`(?<str>"(?:[^"\\\n]|\\.)*"?|(?<![\w'])'(?:[^'\\\n]|\\.)')`,
      String.raw`(?<num>(?<![\w.'])\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)`,
      String.raw`(?<id>[A-Za-z_][\w']*)`,
      String.raw`(?<op>::|->|=>|<-|\x60[^\x60\n]+\x60|(?<![${OPCH}])[=|\\](?![${OPCH}]))`,
    ].join('|'), 'gm'),
  };
  function kind(lang, id, text, end, start) {
    if (lang === 'c') {
      if (C_KW.has(id)) return 'k';
      if (C_TY.has(id) || /_t$/.test(id)) return 't';
      return /^\s*\(/.test(text.slice(end)) ? 'f' : '';
    }
    if (HS_KW.has(id)) return 'k';
    if (/^[A-Z]/.test(id)) return 't';
    const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
    return /^\s*$/.test(line) ? 'f' : '';     // a name at the start of a line is (usually) being defined
  }
  return function hl(text, lang) {
    const re = RE[lang]; if (!re) return esc(text);
    re.lastIndex = 0; let out = '', last = 0, m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const g = m.groups;
      const cls = g.com ? 'c' : g.pre ? 'p' : g.str ? 's' : g.num ? 'n' : g.op ? 'o' : g.id ? kind(lang, g.id, text, re.lastIndex, m.index) : '';
      out += esc(text.slice(last, m.index)) + (cls ? `<span class="hl-${cls}">${esc(m[0])}</span>` : esc(m[0]));
      last = re.lastIndex;
    }
    return out + esc(text.slice(last));
  };
})();
function codeText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  return c.textContent.replace(/ /g, ' ').replace(/\n$/, '');
}
function formatCode(root, lang, isCard) {
  if (isCard) { // `like this` in plain card text → inline code
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), hits = [];
    while (tw.nextNode()) if (/`[^`\n]+`/.test(tw.currentNode.data) && !tw.currentNode.parentElement.closest('code,pre')) hits.push(tw.currentNode);
    for (const n of hits) {
      const tmp = document.createElement('span');
      tmp.innerHTML = n.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`([^`\n]+)`/g, '<code>$1</code>');
      n.replaceWith(...tmp.childNodes);
    }
    for (const el of [...root.querySelectorAll('code')]) {
      if (el.closest('pre') || !(el.querySelector('br') || el.textContent.includes('\n'))) continue;
      const pre = document.createElement('pre');
      pre.textContent = codeText(el); el.replaceWith(pre);
      if (pre.nextSibling && pre.nextSibling.nodeName === 'BR') pre.nextSibling.remove();
    }
  }
  for (const el of root.querySelectorAll('pre, code')) {
    if (el.tagName === 'CODE' && el.closest('pre')) continue;
    if ([...el.querySelectorAll('*')].some((n) => !/^(BR|CODE)$/.test(n.nodeName))) continue; // leave rich markup alone
    if (el.tagName === 'PRE') el.classList.add('code');
    el.innerHTML = HL(codeText(el), lang);
  }
}

/* ---------- topic picker ---------- */
function showTab(tab) {
  LS.set('tab', tab);
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('#reviewPick').hidden = tab !== 'review'; $('#practicePick').hidden = tab !== 'practice';
}
for (const b of $('#tabs').children) b.onclick = () => { showTab(b.dataset.tab); haptic(1); SFX.pick(); };
function openTopics() {
  Search.reset();
  $('#tabs').hidden = !!practice;
  if (practice) $('#reviewPick').hidden = $('#practicePick').hidden = true;
  else showTab(LS.get('tab', 'review'));
  $('#practiceNow').hidden = !practice;
  if (practice) {
    const s = practice.stats;
    $('#pNowStats').textContent = `${practice.mode === 'hard' ? 'Hardest cards' : 'Random'} · ${practice.topics.length ? practice.topics.map(topicName).join(', ') : 'all topics'} · ${view().length} left`
      + (s.reviewed ? ` · ${Math.round((s.correct / s.reviewed) * 100)}% recalled` : '') + '. Nothing here is sent to Anki.';
    $('#topics').hidden = false;
    return;
  }
  openPracticePick();
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
  drawReviewLectures();
  $('#topics').hidden = false;
}
// the chosen topic's lectures that have cards today, as small chips under the topics
function drawReviewLectures() {
  const box = $('#lecList'), counts = {};
  for (const c of deck) if (cfg.topic && c.topic === cfg.topic && c.lec) counts[c.lec] = (counts[c.lec] || 0) + 1;
  const keys = Object.keys(counts).sort(byLec);
  box.hidden = !keys.length; box.innerHTML = '';
  if (!keys.length) return;
  box.insertAdjacentHTML('beforeend', `<p class="lechead">${esc2(topicName(cfg.topic))} lectures</p>`);
  const wrap = document.createElement('div'); wrap.className = 'lecs'; box.appendChild(wrap);
  for (const [k, name, n] of [['', 'All', keys.reduce((a, k2) => a + counts[k2], 0)], ...keys.map((k2) => [k2, lecName(k2), counts[k2]])]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lec' + ((cfg.lecture || '') === k ? ' on' : '');
    b.innerHTML = '<span></span><b></b>'; b.firstChild.textContent = name; b.lastChild.textContent = n;
    b.onclick = () => setLecture(k);
    wrap.appendChild(b);
  }
}
const esc2 = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Choosing a topic with lectures keeps the sheet open so you can narrow it to one; otherwise it closes.
function setTopic(t) {
  cfg.topic = t; cfg.lecture = ''; saveCfg();
  cur = null; render(true); haptic(1); SFX.pick();
  if (t && deck.some((c) => c.topic === t && c.lec)) { openTopics(); return; }
  $('#topics').hidden = true;
}
function setLecture(k) {
  cfg.lecture = k; saveCfg();
  $('#topics').hidden = true;
  cur = null; render(true); haptic(1); SFX.pick();
}
$('#topicBtn').onclick = () => { openTopics(); SFX.open(); };
$('#topics .scrim').onclick = () => { $('#topics').hidden = true; SFX.close(); };

/* ---------- practice mode ---------- */
// Go through cards from chosen topics, due or not. Answers stay on the phone: nothing is queued for Anki.
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
// no topics picked = every topic. "Hardest" needs answer history, so it never includes unstudied cards.
const hardMode = () => cfg.pMode === 'hard';
const withNew = () => cfg.pNew && !hardMode();
// lectures only narrow practice when exactly one topic is picked (they're shown under it)
const pLecs = (topics) => (topics.length === 1 ? cfg.pLectures.filter((k) => k.startsWith(topics[0] + '::')) : []);
const practiceQuery = (topics, lecs = pLecs(topics)) => (cfg.deck ? `deck:${q(cfg.deck)} ` : '')
  + (lecs.length ? '(' + lecs.map((k) => 'tag:' + q('Lecture::' + k)).join(' OR ') + ') '
    : topics.length ? '(' + topics.map((t) => 'tag:' + q('Topic::' + t)).join(' OR ') + ') ' : '')
  + '-is:suspended' + (withNew() ? '' : ' -is:new');

// How badly you've been doing on a card, 0..1, from Anki's review log. Recent answers count most
// (each older one ×0.75), Hard counts as 0.6 of an Again, answers while first learning a card count
// half, and the +1 in the denominator stops one unlucky answer from ranking a card at the top.
function hardness(log) {
  const rs = [...log].sort((a, b) => b.id - a.id).slice(0, 12);
  let num = 0, den = 0, bad = 0;
  rs.forEach((r, k) => {
    const w = Math.pow(0.75, k) * (r.type === 0 ? 0.5 : 1);
    const b = r.ease === 1 ? 1 : r.ease === 2 ? 0.6 : 0;
    num += w * b; den += w;
    if (k < 6 && b) bad++;
  });
  return { score: num / (den + 1), why: rs.length ? `missed ${bad} of last ${Math.min(6, rs.length)}` : '' };
}

function openPracticePick() {
  const known = LS.get('ptopics', null);
  const local = [...new Set(deck.map((c) => c.topic).filter(Boolean))];
  drawPracticeTopics(known || [...new Set([...Object.keys(TOPICS).filter((t) => local.includes(t)), ...local])], LS.get('pcounts', {}));
  for (const b of $('#pSize').children) b.classList.toggle('on', +b.dataset.n === cfg.pSize);
  $('#pNew').checked = cfg.pNew; $('#pMsg').textContent = '';
  drawMode();
  refreshPracticeCounts();
}
// Random / Hardest switch, and a start button that says exactly what you'll get
function drawMode() {
  for (const b of $('#pMode').children) b.classList.toggle('on', b.dataset.mode === cfg.pMode);
  $('#pNewRow').hidden = hardMode();
  $('#pModeNote').textContent = hardMode()
    ? "The cards you've pressed Hard or Again on most, judged from your recent answers in Anki. Worst first."
    : 'A shuffled mix, whether or not the cards are due.';
  updateStartLabel();
}
function updateStartLabel() {
  const picked = cfg.pTopics.filter((t) => drawnTopics.includes(t));
  const n = cfg.pSize ? String(cfg.pSize) : 'all';
  const lecs = pLecs(picked).sort(byLec);
  const from = lecs.length ? `${topicName(picked[0])} ${lecs.length > 3 ? `(${lecs.length} lectures)` : lecs.map((k) => 'L' + (lecNum(k) < 999 ? lecNum(k) : lecTitle(k))).join(', ')}`
    : picked.length ? picked.map(topicName).join(', ') : 'all topics';
  $('#pStart').textContent = `Start · ${n} ${hardMode() ? 'hardest' : 'random'} from ${from}`;
}
for (const b of $('#pMode').children) b.onclick = () => { cfg.pMode = b.dataset.mode; saveCfg(); drawMode(); refreshPracticeCounts(); haptic(1); SFX.pick(); };
let drawnTopics = [];
function drawPracticeTopics(list, counts) {
  const box = $('#pTopics'); box.innerHTML = '';
  drawnTopics = list.filter((t) => counts[t] !== 0);
  for (const t of drawnTopics) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip' + (cfg.pTopics.includes(t) ? ' on' : '');
    b.innerHTML = '<span></span><b></b>';
    b.firstChild.textContent = topicName(t); b.lastChild.textContent = counts[t] ?? '';
    b.onclick = () => {
      cfg.pTopics = cfg.pTopics.includes(t) ? cfg.pTopics.filter((x) => x !== t) : [...cfg.pTopics, t];
      saveCfg(); b.classList.toggle('on'); drawPracticeLectures(); updateStartLabel(); haptic(1); SFX.pick(b.classList.contains('on'));
    };
    box.appendChild(b);
  }
  if (!box.children.length) box.innerHTML = '<p class="muted">Topics appear once your cards have Topic:: tags.</p>';
  drawPracticeLectures();
  updateStartLabel();
}
// With one topic picked, its lectures appear as small chips: pick any number, or none for the whole topic.
function drawPracticeLectures() {
  const box = $('#pLectures'), picked = cfg.pTopics.filter((t) => drawnTopics.includes(t));
  const all = LS.get('plecs', {}), t = picked.length === 1 ? picked[0] : null;
  const keys = t ? Object.keys(all).filter((k) => k.startsWith(t + '::') && all[k] !== 0).sort(byLec) : [];
  box.hidden = !keys.length; box.innerHTML = '';
  if (!keys.length) return;
  box.insertAdjacentHTML('beforeend', `<p class="lechead">${esc2(topicName(t))} lectures <span>· none picked = all of them</span></p>`);
  const wrap = document.createElement('div'); wrap.className = 'lecs'; box.appendChild(wrap);
  for (const k of keys) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lec' + (cfg.pLectures.includes(k) ? ' on' : '');
    b.innerHTML = '<span></span><b></b>'; b.firstChild.textContent = lecName(k); b.lastChild.textContent = all[k] ?? '';
    b.onclick = () => {
      cfg.pLectures = cfg.pLectures.includes(k) ? cfg.pLectures.filter((x) => x !== k) : [...cfg.pLectures, k];
      saveCfg(); b.classList.toggle('on'); updateStartLabel(); haptic(1); SFX.pick(b.classList.contains('on'));
    };
    wrap.appendChild(b);
  }
}
// real per-topic card counts from Anki when it's reachable (cached for offline)
async function refreshPracticeCounts() {
  if (cfg.demo || !cfg.url) return;
  try {
    const topics = (await anki('getTags', {}, 5000)).filter((t) => /^Topic::[^:]+$/.test(t)).map((t) => t.slice(7));
    const res = await anki('multi', { actions: topics.map((t) => ({ action: 'findCards', params: { query: practiceQuery([t], []) } })) }, 10000);
    const counts = {};
    topics.forEach((t, i) => { const r = res[i]; const ids = r && (r.result !== undefined ? r.result : r); counts[t] = Array.isArray(ids) ? ids.length : 0; });
    topics.sort((a, b) => (Object.keys(TOPICS).indexOf(a) + 1 || 99) - (Object.keys(TOPICS).indexOf(b) + 1 || 99));
    LS.set('ptopics', topics); LS.set('pcounts', counts);
    // and each lecture's count, for the lecture chips
    const lecs = (await anki('getTags', {}, 5000)).filter((x) => x.startsWith('Lecture::')).map((x) => x.slice(9));
    if (lecs.length) {
      const lr = await anki('multi', { actions: lecs.map((k) => ({ action: 'findCards', params: { query: practiceQuery([], [k]) } })) }, 15000);
      const lc = {}; lecs.forEach((k, i) => { lc[k] = resIds(lr[i]).length; });
      LS.set('plecs', lc);
    } else LS.set('plecs', {});
    if (!$('#topics').hidden && !practice) drawPracticeTopics(topics, counts);
  } catch {}
}
for (const b of $('#pSize').children) b.onclick = () => {
  cfg.pSize = +b.dataset.n; saveCfg();
  for (const x of $('#pSize').children) x.classList.toggle('on', x === b);
  updateStartLabel(); haptic(1); SFX.pick();
};
$('#pNew').onchange = (e) => { cfg.pNew = e.target.checked; saveCfg(); refreshPracticeCounts(); SFX.pick(e.target.checked); };

async function loadPracticeCards(topics) {
  const want = cfg.pSize || Infinity;
  const pool = (await IDB.get('pcache')) || {};
  const scores = LS.get('hardScores', {});       // last ranking, so "Hardest" also works offline
  if (!cfg.demo && cfg.url) {
    try {
      let ids = await anki('findCards', { query: practiceQuery(topics) }, 10000);
      if (hardMode()) {
        // rank by the review log (cheap), then download only the cards we'll show
        const logs = await anki('getReviewsOfCards', { cards: ids.map(String) }, 30000);
        for (const id of ids) { const h = hardness(logs[id] || []); if (h.score > 0.05) scores[id] = [h.score, h.why]; else delete scores[id]; }
        LS.set('hardScores', scores);
        ids = ids.filter((id) => scores[id]).sort((a, b) => scores[b][0] - scores[a][0]).slice(0, want);
      } else ids = shuffle(ids).slice(0, want);
      const ex = exAll || (await IDB.get('ex')) || await loadExplanations();
      let cards = await buildCards(await cardsInfo(ids), ex);
      if (hardMode()) cards = cards.sort((a, b) => scores[b.id][0] - scores[a.id][0]).map((c) => ({ ...c, why: scores[c.id][1] }));
      // keep them for offline practice next time (bounded, newest first)
      for (const c of cards) pool[c.id] = c;
      const keys = Object.keys(pool); if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete pool[k];
      IDB.set('pcache', pool);
      online = true;
      return cards;
    } catch (e) { console.warn('practice fetch failed', e); }
  }
  // offline: whatever we already have on the phone for these topics
  const have = new Map();
  for (const c of [...Object.values(pool), ...(practice ? practice.saved.deck : deck)]) {
    const lecs = pLecs(topics);
    if ((!topics.length || topics.includes(c.topic)) && (!lecs.length || lecs.includes(c.lec)) && (withNew() || !c.isNew) && (!hardMode() || scores[c.id])) have.set(c.id, c);
  }
  if (have.size) toast('Offline · practising cards saved on this phone');
  if (!hardMode()) return shuffle([...have.values()]).slice(0, want);
  return [...have.values()].sort((a, b) => scores[b.id][0] - scores[a.id][0]).slice(0, want).map((c) => ({ ...c, why: scores[c.id][1] }));
}

async function startPractice(topics) {
  $('#pMsg').textContent = hardMode() ? 'Finding your hardest cards…' : 'Loading cards…'; $('#pStart').disabled = true;
  let cards;
  try {
    if (cfg.demo) {
      cards = shuffle(deck.filter((c) => !topics.length || topics.includes(c.topic))).slice(0, cfg.pSize || Infinity);
      if (hardMode()) toast('The demo has no answer history, so these are random');
    } else cards = await loadPracticeCards(topics);
  } finally { $('#pStart').disabled = false; }
  if (!cards.length) {
    $('#pMsg').textContent = hardMode()
      ? "No cards you've been missing" + (topics.length ? ' in those topics' : '') + (online ? '. Nice!' : ' saved on this phone. Connect to Anki to rank them.')
      : 'No cards for those topics on this phone yet. Connect to Anki once to download them.';
    return;
  }
  cards = cards.map((c) => ({ ...c, next: null, notBefore: 0, learn: false }));
  if (!practice) practice = { saved: { deck, doneCount, total, combo, history, cur } };
  Object.assign(practice, { topics, mode: cfg.pMode, size: cards.length, stats: { reviewed: 0, correct: 0, best: 0 }, cheered: false });
  deck = cards; doneCount = 0; total = cards.length; combo = 0; history = []; cur = null;
  document.body.classList.add('practice');
  $('#topics').hidden = true;
  render(true); showCombo(); updateUndo(); haptic(2); SFX.open();
}
function endPractice() {
  if (!practice) return;
  const s = practice.saved; practice = null;
  ({ deck, doneCount, total, combo, history } = s); cur = null;
  document.body.classList.remove('practice');
  $('#topics').hidden = true;
  render(true); showCombo(); updateUndo(); setStatus(); haptic(1);
}
$('#pStart').onclick = () => startPractice(cfg.pTopics.filter((t) => drawnTopics.includes(t)));
$('#pEnd').onclick = endPractice;
$('#done2').onclick = endPractice;

let uidSeq = Date.now();
let lastAnswerAt = 0;   // when the last card was graded (to catch grades made by swiping home)
function answer(ease, dir, px, py) {
  if (!cur || !curEl) return;
  lastAnswerAt = Date.now();
  const card = cur, el = curEl;
  const st = practice ? practice.stats : stats;
  const h = { uid: ++uidSeq, card: { ...card }, ease, dir, combo, doneCount, stats: { ...st }, reinserted: null, aheadOut: [], aheadIn: null };
  // practice never reaches Anki, and neither do offline repeats: Anki only gets a card's first answer, since it
  // stamps every answer with the moment it arrives, and two at once would wreck that card's schedule
  if (!cfg.demo && !practice && !card.repeat) queue.push({ uid: h.uid, cardId: card.id, ease, t: Date.now() });
  const at = deck.indexOf(card); deck.splice(at < 0 ? 0 : at, 1);
  closeExplain(true);

  if (practice) {
    // no scheduling: Again comes back in a few cards, Hard a bit later, Good/Easy are done
    if (ease <= 2) {
      const again = { ...card };
      deck.splice(Math.min(deck.length, ease === 1 ? 3 : 7), 0, again); h.reinserted = again;
    } else doneCount++;
  } else {
    // Follow Anki's learning steps locally (with their real delays) so the day works offline
    // and cards come back exactly when Anki would show them, not sooner or more often.
    const ns = nextStep(card, ease);
    if (ns) {
      const again = { ...card, ...ns, isNew: false, learn: true, next: null, notBefore: Date.now() + ns.wait * 60e3 };
      deck.splice(posAfter(3), 0, again); h.reinserted = again;
    } else doneCount++;
    if (!card.repeat) {
      // Anki reschedules this card from this answer, so drop any copy downloaded for later this week, and
      // (in case you're still offline then) bring it back on the day Anki said, as an offline repeat
      h.aheadOut = ahead.filter((c) => c.id === card.id);
      if (h.aheadOut.length) ahead = ahead.filter((c) => c.id !== card.id);
      const d = !ns && card.next ? labelDays(card.next[ease - 1]) : 0;
      if (d >= 1 && d <= AHEAD) {
        h.aheadIn = { ...card, repeat: true, isNew: false, learn: false, phase: 'review', step: 0, next: null, notBefore: 0, day: dayAfter(ankiDay(), d) };
        ahead.push(h.aheadIn);
      }
      if (h.aheadIn || h.aheadOut.length) saveAhead();
    }
  }

  st.reviewed++; if (ease > 1) st.correct++;
  const broke = ease <= 2 && combo >= 3 ? combo : 0;   // Again and Hard both end the streak
  combo = ease > 2 ? combo + 1 : 0;
  st.best = Math.max(st.best, combo);
  if (!practice) {
    const k = new Date(Date.now() - 4 * 3600e3).toLocaleDateString('en-CA'), d = appTime[k] || (appTime[k] = [0, 0]);
    d[0] += Math.min(60000, Date.now() - shownAt); d[1]++;
    const keys = Object.keys(appTime).sort(); if (keys.length > 800) delete appTime[keys[0]];
    LS.set('appTime', appTime);
  }
  if (!practice && combo > (records.bestCombo || 0)) { records.bestCombo = combo; LS.set('records', records); }
  if (!practice) LS.set('stats', stats);
  LS.set('hinted', true); $('#hint').hidden = true;
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
  el.classList.remove('arrive');   // graded before it finished arriving: let the fly-out take over
  const off = OFF(dir);
  el.style.transition = 'transform .28s cubic-bezier(.4,0,.6,1), opacity .28s';
  el.style.transform = `translate(${off[0]}px, ${off[1]}px) rotate(${off[2]}deg)`;
  el.style.opacity = '0';
  $('#fly').appendChild(el);   // keeps flying while the stage is rebuilt underneath it
  cur = null; curEl = null; nextEl = null;
  setTimeout(() => el.remove(), 320);
  render(true, true);

  // Missed it? Show the explanation straight away (Settings → Show explanation automatically).
  // …unless you already opened it yourself on this showing of the card (Settings → Skip if I've already read it).
  const autoAt = cfg.autoEx === 'hard' ? 2 : cfg.autoEx === 'again' ? 1 : 0;
  const alreadyRead = cfg.exSkipRead && exReadId === card.id;
  exReadId = null;
  if (card.ex && ease <= autoAt && !alreadyRead) setTimeout(() => { if ($('#ex').hidden && $('#sheet').hidden) openExplain(card, true); }, 380);

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
      milestone(`×${c}`, true); SFX.streak(c); haptic(2);
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
  return !!h && (cfg.demo || !!practice || !!h.card.repeat || queue.some((a) => a.uid === h.uid));
}
function updateUndo() {
  const u = $('#undo'), on = canUndo();
  if (u.classList.contains('on') !== on) { u.classList.toggle('on', on); setTimeout(fitHeader, 260); }  // after its width animates
}
addEventListener('resize', () => fitHeader());
setInterval(updateUndo, 1000);
setInterval(() => { if (!cur && view().length && $('#sheet').hidden) render(true); }, 30000);
// past 4am with the app open: bring in the new day's downloaded cards
setInterval(() => { if (releaseAhead() && !practice) { render(!cur); setStatus(); } }, 60000);

function undo() {
  const h = history[history.length - 1];
  if (!h) return;
  if (!canUndo()) { toast('Already synced to Anki'); history = []; updateUndo(); return; }
  history.pop();
  queue = queue.filter((a) => a.uid !== h.uid);
  if (h.reinserted) { const i = deck.indexOf(h.reinserted); if (i >= 0) deck.splice(i, 1); }
  if (h.aheadIn) ahead = ahead.filter((c) => c !== h.aheadIn);
  if (h.aheadOut && h.aheadOut.length) ahead.push(...h.aheadOut);
  if (h.aheadIn || (h.aheadOut && h.aheadOut.length)) saveAhead();
  deck.unshift(h.card);
  combo = h.combo; doneCount = h.doneCount;
  if (practice) practice.stats = h.stats; else { stats = h.stats; LS.set('stats', stats); }
  persist();
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
  if (!curEl || !$('#sheet').hidden || !$('#ex').hidden || !$('#topics').hidden || !$('#stats').hidden || !$('#report').hidden || Zoom.isOpen) return;
  if (e.clientY > curEl.getBoundingClientRect().bottom) return;   // the strip under the card is the iPhone's home bar
  const body = curEl.querySelector('.body');
  drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), mode: null, armed: false,
    body, img: curEl.classList.contains('revealed') ? e.target.closest('.body img') : null, samples: [[e.clientX, e.clientY, performance.now()]] };
  curEl.classList.remove('arrive');
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

const endDrag = (e) => {
  if (!drag || !curEl) { drag = null; return; }
  // iOS cancels the touch when it takes over a system gesture (swipe home, Control Center…):
  // that's never an answer, so snap the card back instead of grading it
  if (e && e.type === 'pointercancel') {
    drag = null;
    curEl.style.transition = 'transform .35s cubic-bezier(.2,1.4,.4,1)'; curEl.style.transform = '';
    curEl.querySelector('.tint').style.opacity = 0; curEl.querySelector('.lbl').style.opacity = 0;
    return;
  }
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
    if (performance.now() - d.t0 < 400) { if (d.img) { reset(); return Zoom.open(d.img); } reveal(); }   // a revealed card's image: enlarge it
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
  if (Zoom.isOpen) { if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); Zoom.close(); } return; }
  if (!$('#report').hidden) { if (e.key === 'Escape') closeReport(); return; }
  if (!$('#ex').hidden) { if (e.key === 'Escape' || e.key === 'e') closeExplain(); return; }
  if (!$('#stats').hidden) { if (e.key === 'Escape') closeStats(); return; }
  if (e.key === '/' && $('#sheet').hidden && $('#topics').hidden) { e.preventDefault(); openTopics(); SFX.open(); Search.focus(); return; }
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
  let ac, out, wet;
  const PENTA = [0, 2, 4, 7, 9];
  // C4 pentatonic climbing gently with the streak, capped so it never gets shrill (max ~E5)
  const note = (i) => { i = Math.min(i, 7); return 261.63 * Math.pow(2, (PENTA[i % 5] + 12 * Math.floor(i / 5)) / 12); };
  // iOS stops Web Audio in two ways: 'suspended', and Safari's own 'interrupted' (after a call, Siri,
  // a notification, another app's audio, or locking the phone). Only 'suspended' used to be handled, so
  // after an interruption the app stayed silent until it was restarted. Now any non-running state is
  // resumed, a context that still won't run is thrown away and rebuilt, and coming back from the
  // background always starts a fresh one (iOS can leave an old one "running" but silent).
  let stale = false;
  function build() {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ac.createDynamicsCompressor(); out = ac.createGain(); out.gain.value = 0.5;
      out.connect(comp).connect(ac.destination);
      // a soft echo that streak sounds can send into, so they ring out instead of stopping dead
      wet = ac.createGain(); wet.gain.value = 1;
      const dl = ac.createDelay(1), fb = ac.createGain(), lp = ac.createBiquadFilter(), ret = ac.createGain();
      dl.delayTime.value = 0.17; fb.gain.value = 0.34; lp.type = 'lowpass'; lp.frequency.value = 2600; ret.gain.value = 0.32;
      wet.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(ret); ret.connect(out);
    } catch { ac = null; }
  }
  function drop() { const a = ac; ac = null; out = null; wet = null; if (a) a.close().catch(() => {}); }
  function ctx() {
    if (!cfg.sound) return null;
    if (ac && (stale || ac.state === 'closed')) drop();
    stale = false;
    if (!ac) build();
    if (!ac) return null;
    if (ac.state !== 'running') {
      const a = ac;
      a.resume().catch(() => {});
      clearTimeout(ctx.t);
      ctx.t = setTimeout(() => { if (ac === a && a.state !== 'running') drop(); }, 800);
    }
    return ac;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stale = true; });
  addEventListener('pageshow', (e) => { if (e.persisted) stale = true; });
  // touchend / click count as a user gesture on iOS (pointerdown/touchstart don't always), so wake audio on those
  for (const ev of ['touchend', 'click', 'keydown']) document.addEventListener(ev, () => { if (cfg.sound && (!ac || ac.state !== 'running' || stale)) ctx(); }, { capture: true, passive: true });
  function tone(f, { t = 0, dur = 0.18, type = 'sine', vol = 0.3, to = null, attack = 0.005, filter = null, send = 0 } = {}) {
    const a = ctx(); if (!a) return;
    const s = a.currentTime + t, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, s);
    if (to) o.frequency.exponentialRampToValueAtTime(to, s + dur);
    g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + attack); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    let node = o;
    if (filter) { const fl = a.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = filter; node.connect(fl); node = fl; }
    node.connect(g).connect(out); o.start(s); o.stop(s + dur + 0.05);
    if (send && wet) { const sg = a.createGain(); sg.gain.value = send; g.connect(sg).connect(wet); }
  }
  // a struck bell: a pure tone plus a quickly fading octave and twelfth give it a glassy "ting"
  function bell(f, { t = 0, dur = 0.9, vol = 0.14, send = 0.5 } = {}) {
    tone(f, { t, dur, vol, send });
    tone(f * 2, { t, dur: dur * 0.45, vol: vol * 0.32, send });
    tone(f * 3, { t, dur: dur * 0.22, vol: vol * 0.12, send });
  }
  const C = (k) => 261.63 * Math.pow(2, k / 12);   // semitones above middle C
  return {
    unlock() { ctx(); },
    tick() { tone(900, { dur: 0.03, vol: 0.06 }); },
    // panels: a soft rising "bloop" in, the same falling out
    open() { tone(520, { dur: 0.1, vol: 0.09, to: 760, attack: 0.008 }); tone(1040, { dur: 0.06, vol: 0.02, t: 0.03 }); },
    // choosing a topic / chip / tab: a short pluck, higher when switching something on
    pick(on = true) { tone(on ? 880 : 660, { dur: 0.07, type: 'triangle', vol: 0.11 }); tone(on ? 1320 : 990, { dur: 0.04, vol: 0.03, t: 0.012 }); },
    close() { tone(700, { dur: 0.1, vol: 0.09, to: 440, attack: 0.008 }); tone(350, { dur: 0.08, vol: 0.04, t: 0.02 }); },
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
    // ×5, ×15, ×25…: a quick sparkling C-major arpeggio of bells (an extra top note from ×15 on)
    streak(c) {
      const run = c >= 15 ? [16, 19, 24, 28] : [16, 19, 24];   // E5 G5 C6 (E6)
      run.forEach((k, j) => bell(C(k), { t: j * 0.065, dur: 0.75 + j * 0.1, vol: 0.13 }));
      tone(C(-12), { dur: 0.5, vol: 0.12, attack: 0.01 });     // a soft low C underneath
    },
    // ×10, ×20…: a rising fanfare that lands on a warm, ringing chord; bigger tiers sparkle more
    milestone(tier) {
      const up = [0, 4, 7, 12, 16];                              // C4 E4 G4 C5 E5
      up.forEach((k, j) => {
        tone(C(k), { t: j * 0.055, dur: 0.3, type: 'triangle', vol: 0.2, send: 0.25 });
        tone(C(k + 12), { t: j * 0.055, dur: 0.16, vol: 0.04 });
      });
      const land = 0.3;
      [-12, 0, 7, 12, 16].forEach((k) => tone(C(k), { t: land, dur: 1.4, type: 'triangle', vol: k < 0 ? 0.16 : 0.09, attack: 0.03, filter: 2400, send: 0.3 }));
      tone(C(-24), { t: land, dur: 0.9, vol: 0.2, attack: 0.01 });  // bass thump
      const sparkle = [31, 28, 36, 31, 40, 36];                  // G6 E6 C7 …
      for (let j = 0; j < Math.min(2 + tier * 2, sparkle.length); j++) bell(C(sparkle[j]), { t: land + 0.06 + j * 0.09, dur: 0.6, vol: 0.06, send: 0.6 });
    },
    undo() { tone(700, { dur: 0.16, vol: 0.12, to: 350 }); },
    // enlarging an image: an airy upward glide with a glint on top; putting it back: the same, falling to rest
    zoomIn() { tone(392, { dur: 0.24, vol: 0.06, to: 784, attack: 0.03 }); bell(C(19), { t: 0.1, dur: 0.55, vol: 0.045, send: 0.55 }); },
    zoomOut() { tone(740, { dur: 0.2, vol: 0.05, to: 370, attack: 0.01 }); tone(C(7), { t: 0.15, dur: 0.12, type: 'triangle', vol: 0.05 }); },
    // stats opening: a quick, quiet run of glassy notes rising with the bars
    chart() { [0, 4, 7, 11, 14, 19].forEach((k, j) => bell(C(k + 12), { t: j * 0.05, dur: 0.45, vol: 0.035, send: 0.45 })); },
    // tapping a day: a tiny pluck, brighter the busier the day was (level 0..4)
    cell(l = 0) { tone(C([7, 12, 16, 19, 24][l] || 12) * 2, { dur: 0.06, type: 'triangle', vol: 0.07 }); },
    // exam date saved: two bells a fifth apart, like a confirmation
    set() { bell(C(12), { dur: 0.6, vol: 0.11 }); bell(C(19), { t: 0.09, dur: 0.85, vol: 0.11 }); },
  };
})();

/* ---------- particles ---------- */
const FX = (() => {
  const cv = $('#fx'), cx = cv.getContext('2d');
  let W, H, dpr, P = [], waves = [], raf = 0;
  const size = () => { dpr = Math.min(devicePixelRatio || 1, 3); /* full sharpness on 3× iPhones */ W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
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
  $('#sMix').checked = cfg.mixNew !== false;
  $('#sAutoEx').value = cfg.autoEx; $('#sSkipRead').checked = cfg.exSkipRead;
  $('#sSkipRow').hidden = cfg.autoEx === 'off';
  const m = $('#sMsg'); m.textContent = msg || ''; m.className = cls || '';
  fillDecks(LS.get('decks', []));
  $('#sheet').hidden = false;
  if (cfg.url && !cfg.demo) anki('deckNames', {}, 4000).then((d) => { LS.set('decks', d); fillDecks(d); }).catch(() => {});
}
function closeSheet() { $('#sheet').hidden = true; }
$('#gear').onclick = () => openSheet();
$('#status').onclick = () => sync(true, true);
$('#sheet .scrim').onclick = () => { closeSheet(); SFX.close(); };
$('#sClose').onclick = () => { closeSheet(); SFX.close(); };
// instant-apply toggles, no connection needed
$('#sSound').onchange = (e) => { cfg.sound = e.target.checked; saveCfg(); if (cfg.sound) SFX.pick(true); };
$('#sHap').onchange = (e) => { cfg.haptics = e.target.checked; saveCfg(); haptic(1); SFX.pick(e.target.checked); };
$('#sWeb').onchange = (e) => { cfg.ankiweb = e.target.checked; saveCfg(); SFX.pick(e.target.checked); };
// re-pick today's new cards straight away (only possible while Anki is reachable)
$('#sMix').onchange = (e) => { cfg.mixNew = e.target.checked; saveCfg(); SFX.pick(e.target.checked); sync(true); };
$('#sAutoEx').onchange = (e) => { cfg.autoEx = e.target.value; saveCfg(); SFX.pick(); $('#sSkipRow').hidden = cfg.autoEx === 'off'; };
$('#sSkipRead').onchange = (e) => { cfg.exSkipRead = e.target.checked; saveCfg(); SFX.pick(e.target.checked); };

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
$('#refresh').onclick = () => practice ? startPractice(practice.topics)
  : (cfg.topic && deck.length) ? setTopic('') : cfg.demo ? $('#sDemo').onclick() : sync(true, true);

const DEMO = [
  { q: 'Write a C function returning the larger of two ints.', a: '<code>int max(int a, int b) {<br>&nbsp;&nbsp;return a &gt; b ? a : b; // ternary<br>}</code>', topic: 'C',
    ex: '<p>The conditional operator <code>a &gt; b ? a : b</code> picks one of two values, so the whole body is one <code>return</code>.</p><pre>int m = max(3, 7);   // 7\nprintf("%d\\n", m);</pre>' },
  { q: 'Define <code>map</code> recursively.', a: '<code>map :: (a -&gt; b) -&gt; [a] -&gt; [b]<br>map _ [] = []<br>map f (x:xs) = f x : map f xs</code>', topic: 'Haskell',
    ex: '<p>Empty list in, empty list out. Otherwise apply <code>f</code> to the head and <code>map</code> the tail.</p><pre>map (*2) [1,2,3]   -- [2,4,6]\nmap show [True]    -- ["True"]</pre>' },
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
  tagQueue = (await IDB.get('tags')) || [];
  ahead = (await IDB.get('ahead')) || [];
  const meta = (await IDB.get('meta')) || {};
  doneCount = meta.doneCount || 0; total = meta.total || deck.length; combo = meta.combo || 0;
  releaseAhead();
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

// Graded and then the app left the screen moments later: that was the swipe up to go home (or into the app
// switcher), not an answer. iOS can report leaving late, so look back 1.5 s, and listen to every signal it
// may send first (blur, pagehide, visibilitychange). Runs before anything is sent to Anki.
function takeBackIfLeaving() {
  if (Date.now() - lastAnswerAt < 1500 && history.length) { lastAnswerAt = 0; undo(); }
}
addEventListener('blur', takeBackIfLeaving);
addEventListener('pagehide', takeBackIfLeaving);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') takeBackIfLeaving();
  if (cfg.demo) return;
  if (document.visibilityState === 'visible') {
    if (releaseAhead() && !practice) { render(!cur); setStatus(); }
    sync(Date.now() - lastFetch > 5 * 60e3 || !deck.length);
  }
  else { persist(); saveAhead(true); if (queue.length) flush(true).catch(() => {}); flushTags().catch(() => {}); }  // leaving the app: push everything
});
addEventListener('online', () => sync(!deck.length));
setInterval(() => { if ((queue.length || tagQueue.length) && document.visibilityState === 'visible' && Date.now() > retryAt) sync(false); }, 60000);

// Home-screen apps on iOS resume instead of reloading, so they can run an old version for days.
// Check for an update whenever the app comes back, and reload into it as soon as it's installed.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true; persist(); setTimeout(() => location.reload(), 300);
  });
}
