import { buttonFieldOptionsSchema, type ButtonFieldOptions } from '@cellhive/contracts';

/**
 * `button` (SPEC §5.5, ADR-32 §2, BACKLOG T517): a field without a column
 * (no slot of ADR-20) and without a stored value. Its cell is computed by the
 * server for each reader (`{ state, reason }`, CONTRACTS §2); a click runs
 * the automation whose trigger is `button.clicked` on it. Never written,
 * filtered, sorted, grouped, summarised, imported or asked on a form; its
 * text form (`cell_format=text`, exports) is the label.
 */
export const buttonOptionsSchema = buttonFieldOptionsSchema;
export type ButtonOptions = ButtonFieldOptions;

/** Pure parts of the `button` type (the server computes its cells). */
export const buttonFieldType = {
  type: 'button',
  readOnly: true,
  supportsDefaultValue: false,
  optionsSchema: buttonOptionsSchema,
  /** `cell_format=text` and exports: the label, whatever the state. */
  formatText: (_value: unknown, options: ButtonOptions): string => options.label,
} as const;

export function isButtonFieldType(value: unknown): value is 'button' {
  return value === 'button';
}
