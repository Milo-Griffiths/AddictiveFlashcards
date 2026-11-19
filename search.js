'use strict';
/* Search every card by its question, answer or explanation, from the top of the topics sheet.
   Works offline: a light text index of the whole deck (no images) is kept on the phone and refreshed
   after a sync, at most every 12 hours. Every word you type must appear somewhere on the card;
   matches in the question rank first, then the answer, then the explanation. */
const Search = (() => {
  const inp = $('#sQ'), list = $('#sResults'), panel = $('#topics .panel'), clearBtn = $('#sClear');
  let index = null, building = false, timer = 0, lastCount = -1;

  // text only, via an inert <template> so nothing in a card (an image's onerror, say) can run
  const plain = (h) => {
    const t = document.createElement('template');
    t.innerHTML = clean(h || '').replace(/<br\s*\/?>|<\/(p|li|div|tr|pre)>/gi, ' ');
    t.content.querySelectorAll('img, svg').forEach((n) => n.remove());
    return t.content.textContent.replace(/\s+/g, ' ').trim();
  };
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function prep(rows, ex) {
    for (const r of rows) {
      r.q = r.q || plain(r.qh); r.a = r.a || plain(r.ah);
      r.e = ex && r.n != null && ex[r.n] ? plain(ex[r.n]) : r.ex0 ? plain(r.ex0) : '';
      r.lq = norm(r.q); r.la = norm(r.a); r.le = norm(r.e);
    }
    return rows;
  }
  // Before the first index exists (and always in the demo): every card already on the phone, including
  // ones answered today and practice cards. Demo cards have no note id, so cards are told apart by card id.
  let localCache = null;
  async function localRows() {
    const pc = (await IDB.get('pcache')) || {};
    const demo = cfg.demo ? DEMO.map((c, i) => ({ topic: null, ex: null, ...c, id: i + 1, note: undefined })) : [];
    const all = [...demo, ...deck, ...ahead, ...(practice ? practice.saved.deck : []), ...history.map((h) => h.card), ...Object.values(pc)];
    const seen = new Set(), out = [], ex = exAll || (await IDB.get('ex')) || {};
    for (const c of all) {
      const k = c.note != null ? 'n' + c.note : 'c' + c.id;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ n: c.note, c: c.id, t: c.topic, qh: c.q, ah: c.a, e0: c.ex });
    }
    for (const r of out) if (!ex[r.n] && r.e0) r.ex0 = r.e0;
    return prep(out, ex);
  }

  async function build(force) {
    if (cfg.demo || !cfg.url || building) return;
    if (!force && index && Date.now() - LS.get('searchAt', 0) < 12 * 3600e3) return;
    building = true;
    try {
      const ids = await anki('findNotes', { query: cfg.deck ? `deck:${q(cfg.deck)}` : 'deck:*' }, 15000);
      const rows = [];
      for (let i = 0; i < ids.length; i += 250) {
        for (const n of await anki('notesInfo', { notes: ids.slice(i, i + 250) }, 30000)) {
          const f = n.fields || {}, names = Object.keys(f).sort((a, b) => f[a].order - f[b].order);
          const t = (n.tags || []).find((x) => x.startsWith('Topic::'));
          rows.push({ n: n.noteId, c: (n.cards || [])[0], t: t ? t.slice(7) : null, qh: (f[names[0]] || {}).value || '', ah: (f[names[1]] || {}).value || '' });
        }
      }
      // store the raw rows (smaller); the text is worked out again when the app opens
      IDB.set('searchIndex', rows.map(({ n, c, t, qh, ah }) => ({ n, c, t, qh, ah })));
      LS.set('searchAt', Date.now());
      index = prep(rows, exAll || (await IDB.get('ex')) || {});
      if (inp.value.trim()) run();
    } catch (e) { console.warn('search index failed', e); } finally { building = false; }
  }

  function snippet(text, words, max = 120) {
    if (text.length <= max) return text;
    const lt = norm(text);
    let at = -1;
    for (const w of words) { const i = lt.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
    if (at < 0) return text.slice(0, max) + (text.length > max ? '…' : '');
    const start = Math.max(0, at - 40), s = text.slice(start, start + max);
    return (start ? '…' : '') + s + (start + max < text.length ? '…' : '');
  }
  // highlight on the raw text, then escape each piece, so a match can never split an HTML entity
  const mark = (text, words) => {
    if (!words.length) return esc(text);
    const re = new RegExp('(' + words.map(reEsc).join('|') + ')', 'gi');
    return text.split(re).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
  };

  async function run() {
    const raw = inp.value.trim();
    clearBtn.hidden = !raw;
    panel.classList.toggle('searching', !!raw);
    list.hidden = !raw;
    if (!raw) { lastCount = -1; return; }
    const words = norm(raw).split(/\s+/).filter(Boolean);
    const rows = (!cfg.demo && index) || localCache || (localCache = await localRows()), hits = [];
    if (raw !== inp.value.trim()) return;   // you kept typing while the phone's cards were read
    for (const r of rows) {
      let score = 0, where = '';
      for (const w of words) {
        const iq = r.lq.indexOf(w), ia = r.la.indexOf(w), ie = r.le.indexOf(w);
        if (iq < 0 && ia < 0 && ie < 0) { score = -1; break; }
        if (iq >= 0) score += iq === 0 ? 4 : 3; else if (ia >= 0) { score += 2; where = where || 'a'; } else { score += 1; where = where || 'e'; }
      }
      if (score > 0) hits.push([score, r, where]);
    }
    hits.sort((x, y) => y[0] - x[0]);
    const shown = hits.slice(0, 40);
    list.innerHTML = (shown.length
      ? `<p class="scount">${hits.length > 40 ? `Top 40 of ${hits.length}` : `${hits.length} card${hits.length === 1 ? '' : 's'}`}${index ? '' : ' · on this phone so far'}</p>`
        + shown.map(([, r, where], i) => {
          const sub = where === 'e' ? snippet(r.e, words) : snippet(r.a, words);
          return `<button type="button" class="sres" data-i="${i}" style="--d:${Math.min(i, 12) * 18}ms">
            <span class="stop">${r.t ? `<i>${esc(topicName(r.t))}</i>` : ''}${where === 'e' ? '<em>in explanation</em>' : ''}</span>
            <b>${mark(snippet(r.q, words, 160), words)}</b><small>${mark(sub, words)}</small></button>`;
        }).join('')
      : `<p class="snone">No cards match “${esc(raw)}”</p>`);
    list._hits = shown.map((h) => h[1]);
    if (hits.length !== lastCount) { if (lastCount !== -1 || hits.length) SFX.cell(hits.length ? 3 : 0); lastCount = hits.length; }
  }

  async function open(r) {
    haptic(1);
    const same = (x) => (r.n != null ? x.note === r.n : x.id === r.c);
    const mine = [...deck, ...ahead, ...(practice ? practice.saved.deck : []), ...history.map((h) => h.card)].find(same);
    let c = mine;
    if (!c && cfg.demo) { const i = DEMO.findIndex((_, j) => j + 1 === r.c); if (i >= 0) c = { topic: null, ex: null, ...DEMO[i], id: r.c, deck: 'Demo' }; }
    if (!c) { const pc = (await IDB.get('pcache')) || {}; c = Object.values(pc).find(same); }
    if (!c && cfg.url && !cfg.demo) {
      try {
        const cid = r.c || (await anki('findCards', { query: `nid:${r.n}` }, 5000))[0];
        c = (await buildCards(await cardsInfo([cid]), exAll || (await IDB.get('ex')) || {}))[0];
      } catch {}
    }
    if (!c) {   // offline and not on the phone: show its text; diagrams need Anki to load
      const noImg = (h) => clean(h).replace(/<img[^>]*>/gi, '<p class="muted">(diagram loads when Anki is reachable)</p>');
      c = { id: r.c, note: r.n, topic: r.t, q: noImg(r.qh), a: noImg(r.ah), ex: (exAll || (await IDB.get('ex')) || {})[r.n] || r.ex0 || null };
    }
    openExplain(c, 'view');
  }

  let debounce = 0;
  inp.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 120); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } if (e.key === 'Escape') { reset(); SFX.pick(false); } });
  clearBtn.addEventListener('click', () => { reset(); inp.focus(); SFX.pick(false); haptic(1); });
  list.addEventListener('click', (e) => { const b = e.target.closest('.sres'); if (b) open(list._hits[+b.dataset.i]); });
  function reset() { inp.value = ''; localCache = null; run(); }

  IDB.get('searchIndex').then(async (rows) => { if (rows && rows.length && !index) index = prep(rows, exAll || (await IDB.get('ex')) || {}); });
  return { build, reset, run, focus: () => setTimeout(() => inp.focus(), 60) };
})();
