import { idOf, isId } from '@cellhive/contracts';
import { z } from 'zod';

import {
  type LocaleContext,
  type TypecastResult,
  type ValidationResult,
  type ValueIssue,
} from '../core.js';
import { assertValid, cast, describe, invalid, issue, OK, unique } from '../internal/results.js';
import { MULTI_VALUE_OPERATORS, type FilterOperator } from '../operators.js';

/**
 * Most links one cell may hold, on each side of a link (ADR-28 §4, SPEC
 * §5.6). Writing more is `422 INVALID_CELL_VALUE` / `TOO_MANY_VALUES`
 * (`params.limit`).
 */
export const LINK_MAX_PER_CELL = 500;

/** Longest `bidirectional_link_field_name` (a field name). */
const MAX_NAME_LENGTH = 255;

/**
 * Options of a `link` field (SPEC §5.6, CONTRACTS §2):
 *
 * - `link_table`: the linked table (an active table of the same base);
 * - `bidirectional`: the linked table has the reverse field (sharing the
 *   junction); only set when the field is created (changing it is a
 *   conversion, ADR-28);
 * - `bidirectional_link_field_name`: name of the reverse field created with
 *   a two-way link (default: the name of this field's table);
 * - `allow_multiple` (default `true`): `false` keeps at most one link;
 * - `record_filter`: Filter DSL over the fields of the linked table that
 *   new links must match (checked on write by the server);
 * - `symmetric_field_id`: the reverse field of a two-way link; read-only
 *   (set by the server, a written value is ignored).
 */
export const linkOptionsSchema = z.strictObject({
  link_table: idOf('tbl'),
  bidirectional: z.boolean().default(false),
  bidirectional_link_field_name: z.string().trim().min(1).max(MAX_NAME_LENGTH).nullish(),
  allow_multiple: z.boolean().default(true),
  record_filter: z.record(z.string(), z.unknown()).nullable().default(null),
  symmetric_field_id: idOf('fld').nullable().default(null),
});

export type LinkOptions = z.output<typeof linkOptionsSchema>;

/** A linked record as reads return it (CONTRACTS §2): `title` is `null` when unreadable (P20). */
export interface LinkRef {
  readonly id: string;
  readonly title: string | null;
}

/**
 * One entry of a link write after typecast: a record id, or a title (the
 * primary field of the linked record) that the server resolves to an id.
 */
export type LinkInput = { readonly id: string } | { readonly title: string };

/** Most links a cell of a field with these options may hold. */
export function linkCellLimit(options: Pick<LinkOptions, 'allow_multiple'>): number {
  return options.allow_multiple ? LINK_MAX_PER_CELL : 1;
}

function tooMany(limit: number): ValueIssue {
  return issue(
    'TOO_MANY_VALUES',
    limit === 1
      ? 'This link field accepts at most one record'
      : `A link cell holds at most ${String(limit)} records`,
    { limit },
  );
}

/** The record id of a json write entry (`"rec_…"` or `{ id }`), or `null`. */
function entryId(entry: unknown): string | null {
  if (typeof entry === 'string') return isId('rec', entry) ? entry : null;
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'id' in entry) {
    return isId('rec', entry.id) ? entry.id : null;
  }
  return null;
}

/** Distinct record ids of a validated write, in the given order. */
export function linkIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map(entryId).filter((id): id is string => id !== null));
}

function validateLinks(value: unknown, options: LinkOptions): ValidationResult {
  if (value === null) return OK;
  if (!Array.isArray(value)) {
    return invalid(
      issue('EXPECTED_ARRAY', `Expected an array of record ids, got ${describe(value)}`),
    );
  }
  const bad = value.filter((entry) => entryId(entry) === null);
  if (bad.length > 0) {
    return invalid(
      issue('INVALID_RECORD_ID', 'Expected record ids of the form rec_<16 base62> or { id }'),
    );
  }
  const limit = linkCellLimit(options);
  return linkIdsOf(value).length > limit ? invalid(tooMany(limit)) : OK;
}

function typecastEntry(entry: unknown): LinkInput | null {
  if (typeof entry === 'number' && Number.isFinite(entry)) return { title: String(entry) };
  if (typeof entry === 'string') {
    const text = entry.trim();
    if (text === '') return null;
    return isId('rec', text) ? { id: text } : { title: text };
  }
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'id' in entry) {
    return isId('rec', entry.id) ? { id: entry.id } : null;
  }
  return null;
}

/** The distinct entries of a typecast write (ids and titles), in order. */
function distinctEntries(entries: readonly LinkInput[]): LinkInput[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = 'id' in entry ? `id:${entry.id}` : `title:${entry.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Separator of the titles of a link cell written as text (`cell_format=text`,
 * exports; CONTRACTS §2, §18) — and read back by imports (§19).
 */
export const LINK_TITLE_SEPARATOR = ', ';

/** A title that must be quoted in a title list: it holds a comma or a double quote. */
const NEEDS_QUOTES = /[",]/;

/**
 * Titles as one text cell (CONTRACTS §2 "danh sách title"): joined by
 * `", "`; a title holding `,` or `"` is wrapped in double quotes with its
 * `"` doubled (`Công ty "A", chi nhánh 1` → `"Công ty ""A"", chi nhánh 1"`),
 * so {@link parseLinkTitleList} reads the same titles back.
 */
export function formatLinkTitleList(titles: readonly string[]): string {
  return titles
    .map((title) => (NEEDS_QUOTES.test(title) ? `"${title.replaceAll('"', '""')}"` : title))
    .join(LINK_TITLE_SEPARATOR);
}

/**
 * The titles of a text cell written by {@link formatLinkTitleList} (or by
 * hand): items are separated by commas, spaces around an item are ignored,
 * empty items are dropped; an item starting with `"` runs to the matching
 * `"` (`""` inside is one `"`). A quote that is not closed, or text after
 * a closing quote before the next comma, makes the item plain text up to
 * that comma. Imports first try the whole cell as one title (CONTRACTS §19).
 */
export function parseLinkTitleList(text: string): string[] {
  const items: string[] = [];
  const plainUntilComma = (from: number): number => {
    const comma = text.indexOf(',', from);
    const end = comma === -1 ? text.length : comma;
    const item = text.slice(from, end).trim();
    if (item !== '') items.push(item);
    return end + 1;
  };
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text.charAt(index))) index += 1;
    if (index >= text.length) break;
    if (text.charAt(index) !== '"') {
      index = plainUntilComma(index);
      continue;
    }
    let cursor = index + 1;
    let value = '';
    let closed = false;
    while (cursor < text.length) {
      const char = text.charAt(cursor);
      if (char === '"') {
        if (text.charAt(cursor + 1) === '"') {
          value += '"';
          cursor += 2;
          continue;
        }
        closed = true;
        cursor += 1;
        break;
      }
      value += char;
      cursor += 1;
    }
    while (cursor < text.length && /\s/u.test(text.charAt(cursor))) cursor += 1;
    if (!closed || (cursor < text.length && text.charAt(cursor) !== ',')) {
      index = plainUntilComma(index);
      continue;
    }
    const item = value.trim();
    if (item !== '') items.push(item);
    index = cursor + 1;
  }
  return items;
}

export interface LinkFieldTypeDefinition {
  readonly type: 'link';
  readonly readOnly: false;
  readonly supportsDefaultValue: false;
  readonly optionsSchema: typeof linkOptionsSchema;
  /** Record ids only (`["rec_…"]` or `[{ id }]`), at most {@link linkCellLimit}. */
  validate(value: unknown, options: LinkOptions): ValidationResult;
  /**
   * `typecast=true`: a string is one title (or a record id), an array holds
   * titles and/or ids. Titles are resolved to ids by the server (exact match
   * of the linked table's primary field, unique among records the writer
   * reads) before `validate`.
   */
  typecast(
    input: unknown,
    options: LinkOptions,
    ctx: LocaleContext,
  ): TypecastResult<LinkInput[] | null>;
  /** Distinct record ids in the given order, `null` for an empty cell. */
  toStorage(value: unknown, options: LinkOptions): string[] | null;
  /** The `[{ id, title }]` the server assembled; `null` for an empty cell. */
  fromStorage(stored: unknown, options: LinkOptions): LinkRef[] | null;
  /**
   * `cell_format=text`: readable titles as a title list
   * ({@link formatLinkTitleList}: `", "`, quoted when a title holds `,` or
   * `"`); unreadable records are left out.
   */
  formatText(value: LinkRef[] | null, options: LinkOptions, ctx: LocaleContext): string;
  filterOperators(options: LinkOptions): readonly FilterOperator[];
}

/**
 * `link` (SPEC §5.6): values live in the junction `data.l_<fieldShortId>`,
 * not in a column of the table, so the server reads and writes them; this
 * definition holds the pure parts (options, write validation, typecast,
 * text format). Reads return `[{ id, title }]` in link order.
 */
export const linkFieldType: LinkFieldTypeDefinition = {
  type: 'link',
  readOnly: false,
  supportsDefaultValue: false,
  optionsSchema: linkOptionsSchema,
  validate: validateLinks,
  typecast(input, options) {
    if (input === null || input === undefined) return cast(null);
    const raw = Array.isArray(input) ? input : [input];
    const entries: LinkInput[] = [];
    for (const item of raw) {
      if (typeof item === 'string' && item.trim() === '') continue;
      const entry = typecastEntry(item);
      if (entry === null) {
        return invalid(
          issue('INVALID_RECORD_ID', `Cannot read ${describe(item)} as a linked record`),
        );
      }
      entries.push(entry);
    }
    const distinct = distinctEntries(entries);
    const limit = linkCellLimit(options);
    if (distinct.length > limit) return invalid(tooMany(limit));
    return cast(distinct.length === 0 ? null : distinct);
  },
  toStorage(value, options) {
    assertValid(validateLinks(value, options));
    const ids = linkIdsOf(value);
    return ids.length === 0 ? null : ids;
  },
  fromStorage(stored) {
    if (!Array.isArray(stored) || stored.length === 0) return null;
    return stored.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('id' in entry)) return [];
      const { id } = entry;
      if (typeof id !== 'string') return [];
      const title = 'title' in entry && typeof entry.title === 'string' ? entry.title : null;
      return [{ id, title }];
    });
  },
  formatText: (value) =>
    formatLinkTitleList((value ?? []).flatMap((ref) => (ref.title === null ? [] : [ref.title]))),
  filterOperators: () => MULTI_VALUE_OPERATORS,
};
