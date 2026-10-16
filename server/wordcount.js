export const WORDS_PER_PAGE = 275;
export const WORDS_PER_LISTENING_HOUR = 9300; // ~155 wpm narration

// Real word count (Hardcover) wins; otherwise estimate using whichever measure
// fits the format. source: 'real' | 'estimated' | 'unknown'.
export function estimateWords(book, format) {
  if (book.word_count) return { words: book.word_count, source: 'real' };
  if (format === 'listened' && book.audio_runtime_minutes)
    return { words: Math.round((book.audio_runtime_minutes / 60) * WORDS_PER_LISTENING_HOUR), source: 'estimated' };
  if (book.page_count)
    return { words: book.page_count * WORDS_PER_PAGE, source: 'estimated' };
  if (book.audio_runtime_minutes)
    return { words: Math.round((book.audio_runtime_minutes / 60) * WORDS_PER_LISTENING_HOUR), source: 'estimated' };
  return { words: 0, source: 'unknown' };
}

// DNF counts proportionally: abandoned at 40% contributes 40% of the words.
function frac(ev) {
  return ev.status === 'dnf' && ev.dnf_percent ? ev.dnf_percent / 100 : 1;
}

export function eventWords(book, ev) {
  const base = estimateWords(book, ev.format);
  return { words: Math.round(base.words * frac(ev)), source: base.source };
}

// Pages are print-equivalent and format-agnostic: a read book shows its
// edition's page count, a listened book the same (or the word estimate ÷
// WORDS_PER_PAGE when the edition carries no page data) — a listens-only
// reader isn't stuck at zero.
export function eventPages(book, ev) {
  if (book.page_count) return Math.round(book.page_count * frac(ev));
  const words = estimateWords(book, ev.format).words;
  return Math.round((words / WORDS_PER_PAGE) * frac(ev));
}

// Hours stay a listened-only metric — a read book never contributes hours.
// Real runtimes win; otherwise estimate from the book's word total at
// narration pace, so text editions logged as listens still earn hours.
export function eventHours(book, ev) {
  if (ev.format !== 'listened') return 0;
  if (book.audio_runtime_minutes) return Math.round((book.audio_runtime_minutes / 60) * frac(ev) * 10) / 10;
  const words = estimateWords(book, ev.format).words;
  return Math.round((words / WORDS_PER_LISTENING_HOUR) * frac(ev) * 10) / 10;
}
