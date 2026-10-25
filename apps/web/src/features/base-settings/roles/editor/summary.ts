import { selectOptionsSchema } from '@cellhive/field-types';
import { isVariableValue, type FilterNode } from '@cellhive/filter-dsl';

import type { FieldDto } from '@cellhive/contracts';
import type { TableRule } from '@cellhive/permissions';
import type { TFunction } from 'i18next';

/**
 * The record rule of a table in words (T713, S6-research §4 #3): "Edits
 * records where Owner has any of Current user. Reads only the records it
 * can edit. Can add records." Built from the stored DSL with the names the
 * admin sees; pure — the caller passes the translator.
 */

export type Translate = TFunction<['baseSettings', 'toolbar']>;

export interface SummaryContext {
  readonly t: Translate;
  readonly fields: ReadonlyMap<string, Pick<FieldDto, 'id' | 'name' | 'type' | 'options'>>;
  /** Display names of the organization's members, by user id. */
  readonly users: ReadonlyMap<string, string>;
}

const MAX_LISTED = 3;

function listText(items: readonly string[], context: SummaryContext): string {
  if (items.length <= MAX_LISTED) return items.join(', ');
  return context.t('editor.summary.listMore', {
    items: items.slice(0, MAX_LISTED).join(', '),
    count: items.length - MAX_LISTED,
  });
}

function operandText(
  value: unknown,
  field: Pick<FieldDto, 'type' | 'options'> | undefined,
  context: SummaryContext,
): string {
  if (isVariableValue(value)) {
    return context.t(`toolbar:filter.variables.${value.$var}`, { defaultValue: value.$var });
  }
  if (typeof value === 'string') {
    if (field?.type === 'select') {
      const parsed = selectOptionsSchema.safeParse(field.options);
      const option = parsed.success
        ? parsed.data.options.find((item) => item.id === value)
        : undefined;
      if (option !== undefined) return option.name;
    }
    if (value.startsWith('usr_')) return context.users.get(value) ?? value;
    return `“${value}”`;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
  ) {
    return operandText(value.id, field, context);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function valueText(
  value: unknown,
  field: Pick<FieldDto, 'type' | 'options'> | undefined,
  context: SummaryContext,
): string {
  if (Array.isArray(value)) {
    // Linked records are named by id: say how many.
    if (field?.type === 'link') return context.t('editor.summary.records', { count: value.length });
    return listText(
      value.map((item) => operandText(item, field, context)),
      context,
    );
  }
  return operandText(value, field, context);
}

/** One condition or group in words; groups inside groups get parentheses. */
export function conditionText(node: FilterNode, context: SummaryContext, nested = false): string {
  if ('field' in node) {
    const field = context.fields.get(node.field);
    const name = field?.name ?? context.t('editor.summary.unknownField');
    const operator = context.t(`toolbar:filter.operators.${node.operator}`, {
      defaultValue: node.operator,
    });
    return node.value === undefined || node.value === null
      ? `${name} ${operator}`
      : `${name} ${operator} ${valueText(node.value, field, context)}`;
  }
  if (node.op === 'not') {
    return context.t('editor.summary.not', { condition: conditionText(node.item, context, true) });
  }
  const joiner = ` ${context.t(node.op === 'and' ? 'editor.summary.and' : 'editor.summary.or')} `;
  const text = node.items.map((item) => conditionText(item, context, true)).join(joiner);
  return nested && node.items.length > 1 ? `(${text})` : text;
}

/** The sentences of a table's record rule (editing, reading, adding and deleting). */
export function recordRuleSummary(rule: TableRule, context: SummaryContext): string[] {
  const { t } = context;
  if (rule.perm === 'no_perm') return [t('editor.summary.noAccess')];
  const record = rule.record_rule;
  const sentences: string[] = [];
  const editing = rule.perm === 'edit' || rule.perm === 'manage';
  if (!editing) sentences.push(t('editor.summary.editNone'));
  else if (record.edit_filter === null) sentences.push(t('editor.summary.editAll'));
  else {
    sentences.push(
      t('editor.summary.editWhere', { condition: conditionText(record.edit_filter, context) }),
    );
  }
  if (record.read_scope === 'all') sentences.push(t('editor.summary.readAll'));
  else if (record.read_scope === 'editable') {
    sentences.push(
      editing && record.edit_filter !== null
        ? t('editor.summary.readEditable')
        : t('editor.summary.readEditableAll'),
    );
  } else if (record.read_filter !== null) {
    sentences.push(
      t('editor.summary.readWhere', { condition: conditionText(record.read_filter, context) }),
    );
  }
  if (editing) {
    const add = record.operations.includes('add');
    const remove = record.operations.includes('delete');
    sentences.push(
      t(
        add && remove
          ? 'editor.summary.addDelete'
          : add
            ? 'editor.summary.addOnly'
            : remove
              ? 'editor.summary.deleteOnly'
              : 'editor.summary.noAddDelete',
      ),
    );
  }
  return sentences;
}
