import { Buffer } from 'node:buffer';

import { MCP_RESULT_MAX_BYTES, MCP_TEXT_CELL_MAX_CHARS, type McpRecord } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { cutText, shapeRecords } from '../../src/modules/mcp/shape.js';

const MAX = MCP_TEXT_CELL_MAX_CHARS;
const graphemes = (text: string) =>
  [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // one grapheme, 8 UTF-16 units
const FLAG = '\u{1F1FB}\u{1F1F3}'; // one grapheme (VN), two regional indicators
const E_HOOK_ACUTE = 'e\u0302\u0301'; // "ế" decomposed: one grapheme, three code points
const A_DOT_BELOW_HOOK = 'a\u0306\u0323'; // "ặ" decomposed

const id = (n: number): McpRecord['id'] => `rec_${String(n).padStart(16, '0')}`;

/** BACKLOG T921 (CONTRACTS §30.3): text cells cut by grapheme, results capped at 32 KB. */
describe('MCP text cells (T921)', () => {
  it.each([
    ['empty', '', undefined],
    ['short Vietnamese', 'Đã xong', undefined],
    ['exactly the limit', 'a'.repeat(MAX), undefined],
    ['the limit in decomposed marks', E_HOOK_ACUTE.repeat(MAX), undefined],
    ['the limit in emoji', FAMILY.repeat(MAX), undefined],
    ['one over', 'a'.repeat(MAX + 1), `${'a'.repeat(MAX)}…`],
    [
      'an emoji sequence on the edge',
      `${'a'.repeat(MAX - 1)}${FAMILY}b`,
      `${'a'.repeat(MAX - 1)}${FAMILY}…`,
    ],
    ['an emoji sequence past the edge', `${'a'.repeat(MAX)}${FAMILY}`, `${'a'.repeat(MAX)}…`],
    [
      'a flag on the edge',
      `${'a'.repeat(MAX - 1)}${FLAG}${FLAG}`,
      `${'a'.repeat(MAX - 1)}${FLAG}…`,
    ],
    [
      'combining marks on the edge',
      `${'a'.repeat(MAX - 1)}${E_HOOK_ACUTE}${A_DOT_BELOW_HOOK}`,
      `${'a'.repeat(MAX - 1)}${E_HOOK_ACUTE}…`,
    ],
    ['marks all along', A_DOT_BELOW_HOOK.repeat(MAX + 5), `${A_DOT_BELOW_HOOK.repeat(MAX)}…`],
  ])('%s', (_case, text, expected) => {
    const cut = cutText(text);
    expect(cut).toBe(expected);
    if (cut !== undefined) {
      expect(graphemes(cut)).toBe(MAX + 1);
      // Never a lone surrogate or a mark without its letter.
      expect(text.startsWith(cut.slice(0, -1))).toBe(true);
      expect(cut.normalize('NFC').slice(0, -1)).toBe(cut.slice(0, -1).normalize('NFC'));
      // Throws on a lone surrogate.
      expect(() => encodeURIComponent(cut)).not.toThrow();
    }
  });
});

describe('MCP record results (T921)', () => {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  it('cuts long text cells only, and lists them', () => {
    const records: McpRecord[] = [
      {
        id: id(1),
        fields: { title: 'x'.repeat(MAX + 10), amount: 5, tags: ['y'.repeat(MAX + 1)] },
      },
      { id: id(2), fields: { title: 'short', note: null } },
    ];
    const shaped = shapeRecords(records, {});
    expect(shaped.dropped).toBe(0);
    expect(shaped.records[0]?.fields['title']).toBe(`${'x'.repeat(MAX)}…`);
    expect(shaped.records[0]?.fields['amount']).toBe(5);
    expect(shaped.records[0]?.fields['tags']).toEqual(records[0]?.fields['tags']);
    expect(shaped.records[1]).toEqual(records[1]);
    expect(shaped.truncated_cells).toEqual([{ record_id: id(1), field: 'title' }]);
  });

  it.each([
    ['small rows, all kept', 50, 100, 0],
    ['ASCII rows past 32 KB', 100, 1_000, 69],
    ['Vietnamese rows past 32 KB (3 bytes a letter)', 100, 'ế'.repeat(330), 69],
  ])('%s', (_case, count, text, dropped) => {
    const records = Array.from({ length: count }, (_, n) => ({
      id: id(n),
      fields: { title: typeof text === 'number' ? 'a'.repeat(text) : text },
    }));
    const rest = { total: 500, offset: 0, limit: 100, next_offset: 31 };
    const shaped = shapeRecords(records, rest);
    expect(shaped.dropped).toBe(dropped);
    expect(shaped.records).toEqual(records.slice(0, count - dropped));
    const result = { records: shaped.records, ...rest, truncated: true, truncated_cells: [] };
    expect(bytes(result)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
    if (dropped > 0) {
      const oneMore = { ...result, records: records.slice(0, count - dropped + 1) };
      expect(bytes(oneMore)).toBeGreaterThan(MCP_RESULT_MAX_BYTES - 64);
    }
  });

  it('keeps the first record even when it alone is over the cap, so paging moves on', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 12 }, (_, n) => [`f${String(n)}`, 'z'.repeat(MAX)]),
    );
    const shaped = shapeRecords(
      [
        { id: id(1), fields: wide },
        { id: id(2), fields: wide },
      ],
      {},
    );
    expect(shaped.records.map((record) => record.id)).toEqual([id(1)]);
    expect(shaped.dropped).toBe(1);
  });
});
