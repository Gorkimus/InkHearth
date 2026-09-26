// Canonical genre vocabulary — the single truth for what a genre can be called
// here. Provider genres (Hardcover crowd tags, Google Books breadcrumb
// categories) are mapped through it STRICTLY: an alias resolves to its
// canonical name, anything unrecognized is dropped. Seeded from the genres
// actually in the library; extend by adding aliases and the new spelling
// starts surviving writes. Moods and user-made tags are not touched by this.
//
// Lookup keys normalize case/punctuation ("Sci-Fi" and "sci fi" collide), so
// alias spellings only need to differ beyond punctuation.
const CANON = [
  ['Adventure', ['action & adventure', 'action and adventure', 'azione e avventura']],
  ['Biography', ['autobiography', 'biography & autobiography', 'biographies & memoirs']],
  ['Business', ['business & economics']],
  ['Classics', []],
  ['Coming of Age', []],
  ['Contemporary', []],
  ['Cozy Mystery', ['cosy mystery']],
  ['Crime', []],
  ['Dark Fantasy', []],
  ['Dystopian', ['dystopia']],
  ['Epic Fantasy', []],
  ['Fantasy', ['fantasy fiction']],
  ['Grimdark', ['grim dark']],
  ['High Fantasy', []],
  ['Historical Fiction', ['historical']],
  ['History', []],
  ['Horror', []],
  ['Humor', ['comedy']],
  ['LGBTQ', ['lgbt', 'lgbtqia']],
  ['LitRPG', ['lit rpg', 'lit-rpg', 'progression fantasy']],
  ['Literary Fiction', ['literary', 'literature', 'literature & fiction', 'literary collections']],
  ['Magical Realism', []],
  ['Memoir', []],
  ['Mystery', []],
  ['Nonfiction', ['non-fiction']],
  ['Romance', []],
  ['Science Fiction', ['sci-fi', 'sci fi', 'scifi', 'sf', 'science fiction & fantasy', 'science fiction fantasy']],
  ['Self-Help', ['self help']],
  ['Space Opera', []],
  ['Suspense', []],
  ['Thriller', ['thriller & suspense', 'thriller and suspense']],
  ['True Crime', []],
  ['War', ['military', 'military fiction', 'imaginary wars and battles']],
  ['Young Adult', ['ya', 'young adult fiction']],
];

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const LOOKUP = new Map();
for (const [canonical, aliases] of CANON) {
  LOOKUP.set(key(canonical), canonical);
  for (const a of aliases) LOOKUP.set(key(a), canonical);
}

// Strict: canonical name, or null when the genre is unknown. Unknown genres
// never survive a provider write — that is the point of the vocabulary.
export function canonGenre(tag) {
  const k = key(tag);
  if (!k) return null;
  return LOOKUP.get(k) ?? null;
}

// Map a list of provider genres to canonical names: unmapped entries drop,
// duplicates collapse, and the list is capped (provider rank order wins).
export function mapGenres(list, cap = 6) {
  const out = [];
  for (const tag of Array.isArray(list) ? list : []) {
    const c = canonGenre(tag);
    if (c && !out.includes(c)) {
      out.push(c);
      if (out.length >= cap) break;
    }
  }
  return out;
}
