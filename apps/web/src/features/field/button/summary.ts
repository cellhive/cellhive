import type { FieldDto } from '@cellhive/contracts';

/**
 * The condition line of the automation card of a button field (T525, board
 * "S5 · Button field - cấu hình": "Button enabled when Status is Pending").
 * Pure; the card translates the operators.
 */

/** One top-level condition of `enabled_when`, with names instead of ids. */
export interface ConditionPart {
  /** The field's name; `null` when the field is gone or not readable. */
  readonly field: string | null;
  readonly operator: string;
  /** The value as short text; `null` for operators without one (`is_empty`). */
  readonly value: string | null;
}

export interface ConditionSummary {
  readonly op: 'and' | 'or';
  readonly parts: readonly ConditionPart[];
  /** Top-level items not spelt out (nested groups, negations, beyond `max`). */
  readonly more: number;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function optionName(field: FieldDto | undefined, id: unknown): string | undefined {
  const options = objectOf(field?.options)?.['options'];
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    const item = objectOf(option);
    const name = item?.['name'];
    if (item?.['id'] === id && typeof name === 'string') return name;
  }
  return undefined;
}

function operandText(value: unknown, field: FieldDto | undefined): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item) => operandText(item, field)).join(', ');
  if (typeof value === 'object') return '…';
  if (typeof value === 'string') return optionName(field, value) ?? value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '…';
}

/**
 * The top-level conditions of a filter (DSL, SPEC §6.1), at most `max`;
 * `null` for no condition (the button is always enabled).
 */
export function summarizeCondition(
  filter: unknown,
  fields: readonly FieldDto[],
  max = 3,
): ConditionSummary | null {
  const root = objectOf(filter);
  if (root === undefined || Object.keys(root).length === 0) return null;
  const grouped = root['op'] === 'and' || root['op'] === 'or';
  const items = grouped && Array.isArray(root['items']) ? (root['items'] as unknown[]) : [root];
  if (items.length === 0) return null;
  const parts: ConditionPart[] = [];
  let more = 0;
  for (const item of items) {
    const condition = objectOf(item);
    if (parts.length >= max || condition === undefined || typeof condition['field'] !== 'string') {
      more += 1;
      continue;
    }
    const field = fields.find((candidate) => candidate.id === condition['field']);
    parts.push({
      field: field?.name ?? null,
      operator: typeof condition['operator'] === 'string' ? condition['operator'] : 'is',
      value: 'value' in condition ? operandText(condition['value'], field) : null,
    });
  }
  return { op: root['op'] === 'or' ? 'or' : 'and', parts, more };
}
