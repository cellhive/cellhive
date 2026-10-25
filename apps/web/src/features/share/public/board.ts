import type { GroupCount } from './group-rows';
import type { GridField } from '../../../grid';
import type { RecordDto } from '@cellhive/contracts';

/** Key of the column of records without a value (or with a deleted option). */
export const NO_VALUE = '';

/** A column of the shared kanban board (FRONTEND §6.6, read-only). */
export interface BoardColumn {
  /** Option name (select) or user id; `NO_VALUE` for the "no value" column. */
  readonly key: string;
  /** A cell value of the group field for the column header (`null` = no value). */
  readonly value: unknown;
  /** Rows of the column from `group-counts`, `null` when unknown. */
  readonly count: number | null;
}

interface UserRef {
  readonly id: string;
  readonly name?: string;
}

function firstUser(value: unknown): UserRef | null {
  const item: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof item !== 'object' || item === null) return null;
  const id = (item as Record<string, unknown>)['id'];
  return typeof id === 'string' ? (item as UserRef) : null;
}

/** Column key of a cell value of the group field (json read shape, CONTRACTS §2). */
export function columnKeyOf(field: GridField, value: unknown): string {
  const config = field.config;
  if (config?.type === 'select') {
    if (typeof value !== 'string') return NO_VALUE;
    // A value naming an option that no longer exists reads as no value.
    return config.options.options.some((option) => option.name === value) ? value : NO_VALUE;
  }
  if (config?.type === 'user') return firstUser(value)?.id ?? NO_VALUE;
  return NO_VALUE;
}

/**
 * Columns of the board: "no value" first, then the options of a select in
 * their order, or the people found by `group-counts` for a user field.
 * People with loaded cards get a column even before the counts arrive.
 * With `hideEmpty`, columns counted empty (and without a loaded card) go.
 */
export function boardColumns(
  field: GridField,
  counts: readonly GroupCount[] | undefined,
  hideEmpty: boolean,
  placed: ReadonlyMap<string, readonly RecordDto[]>,
): BoardColumn[] {
  const countOf = new Map<string, number>();
  const people = new Map<string, unknown>();
  for (const group of counts ?? []) {
    const value = group.values[0] ?? null;
    const key = columnKeyOf(field, value);
    countOf.set(key, (countOf.get(key) ?? 0) + group.count);
    if (key !== NO_VALUE && !people.has(key)) people.set(key, value);
  }
  const count = (key: string) => (counts === undefined ? null : (countOf.get(key) ?? 0));
  const columns: BoardColumn[] = [{ key: NO_VALUE, value: null, count: count(NO_VALUE) }];
  const config = field.config;
  if (config?.type === 'select') {
    for (const option of config.options.options) {
      columns.push({ key: option.name, value: option.name, count: count(option.name) });
    }
  } else if (config?.type === 'user') {
    for (const [key, cards] of placed) {
      const card = cards[0];
      if (key !== NO_VALUE && !people.has(key) && card !== undefined) {
        people.set(key, card.fields[field.field.id]);
      }
    }
    for (const [key, value] of people) columns.push({ key, value, count: count(key) });
  }
  if (!hideEmpty) return columns;
  return columns.filter(
    (column) => column.count !== 0 || (placed.get(column.key)?.length ?? 0) > 0,
  );
}

/** Loaded cards by column key, in the order the server returned them. */
export function placeCards(
  field: GridField,
  records: readonly RecordDto[],
): Map<string, RecordDto[]> {
  const byColumn = new Map<string, RecordDto[]>();
  for (const record of records) {
    const key = columnKeyOf(field, record.fields[field.field.id]);
    const list = byColumn.get(key);
    if (list === undefined) byColumn.set(key, [record]);
    else list.push(record);
  }
  return byColumn;
}
