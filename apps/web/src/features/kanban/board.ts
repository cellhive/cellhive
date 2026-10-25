import { toGridField } from '../../grid/types';

import type { FieldDto, RecordDto, StoredKanbanSettings } from '@cellhive/contracts';

/**
 * Pure model of a kanban board (SPEC §8, T314): which columns a group
 * field gives, which column a record belongs to, the filter that loads a
 * column and where every loaded card is shown.
 */

/** Key of the "Uncategorized" column (records whose group value is empty). */
export const EMPTY_COLUMN = '__empty';

export type GroupFieldKind = 'select' | 'user';

/** A user as a `user` cell holds it (CONTRACTS §2): a former member has only `id`. */
export interface ColumnUser {
  readonly id: string;
  readonly name?: string | null | undefined;
  readonly email?: string | null | undefined;
}

export interface KanbanColumnDef {
  /** Option id, user id or {@link EMPTY_COLUMN}. */
  readonly key: string;
  readonly kind: 'option' | 'user' | 'empty';
  /** Option or member name; `null` for the empty column and former members. */
  readonly name: string | null;
  /** Palette index of an option (`--option-N-*`), `null` otherwise. */
  readonly color: number | null;
  /** What a move writes into the group field (write shape, CONTRACTS §2). */
  readonly writeValue: unknown;
  /** What the card shows until the server answers (read shape). */
  readonly display: unknown;
}

/** One condition of the filter DSL (SPEC §6). */
export interface ColumnCondition {
  readonly field: string;
  readonly operator: 'is' | 'has_any_of' | 'is_empty';
  readonly value?: unknown;
}

/** Board settings with every key present (a partial temporary change fills the rest). */
export function kanbanSettingsOf(
  settings: Partial<StoredKanbanSettings> | undefined,
): StoredKanbanSettings {
  return {
    group_field: settings?.group_field ?? null,
    card_fields: settings?.card_fields ?? [],
    cover_field: settings?.cover_field ?? null,
    hide_empty_columns: settings?.hide_empty_columns ?? false,
  };
}

interface SelectOption {
  readonly id: string;
  readonly name: string;
  readonly color?: number | undefined;
}

/** Options of a select field (parsed and defaulted by `field-types`). */
function selectOptionsOf(field: FieldDto): { multiple: boolean; options: readonly SelectOption[] } {
  const config = toGridField(field).config;
  return config?.type === 'select' ? config.options : { multiple: true, options: [] };
}

/** `multiple` of a user field defaults to `true` (field-types). */
function isSingleUser(field: FieldDto): boolean {
  const config = toGridField(field).config;
  return config?.type === 'user' && !config.options.multiple;
}

/** Card fields a board gets when it is grouped for the first time. */
export const DEFAULT_CARD_FIELD_COUNT = 3;

/**
 * The first {@link DEFAULT_CARD_FIELD_COUNT} fields a new board shows on its
 * cards: readable (`candidates` holds only fields the user reads), not the
 * primary field (the title) and not the group field (the column says it).
 */
export function defaultCardFields(
  candidates: readonly { readonly field: { readonly id: string; readonly is_primary: boolean } }[],
  groupFieldId: string,
): string[] {
  return candidates
    .filter(({ field }) => !field.is_primary && field.id !== groupFieldId)
    .slice(0, DEFAULT_CARD_FIELD_COUNT)
    .map(({ field }) => field.id);
}

/** A single select or single user field can group a board (CONTRACTS §15); else `null`. */
export function groupKindOf(field: FieldDto | undefined): GroupFieldKind | null {
  if (field === undefined) return null;
  if (field.type === 'select') return selectOptionsOf(field).multiple ? null : 'select';
  if (field.type === 'user') return isSingleUser(field) ? 'user' : null;
  return null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The user of a single user cell (`[{ id, name, email }]`, or one object), else `null`. */
export function userOfCell(value: unknown): ColumnUser | null {
  const item: unknown = Array.isArray(value) ? value[0] : value;
  if (!isRecordLike(item) || typeof item['id'] !== 'string') return null;
  return {
    id: item['id'],
    name: typeof item['name'] === 'string' ? item['name'] : null,
    email: typeof item['email'] === 'string' ? item['email'] : null,
  };
}

/**
 * Column of a group value (json read shape): a select holds the option
 * name, a user cell a one-element list. Empty values and options that no
 * longer exist belong to the empty column, like the server groups them.
 */
export function columnKeyOf(field: FieldDto, kind: GroupFieldKind, value: unknown): string {
  if (kind === 'select') {
    if (typeof value !== 'string' || value === '') return EMPTY_COLUMN;
    const option = selectOptionsOf(field).options.find(
      (item) => item.name === value || item.id === value,
    );
    return option?.id ?? EMPTY_COLUMN;
  }
  return userOfCell(value)?.id ?? EMPTY_COLUMN;
}

export function emptyColumn(): KanbanColumnDef {
  return {
    key: EMPTY_COLUMN,
    kind: 'empty',
    name: null,
    color: null,
    writeValue: null,
    display: null,
  };
}

export function userColumn(user: ColumnUser): KanbanColumnDef {
  const display = {
    id: user.id,
    ...(user.name === null || user.name === undefined ? {} : { name: user.name }),
    ...(user.email === null || user.email === undefined ? {} : { email: user.email }),
  };
  return {
    key: user.id,
    kind: 'user',
    name: user.name ?? null,
    color: null,
    writeValue: [{ id: user.id }],
    display: [display],
  };
}

/**
 * Columns of the board, "Uncategorized" first: the options of a select in
 * their order, or the members of a user field that hold cards (as the
 * group counts list them, then any met since, so a column emptied during
 * the session stays a drop target).
 */
export function buildColumns(
  field: FieldDto,
  kind: GroupFieldKind,
  users: readonly ColumnUser[] = [],
): KanbanColumnDef[] {
  if (kind === 'select') {
    return [
      emptyColumn(),
      ...selectOptionsOf(field).options.map((option, index) => ({
        key: option.id,
        kind: 'option' as const,
        name: option.name,
        color: option.color ?? index,
        writeValue: option.id,
        display: option.name,
      })),
    ];
  }
  return [emptyColumn(), ...users.map(userColumn)];
}

/** Filter selecting the records of one column (combined with the view's filter on the server). */
export function columnCondition(
  fieldId: string,
  kind: GroupFieldKind,
  column: string,
): ColumnCondition {
  if (column === EMPTY_COLUMN) return { field: fieldId, operator: 'is_empty' };
  return kind === 'select'
    ? { field: fieldId, operator: 'is', value: column }
    : { field: fieldId, operator: 'has_any_of', value: [column] };
}

export function columnFilter(fieldId: string, kind: GroupFieldKind, column: string) {
  return { op: 'and', items: [columnCondition(fieldId, kind, column)] } as const;
}

/**
 * Counts of `POST …/records/group-counts` by column. Several values that
 * land in one column (empty and a removed option) add up.
 */
export function countsByColumn(
  field: FieldDto,
  kind: GroupFieldKind,
  groups: readonly { readonly values: readonly unknown[]; readonly count: number }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const key = columnKeyOf(field, kind, group.values[0] ?? null);
    counts.set(key, (counts.get(key) ?? 0) + group.count);
  }
  return counts;
}

/** Members holding cards, in the order of the group counts (users of a user board). */
export function usersOfGroups(
  groups: readonly { readonly values: readonly unknown[] }[],
): ColumnUser[] {
  return groups.flatMap((group) => {
    const user = userOfCell(group.values[0] ?? null);
    return user === null ? [] : [user];
  });
}

/** `known` extended with the users of `more` it does not have yet (order kept). */
export function mergeUsers(
  known: readonly ColumnUser[],
  more: readonly ColumnUser[],
): ColumnUser[] {
  const byId = new Map(known.map((user) => [user.id, user]));
  const merged = [...known];
  for (const user of more) {
    const current = byId.get(user.id);
    if (current === undefined) {
      byId.set(user.id, user);
      merged.push(user);
    } else if ((current.name ?? null) === null && (user.name ?? null) !== null) {
      // A name learned later (a former member's `{ id }` first).
      merged[merged.indexOf(current)] = user;
      byId.set(user.id, user);
    }
  }
  return merged;
}

/**
 * Cards of every column. `loaded` holds, per column, the records its pages
 * returned (server order); `arrivals` records moved or added during the
 * session (latest first). Every record is shown once, from its newest copy
 * (highest `version`), in the column of its current group value:
 * - in server order when its column's pages hold it;
 * - otherwise at the top of its column (a card just dragged there, moved
 *   by someone else, or created), until a reload places it.
 * Records of a column that no longer exists go to the empty column.
 */
export function placeCards(
  columns: readonly KanbanColumnDef[],
  loaded: ReadonlyMap<string, readonly RecordDto[]>,
  arrivals: readonly RecordDto[],
  columnOf: (record: RecordDto) => string,
): Map<string, RecordDto[]> {
  const newest = new Map<string, RecordDto>();
  const keep = (record: RecordDto) => {
    const current = newest.get(record.id);
    if (current === undefined || record.version > current.version) newest.set(record.id, record);
  };
  for (const records of loaded.values()) records.forEach(keep);
  arrivals.forEach(keep);

  const known = new Set(columns.map((column) => column.key));
  const target = (record: RecordDto) => {
    const key = columnOf(record);
    return known.has(key) ? key : EMPTY_COLUMN;
  };
  const inOwnPages = new Set<string>();
  for (const [key, records] of loaded) {
    for (const record of records) {
      const current = newest.get(record.id);
      if (current !== undefined && target(current) === key) inOwnPages.add(record.id);
    }
  }

  const cards = new Map<string, RecordDto[]>(columns.map((column) => [column.key, []]));
  const shown = new Set<string>();
  const place = (record: RecordDto | undefined) => {
    if (record === undefined || shown.has(record.id)) return;
    shown.add(record.id);
    cards.get(target(record))?.push(record);
  };
  // Cards away from their column's pages head their column: arrivals, then
  // records loaded in a column they have left (a change seen through realtime).
  for (const arrival of arrivals) {
    if (!inOwnPages.has(arrival.id)) place(newest.get(arrival.id));
  }
  for (const records of loaded.values()) {
    for (const record of records) {
      if (!inOwnPages.has(record.id)) place(newest.get(record.id));
    }
  }
  for (const column of columns) {
    for (const record of loaded.get(column.key) ?? []) {
      const current = newest.get(record.id);
      if (current !== undefined && target(current) === column.key) place(current);
    }
  }
  return cards;
}

interface GroupCount {
  readonly values: readonly unknown[];
  readonly count: number;
}

/**
 * Group counts after moving `amount` records from column `from` (`null`:
 * a new record) to column `to`, until the server's counts come back. A
 * column without a group yet gets one holding `display`.
 */
export function shiftCount<T extends { readonly groups: readonly GroupCount[] }>(
  data: T,
  field: FieldDto,
  kind: GroupFieldKind,
  move: { readonly from: string | null; readonly to: KanbanColumnDef; readonly amount?: number },
): T {
  const amount = move.amount ?? 1;
  const keys = data.groups.map((group) => columnKeyOf(field, kind, group.values[0] ?? null));
  const to = keys.indexOf(move.to.key);
  const from =
    move.from === null
      ? -1
      : keys.findIndex((key, index) => key === move.from && (data.groups[index]?.count ?? 0) > 0);
  const groups: GroupCount[] = data.groups.map((group, index) => {
    if (index === to) return { ...group, count: group.count + amount };
    if (index === from) return { ...group, count: Math.max(0, group.count - amount) };
    return group;
  });
  if (to === -1) groups.push({ values: [move.to.display], count: amount });
  return { ...data, groups };
}
