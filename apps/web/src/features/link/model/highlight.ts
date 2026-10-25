/**
 * Where a search matches a title, the way the server searches (CONTRACTS
 * §2 link candidates): a substring without accents, not case-sensitive
 * ("hoa" finds "Hoà Bình", "đ" is "d"). Returns `[start, end)` ranges in
 * the original text so the picker can mark them. Pure.
 */

/** A character without accents, lower case (one character in, one out). */
function fold(char: string): string {
  const base = char.normalize('NFD').replace(/\p{Mn}/gu, '');
  const lower = base.toLowerCase();
  if (lower === 'đ') return 'd';
  return lower;
}

/** The folded text with, for every folded character, its offset in the original. */
function folded(text: string): { readonly text: string; readonly offsets: readonly number[] } {
  let out = '';
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    const part = fold(char);
    for (let index = 0; index < part.length; index += 1) offsets.push(offset);
    out += part;
    offset += char.length;
  }
  offsets.push(offset);
  return { text: out, offsets };
}

export type MatchRange = readonly [start: number, end: number];

/** Every non-overlapping match of `search` in `text` (none for an empty search). */
export function matchRanges(text: string, search: string): MatchRange[] {
  const needle = folded(search.trim()).text;
  if (needle === '') return [];
  const haystack = folded(text);
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.text.indexOf(needle, from);
    if (at === -1) break;
    const start = haystack.offsets[at] ?? 0;
    const end = haystack.offsets[at + needle.length] ?? text.length;
    ranges.push([start, end]);
    from = at + needle.length;
  }
  return ranges;
}

/** The text cut into plain and matched parts, in order. */
export function highlightParts(
  text: string,
  search: string,
): { readonly text: string; readonly match: boolean }[] {
  const ranges = matchRanges(text, search);
  if (ranges.length === 0) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
