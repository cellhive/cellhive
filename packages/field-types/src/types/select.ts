import { idOf, isId } from '@cellhive/contracts';
import { z } from 'zod';

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
import { MULTI_VALUE_OPERATORS, SINGLE_SELECT_OPERATORS } from '../operators.js';

import type { FieldTypeDefinition, ValidationResult, ValueIssue } from '../core.js';

/** SPEC §5.5: at most 1 000 options per field. */
export const MAX_SELECT_OPTIONS = 1000;
export const MAX_OPTION_NAME_LENGTH = 255;
/** Colour index into the UI palette (same range as Lark Base). */
export const MAX_OPTION_COLOR = 54;

const optionIdSchema = idOf('opt');

export const selectOptionSchema = z.strictObject({
  id: optionIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_OPTION_NAME_LENGTH)
    .refine((name) => !isId('opt', name), {
      message: 'Option name must not look like an option id',
    }),
  color: z.int().min(0).max(MAX_OPTION_COLOR).optional(),
});

export const selectOptionsSchema = z
  .strictObject({
    multiple: z.boolean().default(false),
    options: z.array(selectOptionSchema).max(MAX_SELECT_OPTIONS).default([]),
    /** Option ids (not names), so renaming an option keeps the default. */
    default_value: z
      .union([optionIdSchema, z.array(optionIdSchema)])
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    value.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'id'],
          message: 'Duplicate option id',
        });
      }
      if (names.has(option.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'name'],
          message: 'Duplicate option name',
        });
      }
      ids.add(option.id);
      names.add(option.name);
    });
    const fallback = value.default_value;
    if (fallback === null || fallback === undefined) return;
    if (Array.isArray(fallback) !== value.multiple) {
      ctx.addIssue({
        code: 'custom',
        path: ['default_value'],
        message: value.multiple ? 'Expected an array of option ids' : 'Expected one option id',
      });
      return;
    }
    for (const id of Array.isArray(fallback) ? fallback : [fallback]) {
      if (!ids.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['default_value'], message: `Unknown option ${id}` });
      }
    }
  });

export type SelectOption = z.output<typeof selectOptionSchema>;
export type SelectOptions = z.output<typeof selectOptionsSchema>;
export type SelectValue = string | string[] | null;

/** Resolves an option by id first, then by exact name. */
export function findSelectOption(options: SelectOptions, token: string): SelectOption | undefined {
  return (
    options.options.find((option) => option.id === token) ??
    options.options.find((option) => option.name === token)
  );
}

/** Tokens of a write value, or an issue when its shape is wrong. */
function tokensOf(value: unknown, options: SelectOptions): string[] | ValueIssue {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    if (options.multiple) {
      return issue('EXPECTED_ARRAY', `Expected an array of options, got ${describe(value)}`);
    }
    if (typeof value !== 'string') {
      return issue('EXPECTED_STRING', `Expected an option name or id, got ${describe(value)}`);
    }
    return [value];
  }
  if (!options.multiple && value.length > 1) {
    return issue('TOO_MANY_VALUES', 'Single select accepts at most one option', { max: 1 });
  }
  if (!value.every((item): item is string => typeof item === 'string')) {
    return issue('EXPECTED_STRING', 'Every option must be a name or id string');
  }
  return value;
}

function validateSelect(value: unknown, options: SelectOptions): ValidationResult {
  const tokens = tokensOf(value, options);
  if (!Array.isArray(tokens)) return invalid(tokens);
  const issues = tokens
    .filter((token) => findSelectOption(options, token) === undefined)
    .map((token) =>
      issue('INVALID_SELECT_OPTION', `Option ${JSON.stringify(token)} does not exist`, {
        value: token,
      }),
    );
  return issues.length === 0 ? OK : invalid(...issues);
}

function typecastTokens(input: unknown, options: SelectOptions): string[] | ValueIssue {
  if (input === null || input === undefined) return [];
  if (typeof input === 'number') return [String(input)];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    // Keep names that contain commas intact when they match an option exactly.
    if (!options.multiple || findSelectOption(options, trimmed) !== undefined) {
      return trimmed === '' ? [] : [trimmed];
    }
    return splitList(trimmed, /,/);
  }
  if (Array.isArray(input)) {
    const tokens: string[] = [];
    for (const item of input) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        return issue('EXPECTED_STRING', 'Every option must be a name, id or number');
      }
      const token = String(item).trim();
      if (token !== '') tokens.push(token);
    }
    return tokens;
  }
  return options.multiple
    ? issue('EXPECTED_ARRAY', `Expected a list of options, got ${describe(input)}`)
    : issue('EXPECTED_STRING', `Expected an option name, got ${describe(input)}`);
}

/**
 * `select` (SPEC §5.5): `text[]` of option ids. The API reads and writes
 * option names; ids are accepted on write too.
 */
export const selectFieldType: FieldTypeDefinition<
  SelectOptions,
  SelectValue,
  string[] | null,
  SelectValue
> = {
  type: 'select',
  readOnly: false,
  supportsDefaultValue: true,
  systemColumn: null,
  optionsSchema: selectOptionsSchema,
  pgType: () => 'text[]',
  validate: validateSelect,
  typecast(input, options) {
    const found = typecastTokens(input, options);
    if (!Array.isArray(found)) return invalid(found);
    const tokens = unique(found);
    if (!options.multiple && tokens.length > 1) {
      return invalid(
        issue('TOO_MANY_VALUES', 'Single select accepts at most one option', { max: 1 }),
      );
    }
    const unknownOptions = tokens.filter((token) => findSelectOption(options, token) === undefined);
    if (options.multiple) return cast(tokens.length === 0 ? null : tokens, unknownOptions);
    return cast(tokens[0] ?? null, unknownOptions);
  },
  toStorage(value, options) {
    assertValid(validateSelect(value, options));
    const tokens = tokensOf(value, options) as string[];
    const ids = unique(
      tokens.map((token) => (findSelectOption(options, token) as SelectOption).id),
    );
    return ids.length === 0 ? null : ids;
  },
  fromStorage(stored, options) {
    const ids = Array.isArray(stored) ? stored : [];
    const names = ids.flatMap((id) => {
      const option = options.options.find((candidate) => candidate.id === id);
      return option === undefined ? [] : [option.name];
    });
    if (options.multiple) return names.length === 0 ? null : names;
    return names[0] ?? null;
  },
  formatText(value) {
    if (value === null) return '';
    return Array.isArray(value) ? value.join(', ') : value;
  },
  filterOperators: (options) =>
    options.multiple ? MULTI_VALUE_OPERATORS : SINGLE_SELECT_OPERATORS,
};
