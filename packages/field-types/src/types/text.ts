import { aiFieldStoredOptionsSchema } from '@cellhive/contracts';
import { z } from 'zod';

import { assertValid, cast, describe, invalid, issue, OK } from '../internal/results.js';
import { TEXT_OPERATORS } from '../operators.js';

import type { FieldTypeDefinition, PgTypeContext } from '../core.js';

export const TEXT_STYLES = ['plain', 'phone', 'url', 'email', 'barcode'] as const;

export const textOptionsSchema = z.strictObject({
  /** Display/input hint only: values are never rejected because of the style. */
  style: z.strictObject({ type: z.enum(TEXT_STYLES).default('plain') }).default({ type: 'plain' }),
  default_value: z.string().nullable().optional(),
  /** An AI field (T910, CONTRACTS §29.5): read-only cells generated from a prompt; `null` = none. */
  ai: aiFieldStoredOptionsSchema.nullable().optional(),
});

export type TextStyle = (typeof TEXT_STYLES)[number];
export type TextOptions = z.output<typeof textOptionsSchema>;

/** Collation names as PostgreSQL/ICU spell them; anything else is refused before it reaches DDL. */
const COLLATION = /^[A-Za-z0-9_.@-]+$/;

/** `COLLATE "<collation>"`, refusing names that could break out of the quoted identifier. */
export function collateClause(ctx: PgTypeContext): string {
  if (!COLLATION.test(ctx.collation)) {
    throw new TypeError(`Unsupported collation name: ${JSON.stringify(ctx.collation)}`);
  }
  return `COLLATE "${ctx.collation}"`;
}

function validateText(value: unknown) {
  if (value === null || typeof value === 'string') return OK;
  return invalid(
    issue('EXPECTED_STRING', `Expected a string, got ${describe(value)}`, {
      received: describe(value),
    }),
  );
}

/** `text` (SPEC §5.5) with styles plain/phone/url/email/barcode. */
export const textFieldType: FieldTypeDefinition<
  TextOptions,
  string | null,
  string | null,
  string | null
> = {
  type: 'text',
  readOnly: false,
  supportsDefaultValue: true,
  systemColumn: null,
  optionsSchema: textOptionsSchema,
  pgType: (_options, ctx) => `text ${collateClause(ctx)}`,
  validate: validateText,
  typecast(input) {
    if (input === null || input === undefined || input === '') return cast(null);
    if (typeof input === 'string' || typeof input === 'boolean') return cast(String(input));
    if (typeof input === 'number' && Number.isFinite(input)) return cast(String(input));
    return invalid(issue('EXPECTED_STRING', `Cannot convert ${describe(input)} to text`));
  },
  toStorage(value) {
    assertValid(validateText(value));
    // CONTRACTS §2: an empty string is stored as an empty cell.
    return value === '' ? null : (value as string | null);
  },
  fromStorage: (stored) => (typeof stored === 'string' ? stored : null),
  formatText: (value) => value ?? '',
  filterOperators: () => TEXT_OPERATORS,
};
