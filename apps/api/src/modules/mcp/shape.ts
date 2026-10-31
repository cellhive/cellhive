import { Buffer } from 'node:buffer';

import {
  MCP_RESULT_MAX_BYTES,
  MCP_TEXT_CELL_MAX_CHARS,
  type McpRecord,
  type McpTruncatedCell,
} from '@cellhive/contracts';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `text` cut to `max` user-perceived characters (graphemes: an emoji
 * sequence or a letter with its combining marks is one) followed by `…`;
 * `undefined` when it is not longer than that.
 */
export function cutText(text: string, max: number = MCP_TEXT_CELL_MAX_CHARS): string | undefined {
  // A string of at most `max` UTF-16 units has at most `max` graphemes.
  if (text.length <= max) return undefined;
  let count = 0;
  for (const { index } of graphemes.segment(text)) {
    if (count === max) return `${text.slice(0, index)}…`;
    count += 1;
  }
  return undefined;
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export interface ShapedRecords {
  readonly records: McpRecord[];
  readonly truncated_cells: McpTruncatedCell[];
  /** Records left out from the end to keep the result under `maxBytes`. */
  readonly dropped: number;
}

/**
 * Records of a tool result (CONTRACTS §30.3): text cells longer than
 * `MCP_TEXT_CELL_MAX_CHARS` cut (listed in `truncated_cells`), then records
 * left out from the end so that the JSON of `rest` plus these keys stays
 * within `maxBytes`. The first record is always kept, so paging moves on.
 */
export function shapeRecords(
  records: readonly McpRecord[],
  rest: Readonly<Record<string, unknown>>,
  maxBytes: number = MCP_RESULT_MAX_BYTES,
): ShapedRecords {
  const kept: McpRecord[] = [];
  const cells: McpTruncatedCell[] = [];
  // Slack for values the caller sets once the page is known (`next_offset`).
  let used = bytesOf({ ...rest, records: [], truncated: false, truncated_cells: [] }) + 16;
  for (const record of records) {
    const fields: Record<string, unknown> = {};
    const cut: McpTruncatedCell[] = [];
    for (const [name, value] of Object.entries(record.fields)) {
      const short = typeof value === 'string' ? cutText(value) : undefined;
      fields[name] = short ?? value;
      if (short !== undefined) cut.push({ record_id: record.id, field: name });
    }
    const shaped = { id: record.id, fields };
    // Each item counted with a comma: a few bytes over, never under.
    const size = bytesOf(shaped) + 1 + cut.reduce((sum, cell) => sum + bytesOf(cell) + 1, 0);
    if (kept.length > 0 && used + size > maxBytes) break;
    used += size;
    kept.push(shaped);
    cells.push(...cut);
  }
  return { records: kept, truncated_cells: cells, dropped: records.length - kept.length };
}
