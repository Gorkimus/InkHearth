// Text-only companions for the shareable images (the tier board's book list,
// the TBR queue). A picture carries the covers; this carries the words, as
// Markdown — the shape a Reddit post body takes. Both lists are built from the
// SAME rows their images draw, so a list pasted under its picture tells the
// same story. The builders up top are pure (a Node scratch test imports this
// exact module, same as the *-export-layout files); the three helpers at the
// bottom are the browser part: a file download and the clipboard.
import { toast, toastAction } from './ui.js';

// What Markdown would otherwise read as formatting: emphasis, strikethrough
// and superscript (Reddit's), code and link brackets, and the escape itself.
// Whitespace folds first — one book is one line, whatever its title carries.
// Angle brackets are left alone: a stray "<3" in a title is more likely than
// markup, and Reddit treats only a few exact shapes as HTML.
export const mdText = (s) => String(s ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[\\`*_[\]~^]/g, '\\$&');

// One book as a list item: "- Title (Series #2) — *Author* (notes…)". The
// italic author marks where a long title ends. The series position rides
// along only when the caller has it — the TBR names its volumes, since that
// is what a series rolls up to, while the tier board's list image shows title
// and author alone. Order 0 is a real position (prequels), so the test is
// != null, never truthiness.
export function mdEntry({ title, author, series, seriesOrder, notes = [] }) {
  let line = `- ${mdText(title || '?')}`;
  if (series) line += ` (${mdText(series)}${seriesOrder != null ? ' #' + seriesOrder : ''})`;
  if (author) line += ` — *${mdText(author)}*`;
  for (const n of notes.filter(Boolean)) line += ` (${mdText(n)})`;
  return line;
}

// An italic heading line, then each section that has books: its label in
// bold, a blank line, the items. The blank lines are load-bearing — Reddit
// glues a list onto the paragraph above it without one. A section with no
// label (the TBR's one plain list) skips the bold line. Empty sections drop
// out, exactly as the images leave empty tiers out.
export function listMarkdown({ heading, note, sections }) {
  const out = [];
  const head = [heading, note].filter(Boolean).join(' · ');
  if (head) out.push(`*${mdText(head)}*`);
  for (const { label, items = [] } of sections) {
    if (!items.length) continue;
    if (out.length) out.push('');
    if (label) out.push(`**${mdText(label)}**`, '');
    out.push(...items);
  }
  return out.join('\n') + '\n';
}

// ---------- the browser part ----------

// A text file onto disk: the same anchor-and-blob dance the image exports use.
export function downloadText(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// The async clipboard API exists only on secure origins (https, localhost),
// and a LAN http address is an ordinary way to reach a self-hosted instance —
// so the old select-and-copy path stands in there. Returns whether it worked,
// so the caller can say so either way.
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* refused — fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', ''); // keeps the keyboard shut on phones
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* blocked by policy */ }
  ta.remove();
  return ok;
}

// The flow both text buttons share: the file lands in Downloads beside the
// image, and the toast's button puts the same text on the clipboard — the
// step a post actually needs, since Reddit takes the list as pasted text.
export function saveTextList({ filename, text, what }) {
  downloadText(filename, text);
  toastAction(`${what} saved as Markdown`, 'Copy', async () => {
    toast(await copyText(text) ? 'Copied — ready to paste into a post' : 'Could not copy — open the saved file instead', 5000);
  }, 8000);
}
