'use strict';
/* Stats page and exam dates. Loaded after app.js and uses its helpers (anki, cfg, SFX, LS, haptic…).
   Everything comes from Anki's own review log, so reviews done in Anki itself count too.
   The last result is kept on the phone, so the page opens instantly and still works offline. */

const ROLL = 4 * 3600e3;                                       // Anki's day starts at 4am
const dayKey = (ms) => new Date(ms - ROLL).toLocaleDateString('en-CA');
const addDays = (key, n) => { const d = new Date(key + 'T12:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => n.toLocaleString('en-GB');
const fmtMin = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} m`; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/* ---------- data ---------- */
const findAct = (query) => ({ action: 'findCards', params: { query } });

async function gatherStats() {
  const scope = cfg.deck ? `deck:${q(cfg.deck)}` : 'deck:*', live = `${scope} -is:suspended`;
  const tags = await anki('getTags', {}, 8000);
  const topics = tags.filter((t) => /^Topic::[^:]+$/.test(t)).map((t) => t.slice(7));
  const lecTags = tags.filter((t) => /^Lecture::[^:]+::.+$/.test(t)).map((t) => t.slice(9));
  const acts = [findAct(scope), findAct(`${live} is:due`)];
  for (let d = 1; d < 30; d++) acts.push(findAct(`${live} prop:due=${d}`));
  for (const t of topics) {
    const tq = `${live} tag:${q('Topic::' + t)}`;
    acts.push(findAct(tq), findAct(`${tq} is:new`), findAct(`${tq} prop:ivl>=21`), findAct(`${tq} introduced:1`));
  }
  const lecAt = acts.length;
  for (const k of lecTags) { const lq = `${live} tag:${q('Lecture::' + k)}`; acts.push(findAct(lq), findAct(`${lq} is:new`), findAct(`${lq} prop:ivl>=21`)); }
  const res = (await anki('multi', { actions: acts }, 30000)).map(resIds);
  const forecast = [res[1].length, ...res.slice(2, 31).map((r) => r.length)];
  const topicOf = new Map(), T = [];
  topics.forEach((t, i) => {
    const [all, fresh, known, intro] = res.slice(31 + i * 4, 35 + i * 4);
    if (!all.length) return;
    const row = { t, total: all.length, unseen: fresh.length, known: known.length, intro: intro.length, rev: 0, ok: 0 };
    for (const id of all) topicOf.set(id, row);
    T.push(row);
  });
  // lectures: the same known / learning / new split, plus recall and struggling cards, per lecture
  const lecOf = new Map(), L = [];
  lecTags.forEach((k, i) => {
    const [all, fresh, known] = res.slice(lecAt + i * 3, lecAt + i * 3 + 3);
    if (!all.length) return;
    const row = { k, t: k.split('::')[0], total: all.length, unseen: fresh.length, known: known.length, rev: 0, ok: 0, hard: 0 };
    for (const id of all) lecOf.set(id, row);
    L.push(row);
  });
  T.sort((a, b) => (Object.keys(TOPICS).indexOf(a.t) + 1 || 99) - (Object.keys(TOPICS).indexOf(b.t) + 1 || 99));

  const logs = await anki('getReviewsOfCards', { cards: res[0].map(String) }, 60000);
  const t30 = Date.now() - 30 * 864e5, days = {}, buttons = [0, 0, 0, 0], misses = new Map();
  let reviews = 0, ms = 0;
  const seq = [];                                              // [time, ease] of every answer, for the best combo
  for (const [cid, list] of Object.entries(logs || {})) {
    const row = topicOf.get(+cid), lrow = lecOf.get(+cid);
    let missed = 0;
    for (const r of list) {
      if (!(r.ease >= 1)) continue;                            // manual reschedules aren't reviews
      reviews++; ms += r.time || 0; seq.push([r.id, r.ease]);
      const d = days[dayKey(r.id)] || (days[dayKey(r.id)] = [0, 0, 0, 0]);   // [cards, ms, right, answers with no time]
      d[0]++; d[1] += r.time || 0; if (r.ease > 1) d[2]++; if (!r.time) d[3]++;
      if (r.ease === 1) missed++;
      if (lrow && r.id >= t30 && r.type === 1) { lrow.rev++; if (r.ease > 1) lrow.ok++; }
      if (r.ease === 1) { const m = misses.get(+cid) || [0, 0]; m[0]++; m[1] = Math.max(m[1], r.id); misses.set(+cid, m); }
      if (r.id >= t30 && r.type === 1) { buttons[r.ease - 1]++; if (row) { row.rev++; if (r.ease > 1) row.ok++; } }
    }
    if (lrow && missed >= 3) lrow.hard++;
  }
  // best combo ever: the longest run of Good / Easy answers in a row, the same rule as the in-app combo
  seq.sort((a, b) => a[0] - b[0]);
  let run = 0, bestRun = 0;
  for (const [, e] of seq) { run = e > 2 ? run + 1 : 0; if (run > bestRun) bestRun = run; }
  // the cards you've pressed Again on most (3+ times), most recent first on a tie
  const worst = [...misses].filter(([, m]) => m[0] >= 3).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, 8);
  const hard = [];
  if (worst.length) {
    for (const c of await anki('cardsInfo', { cards: worst.map(([id]) => id) }, 20000)) {
      const div = document.createElement('div'); div.innerHTML = clean(c.question);
      div.querySelectorAll('img, svg, pre').forEach((n) => n.replaceWith(' … '));
      hard.push({ id: c.cardId, n: misses.get(c.cardId)[0], text: div.textContent.replace(/\s+/g, ' ').trim().slice(0, 140), topic: (topicOf.get(c.cardId) || {}).t || null });
    }
    hard.sort((a, b) => b.n - a.n);
  }
  return { at: Date.now(), days, forecast, topics: T, lectures: L, buttons, reviews, ms, hard, bestRun };
}

// The demo deck has no history, so make up a believable one.
function demoStats() {
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const days = {}, today = dayKey(Date.now());
  for (let i = 0; i < 120; i++) {
    if (i > 9 && rnd() < 0.3) continue;
    const n = Math.round(10 + rnd() * 140); days[addDays(today, -i)] = [n, n * (6000 + rnd() * 5000), Math.round(n * (0.75 + rnd() * 0.2))];
  }
  const T = [['Architecture', 412], ['C', 520], ['Haskell', 460], ['SoftwareTools', 190], ['Maths', 230]].map(([t, total]) => {
    const unseen = Math.round(total * rnd() * 0.6), known = Math.round((total - unseen) * (0.3 + rnd() * 0.4)), rev = 40 + Math.round(rnd() * 200);
    return { t, total, unseen, known, intro: 0, rev, ok: Math.round(rev * (0.72 + rnd() * 0.22)) };
  });
  const names = { Architecture: ['Boolean Algebra', 'Logic Gates', 'Adders', 'Flip-Flops', 'Verilog', 'Pipelines'], C: ['Types', 'Control Flow', 'Arrays', 'Strings', 'Pointers', 'Memory'],
    Haskell: ['Types', 'Lists', 'Recursion', 'Higher-Order Functions', 'Type Classes'], SoftwareTools: ['Shell', 'Git', 'Make', 'Debugging'], Maths: ['Sets', 'Relations', 'Functions', 'Proof', 'Induction'] };
  const lectures = [];
  for (const [t, list] of Object.entries(names)) list.forEach((n, i) => {
    const total = 20 + Math.round(rnd() * 40), unseen = i >= list.length - 1 ? total : Math.round(total * rnd() * 0.4 * (i / list.length));
    const known = Math.round((total - unseen) * (0.15 + rnd() * 0.7)), rev = Math.round(rnd() * 40);
    lectures.push({ k: `${t}::${String(i + 1).padStart(2, '0')}_${n.replace(/ /g, '_')}`, t, total, unseen, known, rev, ok: Math.round(rev * (0.6 + rnd() * 0.38)), hard: rnd() < 0.25 ? 1 + Math.round(rnd() * 4) : 0 });
  });
  return { at: Date.now(), days, demo: true, lectures, forecast: Array.from({ length: 30 }, (_, i) => Math.round((i ? 20 : 60) + rnd() * 60 * Math.exp(-i / 14))),
    topics: T, buttons: [180, 90, 1150, 140], reviews: 9120, bestRun: 34, ms: 9120 * 8500,
    hard: [{ id: 0, n: 7, text: 'What does the ALU control line SUB do in a ripple-carry adder?', topic: 'Architecture' },
      { id: 0, n: 5, text: 'Write foldr in terms of its recursion pattern.', topic: 'Haskell' },
      { id: 0, n: 4, text: 'What is the difference between char *p and char p[]?', topic: 'C' }] };
}

/* ---------- derived numbers ---------- */
// Time on a day: what Anki logged, plus what this phone timed. Answers sent from the app before it kept
// time (Anki says 0 s, and the phone has no record) are counted at a typical 10 s each.
const EST_MS = 10000;
function dayMs(k) {
  const d = S.days[k] || [0, 0, 0, 0], a = S.demo ? [0, 0] : appTime[k] || [0, 0];
  return d[1] + a[0] + Math.max(0, (d[3] || 0) - a[1]) * EST_MS;
}
const allMs = () => [...new Set([...Object.keys(S.days), ...(S.demo ? [] : Object.keys(appTime))])].reduce((t, k) => t + dayMs(k), 0);
function streaks(days, today, extraToday) {
  const has = (k) => (days[k] && days[k][0]) || (k === today && extraToday);
  let k = has(today) ? today : addDays(today, -1), cur = 0;
  while (has(k)) { cur++; k = addDays(k, -1); }
  let best = 0, run = 0, prev = null;
  for (const d of Object.keys(days).sort()) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1; prev = d; best = Math.max(best, run);
  }
  return { cur, best: Math.max(best, cur), doneToday: !!has(today) };
}
const BADGES = {
  reviews: { name: 'Reviews', steps: [100, 500, 1000, 2500, 5000, 10000, 25000], fmt: (n) => fmtN(n) + ' reviews' },
  streak: { name: 'Day streak', steps: [3, 7, 14, 30, 60, 100, 365], fmt: (n) => `${n}-day streak` },
  combo: { name: 'Combo', steps: [10, 25, 50, 75, 100, 150, 200], fmt: (n) => `×${n} combo` },
};

/* ---------- page ---------- */
let S = null, stOpen = false, examChanged = false, stLoading = false, stFailed = false;
const stPanel = $('#stPanel'), stBody = $('#stBody');

function openStats() {
  stOpen = true;
  $('#stats').hidden = false; stPanel.scrollTop = 0; stPanel.classList.remove('scrolled');
  haptic(1); SFX.open();
  S = cfg.demo ? demoStats() : LS.get('statsData', null);
  if (S) draw(true); else { stBody.innerHTML = '<div class="st-empty"><div class="spin"></div>Reading your review history…</div>'; $('#stWhen').textContent = ''; }
  if (!cfg.demo) refreshStats(!S);
}
function closeStats() {
  if ($('#stats').hidden) return;
  $('#stats').hidden = true; stOpen = false; haptic(1); SFX.close();
  if (examChanged) {
    examChanged = false;
    if (!cfg.demo && !practice) { toast("Today's new cards updated for your exam dates"); sync(true); }
  }
}
async function refreshStats(first) {
  if (stLoading || !cfg.url) { if (!S) stBody.innerHTML = '<div class="st-empty">Connect to Anki in Settings to see your stats.</div>'; return; }
  stLoading = true; $('#stWhen').textContent = S ? 'Updating…' : '';
  try {
    const fresh = await gatherStats();
    LS.set('statsData', fresh); S = fresh; stFailed = false;
    if (stOpen) draw(first);
  } catch (e) {
    console.warn('stats failed', e); stFailed = true;
    if (!S) stBody.innerHTML = "<div class=\"st-empty\">Can't reach Anki right now.<br>Your stats will show the next time it's reachable.</div>";
  } finally { stLoading = false; whenLine(); }
}
function whenLine() {
  if (!S) return;
  const mins = Math.round((Date.now() - S.at) / 60000), ago = mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  $('#stWhen').textContent = S.demo ? 'Demo data' : stLoading ? 'Updating…' : stFailed ? `Offline · from ${ago}` : mins < 1 ? 'Up to date' : `Updated ${ago}`;
}

function draw(animate) {
  const today = dayKey(Date.now());
  // answers still waiting on the phone aren't in Anki's log yet, so add them to today
  const pend = cfg.demo ? [] : queue.filter((a) => a.t > S.at);
  const tday = S.days[today] || [0, 0, 0];
  const todayN = tday[0] + pend.length, todayOk = tday[2] + pend.filter((a) => a.ease > 1).length;
  const st = streaks(S.days, today, pend.length);
  const bestCombo = Math.max(records.bestCombo || 0, stats.best || 0, S.bestRun || 0);
  const html = [
    secToday(todayN, todayOk, st),
    secActivity(today, todayN, dayMs(today)),
    secTopics(),
    secLectures(),
    secForecast(),
    secStruggle(),
    secRecords(st, bestCombo, todayN),
  ].join('');
  stBody.innerHTML = html;
  whenLine();
  stBody.classList.toggle('still', !animate);
  if (animate) {
    stBody.classList.remove('in'); void stBody.offsetWidth;
    requestAnimationFrame(() => stBody.classList.add('in'));
    countUp();
    setTimeout(() => stOpen && SFX.chart(), 140);
  } else stBody.classList.add('in');
  badgeCheck(st, bestCombo);
}

function countUp() {
  for (const el of stBody.querySelectorAll('[data-count]')) {
    const to = +el.dataset.count, t0 = performance.now(), dur = 700;
    if (!to || matchMedia('(prefers-reduced-motion: reduce)').matches) continue;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = fmtN(Math.round(to * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
    el.textContent = '0'; requestAnimationFrame(step);
  }
}
const sec = (title, body, extra = '') => `<section class="st-sec"${extra}><h3>${title}</h3>${body}</section>`;
const num = (n) => `<b data-count="${n}">${fmtN(n)}</b>`;

function secToday(n, ok, st) {
  const due = S.forecast[0], tmr = S.forecast[1];
  return `<div class="st-tiles">
    <div class="tile"><small>Today</small>${num(n)}<span>${n ? pct(ok, n) + '% recalled' : 'cards reviewed'}</span></div>
    <div class="tile ${st.doneToday ? 'lit' : ''}"><small>Streak</small><b><i class="flame"></i>${st.cur}</b><span>${st.cur === 1 ? 'day' : 'days'}${st.cur && !st.doneToday ? ' · review today to keep it' : ''}</span></div>
    <div class="tile"><small>Due</small>${num(due)}<span>${fmtN(tmr)} tomorrow</span></div>
  </div>`;
}

function secActivity(today, todayN, todayMs) {
  // heatmap: the last 26 weeks, one column per week starting Monday
  const wd = (new Date(today + 'T12:00').getDay() + 6) % 7, start = addDays(today, -(25 * 7 + wd));
  const max = Math.max(1, ...Object.values(S.days).map((d) => d[0]));
  const lvl = (n) => (!n ? 0 : n <= max * 0.25 ? 1 : n <= max * 0.5 ? 2 : n <= max * 0.75 ? 3 : 4);
  let cells = '', months = '', lastM = -1, lastW = -9;
  for (let w = 0; w < 26; w++) {
    const first = addDays(start, w * 7), m = new Date(first + 'T12:00').getMonth();
    // a label needs room for ~3 columns, so skip a month that only just shows at the left edge
    const show = m !== lastM && w < 24 && w - lastW >= 3 && new Date(addDays(first, 14) + 'T12:00').getMonth() === m;
    months += `<span>${show ? new Date(first + 'T12:00').toLocaleDateString('en-GB', { month: 'short' }) : ''}</span>`;
    if (show) lastW = w; lastM = m;
    for (let d = 0; d < 7; d++) {
      const k = addDays(first, d);
      if (k > today) { cells += '<i class="fut"></i>'; continue; }
      const n = k === today ? todayN : (S.days[k] || [0])[0];
      cells += `<i class="l${lvl(n)}${k === today ? ' now' : ''}" data-day="${k}" style="--d:${w * 18}ms"></i>`;
    }
  }
  // the last 30 days as bars
  let bars = '';
  const last = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const vals = last.map((k) => (k === today ? todayN : (S.days[k] || [0])[0])), bmax = Math.max(1, ...vals);
  last.forEach((k, i) => { bars += `<i data-day="${k}" class="${k === today ? 'now' : ''}" style="--h:${vals[i] / bmax};--d:${i * 14}ms"></i>`; });
  let week = 0; for (let i = 0; i < 7; i++) week += dayMs(addDays(today, -i));
  return sec('Activity', `
    <div class="heat"><div class="months">${months}</div><div class="grid">${cells}</div></div>
    <div class="legend"><span>Less</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span></div>
    <div class="bars b30">${bars}</div>
    <p class="st-info" id="stDayInfo">Tap a day to see it.</p>
    <div class="st-row3">
      <div><small>Today</small><b>${fmtMin(todayMs)}</b></div>
      <div><small>This week</small><b>${fmtMin(week)}</b></div>
      <div><small>All time</small><b>${fmtMin(allMs())}</b></div>
    </div>`);
}

function examLine(r) {
  const d = (cfg.exams || {})[r.t];
  if (!d) return '';
  const days = daysUntil(d);
  if (days < 0) return '<p class="ex-line past">Exam date has passed · tap to change it</p>';
  if (!r.unseen) return `<p class="ex-line ok">Every card seen · keep reviewing until the exam</p>`;
  const pace = examPace(r.unseen, r.intro, days) + r.intro;
  const by = days > EXAM_BUFFER ? `${EXAM_BUFFER} days before the exam` : 'before the exam';
  return `<p class="ex-line">About <b>${pace}</b> new card${pace === 1 ? '' : 's'} a day, so you'll have seen all ${fmtN(r.unseen + r.intro)} remaining ${by}${pace >= EXAM_MAX ? ' (capped — you may need a few long days)' : ''}</p>`;
}
function examChip(r) {
  const d = (cfg.exams || {})[r.t], days = d ? daysUntil(d) : null;
  return d ? `<span class="exam-chip${days < 0 ? ' past' : days <= 14 ? ' soon' : ''}">${days < 0 ? 'Exam passed' : days === 0 ? 'Exam today' : `Exam in ${days} day${days === 1 ? '' : 's'}`}</span>`
    : '<span class="exam-chip add">+ Exam date</span>';
}
function secTopics() {
  if (!S.topics.length) return sec('Topics', '<p class="muted">Topics appear once your cards have Topic:: tags.</p>');
  const rows = S.topics.map((r) => {
    const learning = r.total - r.unseen - r.known, d = (cfg.exams || {})[r.t];
    return `<div class="trow" data-topic="${esc(r.t)}">
      <div class="top"><b>${esc(topicName(r.t))}</b>${examChip(r)}</div>
      <div class="stack"><i class="k" style="--w:${r.known / r.total}"></i><i class="y" style="--w:${learning / r.total}"></i><i class="u" style="--w:${r.unseen / r.total}"></i></div>
      <p class="sub">${pct(r.total - r.unseen, r.total)}% seen · ${fmtN(r.known)} known · ${fmtN(learning)} learning · ${fmtN(r.unseen)} new${r.rev >= 5 ? ` · <span class="${r.ok / r.rev < 0.8 ? 'warn' : ''}">${pct(r.ok, r.rev)}% recalled</span>` : ''}</p>
      <div class="ex-slot">${examLine(r)}</div>
      <div class="exam-edit">
        <label>Exam date <input type="date" data-exam="${esc(r.t)}" value="${d || ''}" min="${new Date().toLocaleDateString('en-CA')}"></label>
        <button type="button" class="ghost" data-clear="${esc(r.t)}"${d ? '' : ' hidden'}>Remove</button>
      </div>
    </div>`;
  }).join('');
  return sec('Topics', `<div class="key"><span><i class="k"></i>Known</span><span><i class="y"></i>Learning</span><span><i class="u"></i>New</span></div>${rows}
    <p class="muted fine">Known: you'll next see it in 3+ weeks. Recalled: reviews you got right in the last 30 days.</p>`, ' id="stTopics"');
}

// Lectures: how well you know each one, grouped by topic. The weakest few are called out at the top, and
// tapping a lecture starts a practice round of just its cards.
const lecRecall = (r) => (r.rev >= 5 ? r.ok / r.rev : null);
function lecWeak(r) {          // lower is weaker; only lectures you've mostly started count as weak spots
  if (r.total - r.unseen < r.total * 0.5) return null;
  const rc = lecRecall(r);
  return (r.known / r.total) * 0.5 + (rc === null ? 0.5 : rc) * 0.5 - Math.min(r.hard, 5) * 0.06;
}
function lecRow(r, i, showTopic) {
  const learning = r.total - r.unseen - r.known, rc = lecRecall(r), n = lecNum(r.k);
  const seen = r.total - r.unseen;
  const note = !seen ? 'not started' : seen < r.total * 0.5 ? `${seen} of ${r.total} seen${r.hard ? ` · <span class="warn">${r.hard} struggling</span>` : ''}`
    : `${pct(r.known, r.total)}% known${rc !== null ? ` · <span class="${rc < 0.8 ? 'warn' : ''}">${pct(r.ok, r.rev)}% recalled</span>` : ''}${r.hard ? ` · <span class="warn">${r.hard} struggling</span>` : ''}`;
  return `<button type="button" class="lrow${r.unseen === r.total ? ' unstarted' : ''}" data-lec="${esc(r.k)}" style="--d:${i * 30}ms">
    <span class="ln">${showTopic ? esc(topicName(r.t)) + ' ' : ''}${n < 999 ? 'L' + n : '·'}</span>
    <span class="lt">${esc(lecTitle(r.k))}</span>
    <span class="stack"><i class="k" style="--w:${r.known / r.total}"></i><i class="y" style="--w:${learning / r.total}"></i><i class="u" style="--w:${r.unseen / r.total}"></i></span>
    <small>${note}</small></button>`;
}
function secLectures() {
  const L = S.lectures || [];
  if (!L.length) return '';
  const open = LS.get('stLecOpen', []);
  const weak = L.filter((r) => lecWeak(r) !== null && lecWeak(r) < 0.6).sort((a, b) => lecWeak(a) - lecWeak(b)).slice(0, 3);
  const top = weak.length ? `<h4 class="first">Needs work</h4><div class="llist">${weak.map((r, i) => lecRow(r, i, true)).join('')}</div>` : '';
  const groups = S.topics.map((t) => {
    const rows = L.filter((r) => r.t === t.t).sort((a, b) => byLec(a.k, b.k));
    if (!rows.length) return '';
    const started = rows.filter((r) => r.unseen < r.total).length;
    return `<details class="lgroup" data-topic="${esc(t.t)}"${open.includes(t.t) ? ' open' : ''}>
      <summary><b>${esc(topicName(t.t))}</b><span>${started} of ${rows.length} started</span></summary>
      <div class="llist">${rows.map((r, i) => lecRow(r, i, false)).join('')}</div></details>`;
  }).join('');
  return sec('Lectures', `<p class="muted fine top">How well you know each lecture. Tap one to practise just its cards.</p>${top}${weak.length ? '<h4>By topic</h4>' : ''}${groups}`, ' id="stLectures"');
}

function secForecast() {
  const n = LS.get('stRange', 7), f = S.forecast.slice(0, n), max = Math.max(1, ...f), today = dayKey(Date.now());
  const date = (i, o) => new Date(addDays(today, i) + 'T12:00').toLocaleDateString('en-GB', o);
  const name = (i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : i < 7 ? date(i, { weekday: 'long' }) : date(i, { weekday: 'short', day: 'numeric', month: 'short' }));
  const bars = f.map((v, i) => `<div class="fc"><em>${n === 7 || v === max ? v : ''}</em><i style="--h:${v / max};--d:${i * (n === 7 ? 40 : 14)}ms"${i === 0 ? ' class="now"' : ''}></i>${n === 7 ? `<span>${i ? date(i, { weekday: 'short' }) : 'Today'}</span>` : ''}</div>`).join('');
  // 30 days: a few date marks under the bars instead of one per bar
  const marks = n === 30 ? `<div class="flabels">${[0, 7, 14, 21].map((i) => `<span style="left:${(i / 30) * 100}%">${i ? date(i, { day: 'numeric', month: 'short' }) : 'Today'}</span>`).join('')}</div>` : '';
  const total = f.reduce((a, b) => a + b, 0), peak = f.indexOf(max);
  return sec('Coming up', `
    <div class="seg two st-range"><button type="button" data-range="7" class="${n === 7 ? 'on' : ''}">7 days</button><button type="button" data-range="30" class="${n === 30 ? 'on' : ''}">30 days</button></div>
    <div class="fbars n${n}">${bars}</div>${marks}
    <p class="st-info">${fmtN(total)} reviews in the next ${n} days${peak > 0 && max > 1.6 * (total / n) ? ` · busiest: <b>${name(peak)}</b> (${max})` : ''}</p>`);
}

function secStruggle() {
  const list = S.hard.length ? S.hard.map((h, i) => `<button type="button" class="hrow" data-card="${h.id}" style="--d:${i * 40}ms">
      <span class="n">${h.n}×</span><span class="t">${esc(h.text)}</span>${h.topic ? `<small>${esc(topicName(h.topic))}</small>` : ''}</button>`).join('')
    : '<p class="muted">No card has been missed 3 or more times. Nice.</p>';
  const [a, h, g, e] = S.buttons, tot = a + h + g + e;
  let note = '';
  if (tot >= 30) {
    if (e / tot > 0.3) note = "You press Easy a lot. Save it for answers that took no effort, or cards come back too rarely to stick.";
    else if (h / tot > 0.25) note = 'You press Hard a lot. If you got it right, Good is usually the better choice.';
    else if (a / tot < 0.05) note = 'Very few misses. Make sure you only count it when you really remembered it.';
    else note = 'A healthy mix: mostly Good, with some misses.';
  }
  const grade = tot ? `<div class="grade">${[[a, 'again', 'Again'], [h, 'hard', 'Hard'], [g, 'good', 'Good'], [e, 'easy', 'Easy']].map(([v, c]) => `<i class="${c}" style="--w:${v / tot}"></i>`).join('')}</div>
    <div class="glabels">${[[a, 'again', 'Again'], [h, 'hard', 'Hard'], [g, 'good', 'Good'], [e, 'easy', 'Easy']].map(([v, c, n]) => `<span class="${c}"><b>${pct(v, tot)}%</b>${n}</span>`).join('')}</div>
    ${note ? `<p class="st-info">${note}</p>` : ''}` : '<p class="muted">Not enough reviews in the last 30 days yet.</p>';
  return sec('Struggling cards', `<p class="muted fine top">The cards you've pressed Again on most. Tap one to see it.</p><div class="hlist">${list}</div>`)
    + sec('How you grade', `<p class="muted fine top">Reviews in the last 30 days</p>${grade}`);
}

function badgeState(st, bestCombo) {
  const have = { reviews: S.reviews + (cfg.demo ? 0 : queue.filter((x) => x.t > S.at).length), streak: st.best, combo: bestCombo };
  return Object.entries(BADGES).map(([k, b]) => {
    const got = b.steps.filter((s) => have[k] >= s), next = b.steps.find((s) => have[k] < s);
    return { k, b, v: have[k], got, next };
  });
}
function secRecords(st, bestCombo, todayN) {
  const bestDay = Math.max(todayN, ...Object.values(S.days).map((d) => d[0]), 0);
  const goals = badgeState(st, bestCombo).map(({ b, v, got, next }) => {
    const prev = got.length ? got[got.length - 1] : 0, k = next ? (v - prev) / (next - prev) : 1;
    return `<div class="goal"><div class="gtop"><b>${b.name}</b><span>${next ? `${fmtN(v)} / ${fmtN(next)}` : 'All done'}</span></div>
      <div class="gbar"><i style="--w:${Math.max(0.02, k)}"></i></div>
      <div class="pips">${b.steps.map((s) => `<i class="${v >= s ? 'on' : ''}" title="${esc(b.fmt(s))}"></i>`).join('')}<small>${got.length} of ${b.steps.length}</small></div></div>`;
  }).join('');
  return sec('Records', `<div class="st-tiles four">
      <div class="tile"><small>Best combo</small><b>${bestCombo ? '×' + bestCombo : '—'}</b><span>in a row</span></div>
      <div class="tile"><small>Longest streak</small><b>${st.best}</b><span>days</span></div>
      <div class="tile"><small>Best day</small>${num(bestDay)}<span>cards</span></div>
      <div class="tile"><small>All time</small>${num(S.reviews)}<span>reviews</span></div>
    </div><h4>Goals</h4>${goals}`);
}

// A badge you've just earned gets a little celebration the next time you open the page (once).
function badgeCheck(st, bestCombo) {
  if (S.demo) return;
  const earned = badgeState(st, bestCombo).flatMap(({ k, b, got }) => got.map((s) => [`${k}:${s}`, b.fmt(s)]));
  if (!records.badges) { records.badges = earned.map(([id]) => id); LS.set('records', records); return; }  // first visit: no fanfare for old ones
  const fresh = earned.filter(([id]) => !records.badges.includes(id));
  if (!fresh.length) return;
  records.badges.push(...fresh.map(([id]) => id)); LS.set('records', records);
  setTimeout(() => { if (!stOpen) return; toast(`New goal reached: ${fresh[fresh.length - 1][1]}`); SFX.streak(15); celebrate(1); haptic(2); }, 700);
}

/* ---------- interaction ---------- */
function dayInfo(k) {
  const today = dayKey(Date.now()), d = S.days[k] || [0, 0, 0];
  const n = k === today ? d[0] + (cfg.demo ? 0 : queue.filter((a) => a.t > S.at).length) : d[0];
  const name = k === today ? 'Today' : new Date(k + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return n ? `<b>${name}</b> · ${fmtN(n)} card${n === 1 ? '' : 's'} · ${fmtMin(dayMs(k))}${d[0] ? ` · ${pct(d[2], d[0])}% recalled` : ''}` : `<b>${name}</b> · no reviews`;
}
stBody.addEventListener('click', async (e) => {
  const t = e.target;
  const day = t.closest('[data-day]');
  if (day) {
    stBody.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    stBody.querySelectorAll(`[data-day="${day.dataset.day}"]`).forEach((x) => x.classList.add('sel'));
    $('#stDayInfo').innerHTML = dayInfo(day.dataset.day);
    SFX.cell(+((day.className.match(/l(\d)/) || [0, 2])[1])); haptic(1);
    return;
  }
  const range = t.closest('[data-range]');
  if (range) {
    LS.set('stRange', +range.dataset.range);
    const old = range.closest('.st-sec'); old.outerHTML = secForecast();
    requestAnimationFrame(() => stBody.querySelectorAll('.fbars').forEach((b) => b.classList.add('grow')));
    SFX.pick(); haptic(1);
    return;
  }
  const clear = t.closest('[data-clear]');
  if (clear) { setExam(clear.dataset.clear, ''); return; }
  if (t.closest('.exam-edit')) return;
  const row = t.closest('.trow');
  if (row) {
    const open = !row.classList.contains('open');
    stBody.querySelectorAll('.trow.open').forEach((r) => r.classList.remove('open'));
    row.classList.toggle('open', open);
    if (open) { SFX.open(); const inp = row.querySelector('input'); if (inp && !inp.value && inp.showPicker) try { inp.showPicker(); } catch {} } else SFX.close();
    haptic(1);
    return;
  }
  const lec = t.closest('[data-lec]');
  if (lec) { practiseLecture(lec.dataset.lec); return; }
  const card = t.closest('[data-card]');
  if (card) openStruggler(+card.dataset.card);
});
// opening / closing a topic's lecture list: remembered, with the same sounds as other panels
stBody.addEventListener('toggle', (e) => {
  const g = e.target.closest && e.target.closest('.lgroup');
  if (!g) return;
  const open = new Set(LS.get('stLecOpen', []));
  if (g.open) open.add(g.dataset.topic); else open.delete(g.dataset.topic);
  LS.set('stLecOpen', [...open]);
  if (stOpen) { (g.open ? SFX.open : SFX.close)(); haptic(1); }
}, true);
// A random practice round of one lecture's cards (the Practice tab then shows that lecture picked)
async function practiseLecture(k) {
  const t = k.split('::')[0];
  cfg.pTopics = [t]; cfg.pLectures = [k]; saveCfg();
  const mode = cfg.pMode; cfg.pMode = 'random';
  closeStats();
  try { await startPractice([t]); } finally { cfg.pMode = mode; saveCfg(); }
  if (!practice || practice.topics[0] !== t) toast($('#pMsg').textContent || 'No cards for that lecture on this phone yet');
}
// iOS fills an empty date box with today and fires "change" as soon as its picker opens, and again on
// every scroll of the wheel. So the date box is never rebuilt while you use it (that closed the picker):
// only the row's badge, pacing line and Remove button update in place. The confirmation sound waits until
// the picker closes, and closing it on today's date after starting from an empty box counts as cancelled.
stBody.addEventListener('focusin', (e) => {
  const inp = e.target.closest('[data-exam]');
  if (inp) inp.dataset.was = (cfg.exams || {})[inp.dataset.exam] || '';
});
stBody.addEventListener('change', (e) => {
  const inp = e.target.closest('[data-exam]');
  if (inp) setExam(inp.dataset.exam, inp.value, true);
});
stBody.addEventListener('focusout', (e) => {
  const inp = e.target.closest('[data-exam]');
  if (!inp || inp.dataset.was === undefined) return;
  const was = inp.dataset.was; delete inp.dataset.was;
  const today = new Date().toLocaleDateString('en-CA');
  if (!was && inp.value === today) { inp.value = ''; setExam(inp.dataset.exam, '', true); return; }   // just opened and closed
  if (inp.value !== was) { SFX[inp.value ? 'set' : 'pick'](false); haptic(inp.value ? 2 : 1); flashRow(inp.dataset.exam); }
});
const rowOf = (topic) => [...stBody.querySelectorAll('.trow')].find((r) => r.dataset.topic === topic);
function flashRow(topic) { const row = rowOf(topic); if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); } }
function setExam(topic, date, quiet) {
  cfg.exams = { ...(cfg.exams || {}) };
  if (date) cfg.exams[topic] = date; else delete cfg.exams[topic];
  saveCfg(); examChanged = true;
  const row = rowOf(topic), r = S.topics.find((x) => x.t === topic);
  if (row && r) {
    row.querySelector('.exam-chip').outerHTML = examChip(r);
    row.querySelector('.ex-slot').innerHTML = examLine(r);
    row.querySelector('[data-clear]').hidden = !date;
    if (!date) row.querySelector('[data-exam]').value = '';
  }
  if (!quiet) { flashRow(topic); if (date) { SFX.set(); haptic(2); } else { SFX.pick(false); haptic(1); } }
}
async function openStruggler(id) {
  if (!id) { toast('Demo card'); return; }
  haptic(1);
  let c = deck.find((x) => x.id === id) || (practice && practice.saved.deck.find((x) => x.id === id));
  if (!c) { const pc = (await IDB.get('pcache')) || {}; c = pc[id]; }
  if (!c) {
    try { c = (await buildCards(await cardsInfo([id]), exAll || (await IDB.get('ex')) || {}))[0]; }
    catch { toast('Connect to Anki to open this card'); return; }
  }
  if (c) openExplain(c, 'view');
}

$('#statsBtn').onclick = openStats;
$('#doneStatsBtn').onclick = openStats;
$('#stats .scrim').onclick = closeStats;
$('#stClose').onclick = closeStats;
stPanel.addEventListener('scroll', () => stPanel.classList.toggle('scrolled', stPanel.scrollTop > 4), { passive: true });
setInterval(() => { if (stOpen) whenLine(); }, 30000);
