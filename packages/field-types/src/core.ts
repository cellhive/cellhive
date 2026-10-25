import type { FilterOperator } from './operators.js';
import type { z } from 'zod';

/**
 * Field type names (SPEC §5.5). S1 implements the storage and system types;
 * S4 adds `attachment` (T406); link/parent/lookup/formula are reserved so
 * that meta and contracts can already name them.
 */
export const S1_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'datetime',
  'checkbox',
  'user',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'auto_number',
] as const;

/**
 * Types implemented after S1 (BACKLOG S4), one entry per task. Kept apart
 * from `S1_FIELD_TYPES` so that clients opt in per type (the web grid and
 * form builder handle only the S1 types until their S4 tasks land).
 */
export const S4_FIELD_TYPES = ['attachment'] as const;

export const RESERVED_FIELD_TYPES = ['link', 'parent', 'lookup', 'formula'] as const;

/**
 * Types added in S5 (T517): `button` has no column and no stored value (its
 * cell is computed per viewer by the server), so it has no definition in
 * the registry either; see `types/button.ts`.
 */
export const S5_FIELD_TYPES = ['button'] as const;

export const FIELD_TYPES = [
  ...S1_FIELD_TYPES,
  ...RESERVED_FIELD_TYPES,
  ...S4_FIELD_TYPES,
  ...S5_FIELD_TYPES,
] as const;

/** Every type with a definition in the registry (S1 plus the S4 types done so far). */
export const IMPLEMENTED_FIELD_TYPES = [...S1_FIELD_TYPES, ...S4_FIELD_TYPES] as const;

export type S1FieldType = (typeof S1_FIELD_TYPES)[number];
export type S4FieldType = (typeof S4_FIELD_TYPES)[number];
export type ImplementedFieldType = (typeof IMPLEMENTED_FIELD_TYPES)[number];
export type ReservedFieldType = (typeof RESERVED_FIELD_TYPES)[number];
export type FieldType = (typeof FIELD_TYPES)[number];

/** System columns every data table has (SPEC §5.4) that system field types point at. */
export type SystemColumn = '__created_at' | '__updated_at' | '__created_by' | '__updated_by';

/**
 * Codes for `errors[].code` inside an `INVALID_CELL_VALUE` (or, for
 * `INVALID_SELECT_OPTION` / `FIELD_READ_ONLY`, the matching top-level) problem
 * (CONTRACTS §6). The caller adds `path`.
 */
export const VALUE_ISSUE_CODES = [
  'EXPECTED_STRING',
  'EXPECTED_NUMBER',
  'EXPECTED_BOOLEAN',
  'EXPECTED_ARRAY',
  'EXPECTED_DATE',
  'EXPECTED_DATETIME',
  'EXPECTED_USER',
  'INVALID_SELECT_OPTION',
  'INVALID_USER_ID',
  'INVALID_EMAIL',
  'USER_NOT_FOUND',
  'TOO_MANY_VALUES',
  'FIELD_READ_ONLY',
  'INVALID_RECORD_ID',
  'LINK_TARGET_NOT_FOUND',
  'EXPECTED_ATTACHMENT',
  'ATTACHMENT_NOT_FOUND',
] as const;

export type ValueIssueCode = (typeof VALUE_ISSUE_CODES)[number];

export interface ValueIssue {
  readonly code: ValueIssueCode;
  /** English, for logs and API `message`; UIs translate by `code` + `params`. */
  readonly message: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly ValueIssue[] };

export type TypecastResult<W> =
  | {
      readonly ok: true;
      /** Value in the json write shape; still to be passed through `validate`/`toStorage`. */
      readonly value: W;
      /**
       * Select only: option names the input referred to that do not exist yet.
       * The caller either creates them (role may manage the field) or reports
       * `INVALID_SELECT_OPTION`. Always empty for other types.
       */
      readonly unknownOptions: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly ValueIssue[] };

/** Thrown by `toStorage` when given a value that does not pass `validate`. */
export class FieldValueError extends Error {
  readonly issues: readonly ValueIssue[];

  constructor(issues: readonly ValueIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '));
    this.name = 'FieldValueError';
    this.issues = issues;
  }
}

/** Locale and time zone used for typecast and text formatting (org/user/base settings, SPEC §18). */
export interface LocaleContext {
  /** BCP 47 tag, e.g. `vi`, `vi-VN`, `en-US`. */
  readonly locale: string;
  /** IANA zone, used when the field has no `timezone` of its own. */
  readonly timeZone: string;
}

export interface PgTypeContext {
  /** Base collation (`meta.bases.settings.collation`), e.g. `und-x-icu`, `vi-VN-x-icu`. */
  readonly collation: string;
}

/** A user as returned in json reads (CONTRACTS §2). `name`/`email` come from the resolver. */
export interface UserRef {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

export interface ReadContext {
  /** Looks up display data for a stored user id; unknown ids are returned as `{ id }`. */
  readonly resolveUser?: (id: string) => UserRef | undefined;
}

/** Display data of an attachment (`meta.attachments`), cached in the cell (SPEC §5.5). */
export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
}

export interface StorageContext {
  /** Maps an email from a `[{ email }]` write to a user id; `undefined` → `USER_NOT_FOUND`. */
  readonly resolveUserEmail?: (email: string) => string | undefined;
  /**
   * An attachment the write may use in this cell (ready, uploaded for this
   * table and field, and acceptable to the caller); `undefined` →
   * `ATTACHMENT_NOT_FOUND`. The server checks ownership separately.
   */
  readonly resolveAttachment?: (id: string) => AttachmentRef | undefined;
}

/**
 * Everything the platform knows about one field type.
 *
 * - `O`: parsed options (output of `optionsSchema`)
 * - `W`: json write shape after typecast
 * - `S`: storage value handed to the repository as a query parameter
 * - `R`: json read shape (`cell_format=json`, CONTRACTS §2)
 *
 * Pipeline for a write: `typecast` (only when `typecast=true`) → `validate` →
 * `toStorage`. For a read: `fromStorage` → optionally `formatText`.
 */
export interface FieldTypeDefinition<O, W, S, R> {
  readonly type: ImplementedFieldType;
  readonly readOnly: boolean;
  /** SPEC §5.5: only text, number, select, datetime and user support `default_value`. */
  readonly supportsDefaultValue: boolean;
  /** Set for types that read a system column instead of owning a physical column. */
  readonly systemColumn: SystemColumn | null;
  readonly optionsSchema: z.ZodType<O>;
  /** SQL type for `ADD COLUMN`, or `null` when the type has no column of its own. */
  pgType(options: O, ctx: PgTypeContext): string | null;
  validate(value: unknown, options: O): ValidationResult;
  typecast(input: unknown, options: O, ctx: LocaleContext): TypecastResult<W>;
  /** Validates then converts; throws {@link FieldValueError} on invalid input. */
  toStorage(value: unknown, options: O, ctx?: StorageContext): S;
  /** Tolerates driver shapes (numeric as string, `Date`) and bad data (→ `null`). */
  fromStorage(stored: unknown, options: O, ctx?: ReadContext): R;
  /** `cell_format=text`, from the json read value. */
  formatText(value: R, options: O, ctx: LocaleContext): string;
  filterOperators(options: O): readonly FilterOperator[];
}

/** Registry-level view where option and value types are erased. */
export type AnyFieldTypeDefinition = FieldTypeDefinition<unknown, unknown, unknown, unknown>;
