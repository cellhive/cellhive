import { idOf, isId } from '@cellhive/contracts';
import { z } from 'zod';

import {
  FieldValueError,
  type FieldTypeDefinition,
  type ReadContext,
  type UserRef,
  type ValidationResult,
  type ValueIssue,
} from '../core.js';
import {
  assertValid,
  cast,
  describe,
  invalid,
  issue,
  OK,
  splitList,
  unique,
} from '../internal/results.js';
import { MULTI_VALUE_OPERATORS } from '../operators.js';

export const CURRENT_USER_SLOT = { $slot: 'current_user' } as const;

export const userOptionsSchema = z
  .strictObject({
    multiple: z.boolean().default(true),
    notify_on_assign: z.boolean().default(false),
    default_value: z
      .array(
        z.union([
          z.strictObject({ $slot: z.literal('current_user') }),
          z.strictObject({ id: idOf('usr') }),
        ]),
      )
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.multiple && (value.default_value?.length ?? 0) > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_value'],
        message: 'A single-user field has at most one default user',
      });
    }
  });

export type UserOptions = z.output<typeof userOptionsSchema>;

/** One entry of a json write: `{ id }` or `{ email }` (extra keys such as `name` are ignored). */
export type UserInput = { readonly id: string } | { readonly email: string };

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

function entryIssue(entry: unknown): ValueIssue | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return issue('EXPECTED_USER', `Expected { id } or { email }, got ${describe(entry)}`);
  }
  if ('id' in entry) {
    return isId('usr', entry.id)
      ? null
      : issue('INVALID_USER_ID', 'Expected a user id of the form usr_<16 base62>');
  }
  if ('email' in entry) {
    return typeof entry.email === 'string' && isEmail(entry.email)
      ? null
      : issue('INVALID_EMAIL', 'Expected a valid email address');
  }
  return issue('EXPECTED_USER', 'Expected { id } or { email }');
}

function validateUsers(value: unknown, multiple: boolean): ValidationResult {
  if (value === null) return OK;
  if (!Array.isArray(value)) {
    return invalid(issue('EXPECTED_ARRAY', `Expected an array of users, got ${describe(value)}`));
  }
  if (!multiple && value.length > 1) {
    return invalid(
      issue('TOO_MANY_VALUES', 'Single-user field accepts at most one user', { max: 1 }),
    );
  }
  const issues = value.map(entryIssue).filter((found): found is ValueIssue => found !== null);
  return issues.length === 0 ? OK : invalid(...issues);
}

function typecastEntry(item: unknown): unknown {
  if (typeof item !== 'string') return item;
  return isId('usr', item) ? { id: item } : { email: item };
}

/** Read shape for one stored user id. */
export function userRefOf(id: string, ctx: ReadContext | undefined): UserRef {
  return ctx?.resolveUser?.(id) ?? { id };
}

/** Display text of a user: name, else email, else id. */
export function userDisplayName(user: UserRef): string {
  return user.name ?? user.email ?? user.id;
}

/**
 * `user` (SPEC §5.5): `text[]` of user ids. Reads return user objects (always
 * an array, even for single-user fields); writes take `{ id }` or `{ email }`.
 */
export const userFieldType: FieldTypeDefinition<
  UserOptions,
  UserInput[] | null,
  string[] | null,
  UserRef[] | null
> = {
  type: 'user',
  readOnly: false,
  supportsDefaultValue: true,
  systemColumn: null,
  optionsSchema: userOptionsSchema,
  pgType: () => 'text[]',
  validate: (value, options) => validateUsers(value, options.multiple),
  typecast(input, options) {
    if (input === null || input === undefined) return cast(null);
    let entries: unknown[];
    if (typeof input === 'string') entries = splitList(input, /[,;]/).map(typecastEntry);
    else if (Array.isArray(input)) entries = input.map(typecastEntry);
    else if (typeof input === 'object') entries = [input];
    else return invalid(issue('EXPECTED_USER', `Cannot read ${describe(input)} as users`));

    const result = validateUsers(entries, options.multiple);
    if (!result.ok) return result;
    return cast(entries.length === 0 ? null : (entries as UserInput[]));
  },
  toStorage(value, options, ctx) {
    assertValid(validateUsers(value, options.multiple));
    const ids = ((value ?? []) as UserInput[]).map((entry) => {
      if ('id' in entry) return entry.id;
      const id = ctx?.resolveUserEmail?.(entry.email);
      if (id === undefined) {
        throw new FieldValueError([
          issue('USER_NOT_FOUND', 'No user with this email', { email: entry.email }),
        ]);
      }
      return id;
    });
    const distinct = unique(ids);
    return distinct.length === 0 ? null : distinct;
  },
  fromStorage(stored, _options, ctx) {
    if (!Array.isArray(stored) || stored.length === 0) return null;
    return stored
      .filter((id): id is string => typeof id === 'string')
      .map((id) => userRefOf(id, ctx));
  },
  formatText: (value) => (value ?? []).map(userDisplayName).join(', '),
  filterOperators: () => MULTI_VALUE_OPERATORS,
};
