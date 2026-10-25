/**
 * Accent- and case-insensitive matching for the formula autocomplete
 * (board "S4b · Gợi ý khi gõ công thức": "khớp không dấu, giữa từ; phần
 * khớp in đậm"): "trang" finds "Trạng thái", "d" finds "Đơn hàng".
 */

function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase();
}

/** Folded text and, per folded code unit, the offset of the original character. */
function folded(text: string): { text: string; origin: number[] } {
  let out = '';
  const origin: number[] = [];
  let offset = 0;
  for (const char of text) {
    const fold = foldChar(char);
    out += fold;
    for (let index = 0; index < fold.length; index += 1) origin.push(offset);
    offset += char.length;
  }
  return { text: out, origin };
}

export function foldForMatch(text: string): string {
  return folded(text).text;
}

export interface Match {
  /** 0: starts with the query, 1: a word starts with it, 2: anywhere. */
  readonly rank: number;
  /** `[from, to]` offsets in `label` of the matched part (for bold). */
  readonly range: readonly [number, number];
}

/** How `label` matches `query` (`null`: it does not). An empty query matches everything. */
export function matchLabel(label: string, query: string): Match | null {
  if (query === '') return { rank: 0, range: [0, 0] };
  const target = folded(label);
  const needle = foldForMatch(query);
  const at = target.text.indexOf(needle);
  if (at === -1) return null;
  let rank = 2;
  if (at === 0) rank = 0;
  else {
    // A later word starting with the query ranks above a match inside a word.
    const words = target.text.split(/[\s_.\-/]+/u);
    let position = 0;
    for (const word of words) {
      const index = target.text.indexOf(word, position);
      if (word !== '' && word.startsWith(needle)) {
        rank = 1;
        break;
      }
      position = index + word.length;
    }
  }
  const from = target.origin[at] ?? 0;
  const lastIndex = at + needle.length - 1;
  const lastOrigin = target.origin[lastIndex] ?? label.length - 1;
  const lastChar = String.fromCodePoint(label.codePointAt(lastOrigin) ?? 0);
  return { rank, range: [from, lastOrigin + lastChar.length] };
}
