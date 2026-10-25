import { z } from 'zod';

import { assertValid, cast, describe, invalid, issue, OK } from '../internal/results.js';
import { CHECKBOX_OPERATORS } from '../operators.js';

import type { FieldTypeDefinition } from '../core.js';

export const checkboxOptionsSchema = z.strictObject({});

export type CheckboxOptions = z.output<typeof checkboxOptionsSchema>;

/** Strings read as `true` by typecast (CONTRACTS §2), compared after trim + lower-case. */
export const CHECKBOX_TRUE_STRINGS: readonly string[] = [
  'true',
  '1',
  'x',
  'có',
  'yes',
  'y',
  'on',
  '✓',
];
/** Strings read as `false`; anything else is rejected rather than guessed. */
export const CHECKBOX_FALSE_STRINGS: readonly string[] = [
  'false',
  '0',
  '',
  'không',
  'no',
  'n',
  'off',
];

function validateCheckbox(value: unknown) {
  if (value === null || typeof value === 'boolean') return OK;
  return invalid(issue('EXPECTED_BOOLEAN', `Expected a boolean, got ${describe(value)}`));
}

/** `checkbox` (SPEC §5.5): `boolean NOT NULL DEFAULT false`; an empty cell is `false`. */
export const checkboxFieldType: FieldTypeDefinition<CheckboxOptions, boolean, boolean, boolean> = {
  type: 'checkbox',
  readOnly: false,
  supportsDefaultValue: false,
  systemColumn: null,
  optionsSchema: checkboxOptionsSchema,
  pgType: () => 'boolean NOT NULL DEFAULT false',
  validate: validateCheckbox,
  typecast(input) {
    if (input === null || input === undefined) return cast(false);
    if (typeof input === 'boolean') return cast(input);
    if (input === 0 || input === 1) return cast(input === 1);
    if (typeof input === 'string') {
      const text = input.normalize('NFC').trim().toLowerCase();
      if (CHECKBOX_TRUE_STRINGS.includes(text)) return cast(true);
      if (CHECKBOX_FALSE_STRINGS.includes(text)) return cast(false);
    }
    return invalid(issue('EXPECTED_BOOLEAN', `Cannot read ${describe(input)} as a checkbox value`));
  },
  toStorage(value) {
    assertValid(validateCheckbox(value));
    return value === true;
  },
  fromStorage: (stored) => stored === true,
  formatText: (value) => (value ? '✓' : ''),
  filterOperators: () => CHECKBOX_OPERATORS,
};
