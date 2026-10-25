import { evaluate, type FormulaJsonValue } from '@cellhive/formula-engine';

import type { EditorAnalysis } from './analysis';
import type { RecordDto } from '@cellhive/contracts';

/**
 * Preview of the formula on the first rows (SPEC §9.6, T466). A formula
 * that reads only its own record is computed right here by the TS
 * evaluator (T453) on the rows the grid has loaded — instantly, while
 * typing; anything reading links or other tables asks the server
 * (`POST /tables/:id/computed-preview`, the caller's read scope).
 */

export const PREVIEW_ROWS = 5;

export interface PreviewRow {
  readonly id: string;
  /** Primary field as text (the row's label in the preview). */
  readonly title: string;
  /** `cell_format=json` like the records API; `null` when empty or when the row errs. */
  readonly value: unknown;
}

function titleOf(record: RecordDto, primaryFieldId: string | null): string {
  if (primaryFieldId === null) return record.id;
  const value = record.fields[primaryFieldId];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * Values of a same-row formula on `records` (at most {@link PREVIEW_ROWS}).
 * `tz`: the organization's zone (ADR-21), `now`: the instant of TODAY()/NOW().
 */
export function evaluateRows(
  editor: EditorAnalysis,
  records: readonly RecordDto[],
  primaryFieldId: string | null,
  tz: string,
  now: Date,
): PreviewRow[] {
  const ast = editor.analysis.ast;
  return records.slice(0, PREVIEW_ROWS).map((record) => {
    const title = titleOf(record, primaryFieldId);
    if (ast === null) return { id: record.id, title, value: null };
    let value: FormulaJsonValue;
    try {
      value = evaluate(ast, {
        snapshot: editor.snapshot,
        row: { id: record.id, title, fields: record.fields },
        tz,
        now,
        types: editor.analysis.types,
      });
    } catch {
      // A row the evaluator cannot compute reads empty, as on the server (SPEC §9.4).
      value = null;
    }
    return { id: record.id, title, value };
  });
}

/** Empty as a cell shows it: `null`, `""`, `[]`. */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}
