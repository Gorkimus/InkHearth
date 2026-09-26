import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { eventWords, eventPages, eventHours } from '../wordcount.js';
import { parseJsonArr } from '../jsonarr.js';

const r = Router();

// Trailing-window keys must come from LOCAL date parts: toISOString() on a
// locally-constructed date converts to UTC, which shifts month/day labels
// back by one for any positive-UTC-offset host.
const localMonthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const localDayKey = (d) => `${localMonthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

// The dashboard aggregates read + listened into one "words read" number;
// format splits remain available as secondary views.
r.get('/stats', (req, res) => {
  const uid = currentUserId();
  const books = new Map(
    db.prepare('SELECT * FROM books WHERE user_id=?').all(uid).map((b) => [b.id, b])
  );
  const events = db.prepare('SELECT * FROM events WHERE user_id=?').all(uid);

  const yearKey = (ev) =>
    ev.finished_at ? ev.finished_at.slice(0, 4) : ev.finished_year ? String(ev.finished_year) : null;
  const thisYear = String(new Date().getFullYear());
  const countable = (ev) => ev.status === 'finished' || ev.status === 'dnf';

  function totals(filter) {
    let books_read = 0, words = 0, pages = 0, hours = 0, dnfs = 0, any_estimated = false, any_unknown = false;
    for (const ev of events) {
      if (!countable(ev) || !filter(ev)) continue;
      const b = books.get(ev.book_id);
      const w = eventWords(b, ev);
      books_read += 1;
      words += w.words;
      pages += eventPages(b, ev);
      hours += eventHours(b, ev);
      if (ev.status === 'dnf') dnfs += 1;
      if (w.source === 'estimated') any_estimated = true;
      if (w.source === 'unknown') any_unknown = true;
    }
    return { books_read, words, pages, hours: Math.round(hours * 10) / 10, dnfs, any_estimated, any_unknown };
  }

  // Words per month across all history (finished_at-dated events only —
  // memory-lane year-only entries have no month to land in). The dashboard's
  // trailing-12 chart and the all-time pace strip both derive from this.
  const monthAgg = new Map();
  // Activity calendar: finished/DNF finish days for the heatmap.
  const dayAgg = new Map();
  const yearsMap = new Map();

  const genreCount = new Map();
  const tagAgg = new Map();
  const moodAgg = new Map();
  const authorAgg = new Map();
  const narratorAgg = new Map();
  const tierCount = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const formats = { read: { books: 0, words: 0, pages: 0 }, listened: { books: 0, words: 0, hours: 0 } };
  const reading_now = [];

  for (const ev of events) {
    const b = books.get(ev.book_id);
    const yk = yearKey(ev);
    if (yk) {
      if (!yearsMap.has(yk)) yearsMap.set(yk, { year: yk, books: 0, words: 0 });
      const y = yearsMap.get(yk);
      if (countable(ev)) { y.books += 1; y.words += eventWords(b, ev).words; }
    }
    const mk = ev.finished_at ? ev.finished_at.slice(0, 7) : null;
    if (mk && countable(ev)) {
      if (!monthAgg.has(mk)) monthAgg.set(mk, { key: mk, words: 0, books: 0 });
      const m = monthAgg.get(mk);
      m.words += eventWords(b, ev).words;
      m.books += 1;
    }
    const dk = ev.finished_at ? ev.finished_at.slice(0, 10) : null;
    if (dk && countable(ev)) {
      if (!dayAgg.has(dk)) dayAgg.set(dk, { books: 0, words: 0 });
      const d = dayAgg.get(dk);
      d.books += 1;
      d.words += eventWords(b, ev).words;
    }
    if (countable(ev)) {
      const f = formats[ev.format] || (formats[ev.format] = { books: 0, words: 0 });
      f.books += 1;
      f.words += eventWords(b, ev).words;
      if (ev.format === 'read') f.pages += eventPages(b, ev);
      else f.hours += eventHours(b, ev);
      for (const g of parseJsonArr(b.genres)) {
        genreCount.set(g, (genreCount.get(g) || 0) + 1);
      }
      // Personal tags and imported moods: words-weighted like authors, so the
      // bar chart ranks by reading volume rather than bare counts.
      for (const t of parseJsonArr(b.tags)) {
        const e = tagAgg.get(t) || { tag: t, books: 0, words: 0 };
        e.books += 1;
        e.words += eventWords(b, ev).words;
        tagAgg.set(t, e);
      }
      for (const m of parseJsonArr(b.moods)) {
        const e = moodAgg.get(m) || { mood: m, books: 0, words: 0 };
        e.books += 1;
        e.words += eventWords(b, ev).words;
        moodAgg.set(m, e);
      }
      const author = b.author || 'Unknown';
      if (!authorAgg.has(author)) authorAgg.set(author, { author, books: 0, words: 0 });
      const a = authorAgg.get(author);
      a.books += 1;
      a.words += eventWords(b, ev).words;
      if (ev.rating) tierCount[ev.rating] += 1;
      if (ev.format === 'listened' && b.narrator) {
        const n = narratorAgg.get(b.narrator) || { name: b.narrator, books: 0, score: 0, rated: 0 };
        n.books += 1;
        if (ev.narration_rating) {
          n.score += { S: 5, A: 4, B: 3, C: 2, D: 1 }[ev.narration_rating];
          n.rated += 1;
        }
        narratorAgg.set(b.narrator, n);
      }
    }
    if (ev.status === 'reading') {
      // The now-reading hero: everything the one-tap card needs, including
      // "how much is left" in the format's own currency.
      const remaining = 1 - (ev.percent ?? 0) / 100;
      reading_now.push({
        event_id: ev.id, book_id: b.id, title: b.title, author: b.author,
        format: ev.format, started_at: ev.started_at, percent: ev.percent ?? null,
        cover_url: b.cover_url || null, on_pause: !!b.on_pause,
        page_count: b.page_count || null, audio_runtime_minutes: b.audio_runtime_minutes || null,
        est_hours_left: ev.format === 'listened' && b.audio_runtime_minutes
          ? Math.round((b.audio_runtime_minutes / 60) * remaining * 10) / 10 : null,
        est_pages_left: ev.format === 'read' && b.page_count
          ? Math.max(0, Math.round(b.page_count * remaining)) : null,
      });
    }
  }

  // Trailing 12 months for the dashboard card (empty months included so the
  // year shape stays readable); plus the no-gap all-history series.
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = localMonthKey(d);
    const agg = monthAgg.get(key);
    months.push({ key, label: d.toLocaleString('en', { month: 'short' }), words: agg?.words || 0, books: agg?.books || 0 });
  }
  const months_all = [];
  if (monthAgg.size) {
    const keys = [...monthAgg.keys()].sort();
    let [y, mo] = keys[0].split('-').map(Number);
    const [endY, endMo] = keys[keys.length - 1].split('-').map(Number);
    while (y < endY || (y === endY && mo <= endMo)) {
      const key = `${y}-${String(mo).padStart(2, '0')}`;
      const agg = monthAgg.get(key);
      const d = new Date(y, mo - 1, 1);
      months_all.push({
        key,
        // Label shows the year in January (and on the first bar) — the rest are month names.
        label: mo === 1 || months_all.length === 0 ? String(y) : d.toLocaleString('en', { month: 'short' }),
        full: d.toLocaleString('en', { month: 'short' }) + ' ' + y,
        words: agg?.words || 0, books: agg?.books || 0,
      });
      mo += 1;
      if (mo > 12) { mo = 1; y += 1; }
    }
  }

  // Yearly goals (users.prefs.goals: {books, words, hours} targets) judged
  // against this-year totals, plus momentum: this month vs the trailing
  // 3 completed months.
  const ty = totals((ev) => yearKey(ev) === thisYear);
  let prefs = {};
  try { prefs = JSON.parse(db.prepare('SELECT prefs FROM users WHERE id=?').get(uid)?.prefs || '{}'); } catch { /* no goals */ }
  const goalTargets = prefs.goals || {};
  const goals = {};
  for (const [metric, done] of [['books', ty.books_read], ['words', ty.words], ['hours', ty.hours]]) {
    const target = Number(goalTargets[metric]) || 0;
    if (target > 0) goals[metric] = { target, done, pct: Math.max(0, Math.min(100, Math.round((done / target) * 100))) };
  }
  const monthWords = (key) => monthAgg.get(key)?.words || 0;
  const nowKey = localMonthKey(now);
  const prevKeys = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    prevKeys.push(localMonthKey(d));
  }
  const trailingAvg = Math.round(prevKeys.reduce((sum, k) => sum + monthWords(k), 0) / 3);
  const momentum = { this_month: monthWords(nowKey), trailing_avg: trailingAvg };

  // Trailing-365 day series for the heatmap (no gaps).
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDayKey(d);
    const agg = dayAgg.get(key);
    days.push({ date: key, books: agg?.books || 0, words: agg?.words || 0 });
  }

  // Reading streaks over that window (a day counts when anything finished).
  // Today without a finish doesn't break the current streak — it's just not
  // over yet, so the walk starts at yesterday in that case.
  const active = (d) => d.books > 0;
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (!active(days[i])) { if (i === days.length - 1) continue; break; }
    current += 1;
  }
  let longest = 0;
  for (let run = 0, i = 0; i < days.length; i++) {
    run = active(days[i]) ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  res.json({
    all_time: totals(() => true),
    this_year: ty,
    months,
    months_all,
    days,
    streaks: { current, longest },
    goals,
    momentum,
    years: [...yearsMap.values()].sort((a, b) => a.year.localeCompare(b.year)),
    genres: [...genreCount.entries()].map(([genre, books]) => ({ genre, books })).sort((a, b) => b.books - a.books),
    tags: [...tagAgg.values()].sort((a, b) => b.words - a.words).slice(0, 10),
    moods: [...moodAgg.values()].sort((a, b) => b.words - a.words).slice(0, 10),
    authors: [...authorAgg.values()].sort((a, b) => b.words - a.words).slice(0, 10),
    narrators: [...narratorAgg.values()].sort((a, b) => b.books - a.books)
      .map((n) => ({ name: n.name, books: n.books, avg_tier: n.rated ? [null, 'D', 'C', 'B', 'A', 'S'][Math.round(n.score / n.rated)] : null })),
    tiers: tierCount,
    formats,
    reading_now,
  });
});

// Year-in-review: one year's full story. Year-only entries (Memory lane)
// count toward everything except the monthly buckets, which need real dates.
r.get('/stats/year/:year', (req, res) => {
  const uid = currentUserId();
  const year = String(req.params.year);
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'year must be YYYY' });
  const books = new Map(
    db.prepare('SELECT * FROM books WHERE user_id=?').all(uid).map((b) => [b.id, b])
  );
  const events = db.prepare('SELECT * FROM events WHERE user_id=?').all(uid);

  const yearKey = (ev) =>
    ev.finished_at ? ev.finished_at.slice(0, 4) : ev.finished_year ? String(ev.finished_year) : null;
  const inYear = (ev) => yearKey(ev) === year;
  const countable = (ev) => ev.status === 'finished' || ev.status === 'dnf';
  const SCORE = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const TIER = [null, 'D', 'C', 'B', 'A', 'S'];

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    months.push({ key, label: new Date(year, m - 1, 1).toLocaleString('en', { month: 'short' }), words: 0, books: 0 });
  }
  const byMonth = new Map(months.map((m) => [m.key, m]));
  const byDay = new Map();

  const totals = { books_read: 0, words: 0, pages: 0, hours: 0, dnfs: 0, any_estimated: false, any_unknown: false };
  const tiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const formats = { read: { books: 0, words: 0, pages: 0 }, listened: { books: 0, words: 0, hours: 0 } };
  const genreCount = new Map();
  const tagAgg = new Map();
  const moodAgg = new Map();
  const authorAgg = new Map();
  const narratorAgg = new Map();
  const dnfs = [];
  const top_books = [];

  for (const ev of events) {
    if (!inYear(ev)) continue;
    const b = books.get(ev.book_id);
    if (ev.status === 'dnf') {
      dnfs.push({ book_id: b.id, title: b.title, author: b.author, dnf_percent: ev.dnf_percent || null });
    }
    if (!countable(ev)) continue;

    const w = eventWords(b, ev);
    totals.books_read += 1;
    totals.words += w.words;
    totals.pages += eventPages(b, ev);
    totals.hours += eventHours(b, ev);
    if (w.source === 'estimated') totals.any_estimated = true;
    if (w.source === 'unknown') totals.any_unknown = true;
    if (ev.status === 'dnf') totals.dnfs += 1;
    if (ev.rating) tiers[ev.rating] += 1;

    const f = formats[ev.format] || (formats[ev.format] = { books: 0, words: 0 });
    f.books += 1;
    f.words += w.words;
    if (ev.format === 'read') f.pages += eventPages(b, ev);
    else f.hours += eventHours(b, ev);

    const mk = ev.finished_at ? ev.finished_at.slice(0, 7) : null;
    if (mk && byMonth.has(mk)) {
      const m = byMonth.get(mk);
      m.words += w.words;
      m.books += 1;
    }
    const dk = ev.finished_at ? ev.finished_at.slice(0, 10) : null;
    if (dk) {
      if (!byDay.has(dk)) byDay.set(dk, { books: 0, words: 0 });
      const d = byDay.get(dk);
      d.books += 1;
      d.words += w.words;
    }

    for (const g of parseJsonArr(b.genres)) {
      genreCount.set(g, (genreCount.get(g) || 0) + 1);
    }
    // Personal tags and imported moods: words-weighted like authors.
    for (const t of parseJsonArr(b.tags)) {
      const e = tagAgg.get(t) || { tag: t, books: 0, words: 0 };
      e.books += 1;
      e.words += w.words;
      tagAgg.set(t, e);
    }
    for (const m of parseJsonArr(b.moods)) {
      const e = moodAgg.get(m) || { mood: m, books: 0, words: 0 };
      e.books += 1;
      e.words += w.words;
      moodAgg.set(m, e);
    }
    const author = b.author || 'Unknown';
    if (!authorAgg.has(author)) authorAgg.set(author, { author, books: 0, words: 0, score: 0, rated: 0 });
    const a = authorAgg.get(author);
    a.books += 1;
    a.words += w.words;
    if (ev.rating) { a.score += SCORE[ev.rating]; a.rated += 1; }

    if (ev.format === 'listened' && b.narrator) {
      if (!narratorAgg.has(b.narrator)) narratorAgg.set(b.narrator, { name: b.narrator, books: 0, score: 0, rated: 0 });
      const n = narratorAgg.get(b.narrator);
      n.books += 1;
      if (ev.narration_rating) { n.score += SCORE[ev.narration_rating]; n.rated += 1; }
    }

    top_books.push({
      book_id: b.id, title: b.title, author: b.author, rating: ev.rating,
      format: ev.format, words: w.words,
      finished: ev.finished_at ? ev.finished_at.slice(0, 10) : String(ev.finished_year || ''),
    });
  }

  top_books.sort((x, y) => y.words - x.words);
  // Every day of the reviewed year, no gaps — the heatmap's input. The loop
  // is UTC-anchored, so UTC formatting (not localDayKey) is correct here.
  const days = [];
  for (let d = new Date(Date.UTC(Number(year), 0, 1)); d.getUTCFullYear() === Number(year); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const agg = byDay.get(key);
    days.push({ date: key, books: agg?.books || 0, words: agg?.words || 0 });
  }
  res.json({
    year,
    totals: { ...totals, hours: Math.round(totals.hours * 10) / 10 },
    months,
    days,
    tiers,
    formats,
    genres: [...genreCount.entries()].map(([genre, books]) => ({ genre, books })).sort((a, b) => b.books - a.books),
    tags: [...tagAgg.values()].sort((a, b) => b.words - a.words).slice(0, 10),
    moods: [...moodAgg.values()].sort((a, b) => b.words - a.words).slice(0, 10),
    authors: [...authorAgg.values()].sort((a, b) => b.words - a.words)
      .map((a) => ({ author: a.author, books: a.books, words: a.words, avg_tier: a.rated ? TIER[Math.round(a.score / a.rated)] : null })),
    narrators: [...narratorAgg.values()].sort((a, b) => b.books - a.books)
      .map((n) => ({ name: n.name, books: n.books, avg_tier: n.rated ? TIER[Math.round(n.score / n.rated)] : null })),
    dnfs,
    top_books,
  });
});

export default r;
