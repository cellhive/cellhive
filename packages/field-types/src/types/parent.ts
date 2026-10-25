import { isId } from '@cellhive/contracts';
import { z } from 'zod';

import { type LocaleContext, type TypecastResult, type ValidationResult } from '../core.js';
import { assertValid, cast, describe, invalid, issue, OK } from '../internal/results.js';
import { MULTI_VALUE_OPERATORS, type FilterOperator } from '../operators.js';

import type { LinkRef } from './link.js';

/**
 * Most levels of a sub-record tree (SPEC §5.7): a root is level 1, so a
 * record may have at most 9 ancestors. Writing a parent that makes any
 * record of the moved branch level 11 or deeper is
 * `422 SUBRECORD_TOO_DEEP`.
 */
export const SUBRECORD_MAX_DEPTH = 10;

/**
 * Options of a `parent` field (SPEC §5.7): none. The field is the single
 * self-link of a table with sub-records; its values live in the system
 * column `__parent_id` of the table.
 */
export const parentOptionsSchema = z.strictObject({});

export type ParentOptions = z.output<typeof parentOptionsSchema>;

/**
 * One parent write after typecast: a record id, or a title (the primary
 * field of the parent record) that the server resolves to an id.
 */
export type ParentInput = { readonly id: string } | { readonly title: string };

/** The record id of a json write (`"rec_…"` or `{ id }`), or `null`. */
function entryId(value: unknown): string | null {
  if (typeof value === 'string') return isId('rec', value) ? value : null;
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value) {
    return isId('rec', value.id) ? value.id : null;
  }
  return null;
}

/** The parent id of a validated write, `null` for an empty cell. */
export function parentIdOf(value: unknown): string | null {
  return value === null || value === undefined ? null : entryId(value);
}

function validateParent(value: unknown): ValidationResult {
  if (value === null) return OK;
  if (typeof value !== 'string' && (typeof value !== 'object' || Array.isArray(value))) {
    return invalid(
      issue('EXPECTED_STRING', `Expected a record id or null, got ${describe(value)}`),
    );
  }
  return entryId(value) === null
    ? invalid(issue('INVALID_RECORD_ID', 'Expected a record id of the form rec_<16 base62>'))
    : OK;
}

export interface ParentFieldTypeDefinition {
  readonly type: 'parent';
  readonly readOnly: false;
  readonly supportsDefaultValue: false;
  readonly optionsSchema: typeof parentOptionsSchema;
  /** `"rec_…"`, `{ id }` or `null`. */
  validate(value: unknown, options: ParentOptions): ValidationResult;
  /**
   * `typecast=true`: a string that is not a record id is a title (exact
   * match of the primary field, unique among records the writer reads),
   * resolved by the server before `validate`; a one-element array is its
   * element.
   */
  typecast(
    input: unknown,
    options: ParentOptions,
    ctx: LocaleContext,
  ): TypecastResult<ParentInput | null>;
  /** The parent record id, `null` for an empty cell. */
  toStorage(value: unknown, options: ParentOptions): string | null;
  /** The `{ id, title }` the server assembled; `null` for an empty cell. */
  fromStorage(stored: unknown, options: ParentOptions): LinkRef | null;
  /** `cell_format=text`: the title of a readable parent, else empty. */
  formatText(value: LinkRef | null, options: ParentOptions, ctx: LocaleContext): string;
  filterOperators(options: ParentOptions): readonly FilterOperator[];
}

/**
 * `parent` (SPEC §5.7, BACKLOG T405): the parent record of a sub-record,
 * stored in `__parent_id` of the same table. Reads return `{ id, title }`
 * like one linked record (`title = null` when the reader cannot read the
 * parent, P20); cycle and depth checks are the server's (they need the
 * tree).
 */
export const parentFieldType: ParentFieldTypeDefinition = {
  type: 'parent',
  readOnly: false,
  supportsDefaultValue: false,
  optionsSchema: parentOptionsSchema,
  validate: validateParent,
  typecast(input) {
    let value: unknown = input;
    if (Array.isArray(value)) {
      if (value.length > 1) {
        return invalid(issue('TOO_MANY_VALUES', 'A record has at most one parent', { limit: 1 }));
      }
      value = value[0] ?? null;
    }
    if (value === null || value === undefined) return cast(null);
    if (typeof value === 'number' && Number.isFinite(value)) return cast({ title: String(value) });
    if (typeof value === 'string') {
      const text = value.trim();
      if (text === '') return cast(null);
      return cast(isId('rec', text) ? { id: text } : { title: text });
    }
    const id = entryId(value);
    if (id === null) {
      return invalid(issue('INVALID_RECORD_ID', `Cannot read ${describe(value)} as a record`));
    }
    return cast({ id });
  },
  toStorage(value) {
    assertValid(validateParent(value));
    return parentIdOf(value);
  },
  fromStorage(stored) {
    if (typeof stored !== 'object' || stored === null || !('id' in stored)) return null;
    const { id } = stored;
    if (typeof id !== 'string') return null;
    const title = 'title' in stored && typeof stored.title === 'string' ? stored.title : null;
    return { id, title };
  },
  formatText: (value) => value?.title ?? '',
  filterOperators: () => MULTI_VALUE_OPERATORS,
};
