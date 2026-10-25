import type { GridField } from '../../../grid/types';
import type { LinkRef } from '../../../lib/links/values';
import type { RecordDto } from '@cellhive/contracts';

/**
 * The embedded sub-table of a link field in the record panel (T416,
 * FRONTEND §10.2, board "Bảng con trong chi tiết record"): which columns it
 * shows, which rows, and their totals. Pure functions, unit-tested.
 */

/** Rows shown at most (BACKLOG S4 design decision #4: "50 / N" + "View all"). */
export const SUBTABLE_ROW_CAP = 50;
/**
 * One-way links have no reverse field to filter the linked table on: "View
 * all" shows every linked record in place instead (a cell holds ≤ 500).
 */
export const SUBTABLE_EXPANDED_CAP = 500;
/** Columns of a sub-table without saved columns (CONTRACTS §15 `record_detail`). */
export const DEFAULT_COLUMN_COUNT = 5;

/**
 * The first {@link DEFAULT_COLUMN_COUNT} fields of the linked table the
 * viewer reads (`fields` in display order, primary first), except the
 * reverse link field: in this sub-table every row would show the same
 * record there (the one the panel shows).
 */
export function defaultColumns(
  fields: readonly GridField[],
  reverseFieldId: string | null,
): string[] {
  return fields
    .filter((field) => field.field.id !== reverseFieldId)
    .slice(0, DEFAULT_COLUMN_COUNT)
    .map((field) => field.field.id);
}

/**
 * The columns shown, in order: the primary field of the linked table
 * always first (it names the row), then the saved columns the viewer still
 * reads; nothing saved → {@link defaultColumns}.
 */
export function resolveColumns(
  saved: readonly string[] | undefined,
  fields: readonly GridField[],
  reverseFieldId: string | null,
): GridField[] {
  const byId = new Map<string, GridField>(fields.map((field) => [field.field.id, field]));
  const ids = saved ?? defaultColumns(fields, reverseFieldId);
  const primary = fields.find((field) => field.field.is_primary);
  const shown: GridField[] = primary === undefined ? [] : [primary];
  for (const id of ids) {
    const field = byId.get(id);
    if (field === undefined || shown.includes(field)) continue;
    shown.push(field);
  }
  return shown;
}

/** Column ids after checking or unchecking one in the column picker (the primary stays). */
export function toggleColumn(
  current: readonly string[],
  fieldId: string,
  on: boolean,
  primaryId: string | null,
): string[] {
  if (fieldId === primaryId) return [...current];
  if (on) return current.includes(fieldId) ? [...current] : [...current, fieldId];
  return current.filter((id) => id !== fieldId);
}

/**
 * The picker's list after moving the field at `from` to `to` (drag ⋮⋮ or
 * the keyboard). The primary field stays first.
 */
export function moveColumn(
  order: readonly string[],
  from: number,
  to: number,
  primaryId: string | null,
): string[] {
  const next = [...order];
  const [moved] = next.splice(from, 1);
  if (moved === undefined || moved === primaryId) return [...order];
  const floor = primaryId !== null && next[0] === primaryId ? 1 : 0;
  next.splice(Math.max(floor, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * The order of the picker: the shown columns first (in their order), then
 * the other fields in table order.
 */
export function pickerOrder(shown: readonly GridField[], fields: readonly GridField[]): string[] {
  const ids: string[] = shown.map((field) => field.field.id);
  for (const field of fields) if (!ids.includes(field.field.id)) ids.push(field.field.id);
  return ids;
}

/** One row of the sub-table. */
export interface SubTableRow {
  readonly ref: LinkRef;
  /** The linked record, `null` while loading or when the viewer cannot read it. */
  readonly record: RecordDto | null;
  /** P20: the viewer cannot read the linked record (no title), its values stay hidden. */
  readonly locked: boolean;
}

export interface SubTableRows {
  readonly rows: readonly SubTableRow[];
  /** Linked records of the cell. */
  readonly total: number;
  /** Fewer rows than links are shown ("50 / N"). */
  readonly capped: boolean;
}

/** The rows shown: the first `cap` links in link order, with their records when loaded. */
export function subTableRows(
  refs: readonly LinkRef[],
  records: readonly RecordDto[] | undefined,
  cap: number,
): SubTableRows {
  const byId = new Map<string, RecordDto>((records ?? []).map((record) => [record.id, record]));
  const rows = refs.slice(0, cap).map((ref) => ({
    ref,
    record: byId.get(ref.id) ?? null,
    locked: ref.title === null,
  }));
  return { rows, total: refs.length, capped: refs.length > rows.length };
}

/** Ids of the linked records to fetch: the shown ones the viewer reads. */
export function readableIds(refs: readonly LinkRef[], cap: number): string[] {
  return refs.slice(0, cap).flatMap((ref) => (ref.title === null ? [] : [ref.id]));
}

/**
 * Whether a column gets a total in the summary row: money amounts (number
 * fields in the currency style), like "Thành tiền" of the board. Counts,
 * ratings and progress are not added up.
 */
export function summedColumn(field: GridField): boolean {
  const config = field.config;
  return config?.type === 'number' && config.options.style.type === 'currency';
}

/** Sum of a column over the rows (numbers only); `null` when no row has a number. */
export function columnTotal(field: GridField, rows: readonly SubTableRow[]): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = row.record?.fields[field.field.id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/** Links of the cell without `id` (unlink), keeping the order. */
export function withoutLink(refs: readonly LinkRef[], id: string): LinkRef[] {
  return refs.filter((ref) => ref.id !== id);
}

/**
 * Undo of an unlink: `removed` goes back at `index` of the cell as it is
 * now (other changes made meanwhile are kept); already there → unchanged.
 */
export function restoreLink(refs: readonly LinkRef[], removed: LinkRef, index: number): LinkRef[] {
  if (refs.some((ref) => ref.id === removed.id)) return [...refs];
  const next = [...refs];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, removed);
  return next;
}
