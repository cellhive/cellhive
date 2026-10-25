import {
  referenceExpression,
  stepPathsOf,
  triggerDataOf,
  triggerValuePartsOf,
} from '../../model/values';
import {
  shortPreview,
  webhookPathItems,
  webhookReferenceExpression,
  webhookValue,
} from '../../triggers/webhook/model';

import type { PickerItem, PickerSection } from './ValuePicker';
import type { ScopeNames, ValueScope } from '../../model/scope';
import type { AutomationValue, FieldDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/** What the "+" menu gives: a chip in a template, or a whole value. */
export type PickedValue =
  | { readonly kind: 'ref'; readonly expression: string }
  | { readonly kind: 'value'; readonly value: AutomationValue };

export interface SectionOptions {
  readonly scope: ValueScope;
  readonly names: ScopeNames;
  readonly tableName: (tableId: string) => string | undefined;
  /** `template`: chips (`[fld_…]`, `[act_…].[fld_…]`…); `value`: a whole source value. */
  readonly mode: 'template' | 'value';
  readonly t: TFunction<'automationBuilder'>;
}

const PART_LABELS: Readonly<Record<string, string>> = {
  id: 'chip.part.id',
  count: 'chip.part.count',
  'records[0].id': 'chip.part.firstId',
};

function fieldItems(
  fields: readonly FieldDto[] | undefined,
  keyPrefix: string,
  pick: (field: FieldDto) => PickedValue,
  t: TFunction<'automationBuilder'>,
): PickerItem[] {
  return (fields ?? []).map((field) => ({
    key: `${keyPrefix}${field.id}`,
    label: field.name,
    hint: field.type === 'formula' || field.type === 'lookup' ? t('picker.computed') : undefined,
    tone: 'field' as const,
    pick: pick(field),
  }));
}

/**
 * Sections of the "+" menu for one value (board "S5 · Automation builder -
 * trigger và điều kiện"): the trigger record's fields, the trigger data,
 * the earlier steps — each as a chip of a template or as a whole value.
 */
export function pickerSections({
  scope,
  names,
  tableName,
  mode,
  t,
}: SectionOptions): PickerSection[] {
  const sections: PickerSection[] = [];
  const ref = (expression: string): PickedValue => ({ kind: 'ref', expression });
  const value = (picked: AutomationValue): PickedValue => ({ kind: 'value', value: picked });

  if (scope.triggerTableId !== null) {
    const items = fieldItems(
      names.fieldsOf(scope.triggerTableId),
      'field:',
      (field) =>
        mode === 'template'
          ? ref(referenceExpression({ kind: 'field', fieldId: field.id }))
          : value({ field: field.id }),
      t,
    );
    if (mode === 'template') {
      for (const record of ['@id', '@url'] as const) {
        items.push({
          key: `record:${record}`,
          label: t(`chip.record.${record.slice(1)}` as 'chip.record.id'),
          tone: 'field',
          pick: ref(`[${record}]`),
        });
      }
    }
    sections.push({
      key: 'record',
      title: t('picker.record', { table: tableName(scope.triggerTableId) ?? '' }),
      items,
    });
  }

  sections.push({
    key: 'trigger',
    title: t('picker.trigger'),
    items: (mode === 'template'
      ? triggerDataOf(scope.triggerType)
      : triggerValuePartsOf(scope.triggerType)
    ).map((data) => ({
      key: `trigger:${data}`,
      label: t(`chip.trigger.${data}` as 'chip.trigger.fired_at'),
      tone: 'trigger' as const,
      pick: mode === 'template' ? ref(`[@${data}]`) : value({ trigger: data }),
    })),
  });

  // (T612) Webhook data of `webhook.received`: the whole parts, then the sample's paths.
  if (scope.triggerType === 'webhook.received') {
    sections.push({
      key: 'webhook',
      title: t('picker.webhook'),
      items: webhookPathItems(names.webhookSample ?? null).map((item) => ({
        key: `webhook:${item.label}`,
        label: item.label,
        hint:
          item.kind === null
            ? t(`webhook.whole.${item.part}`)
            : item.kind === 'object' || item.kind === 'array'
              ? t(`webhook.kind.${item.kind}`)
              : shortPreview(item.preview),
        tone: 'trigger' as const,
        pick:
          mode === 'template'
            ? ref(webhookReferenceExpression(item.part, item.pathText))
            : value(webhookValue(item.part, item.pathText)),
      })),
    });
  }

  // `[@previous].[fld_…]` (record.updated, T521b): values before the change.
  if (
    mode === 'template' &&
    scope.triggerType === 'record.updated' &&
    scope.triggerTableId !== null
  ) {
    sections.push({
      key: 'previous',
      title: t('picker.previous'),
      items: fieldItems(
        names.fieldsOf(scope.triggerTableId),
        'previous:',
        (field) => ref(referenceExpression({ kind: 'previous', fieldId: field.id })),
        t,
      ).map((item) => ({
        ...item,
        label: t('chip.previous', { field: item.label }),
        tone: 'trigger' as const,
      })),
    });
  }

  const stepItems = scope.steps.flatMap((step): PickerItem[] => {
    const label = (part: string) => t('chip.stepPart', { number: step.number, part });
    if (mode === 'value') {
      return (step.paths ?? stepPathsOf(step.type)).map((path) => ({
        key: `step:${step.id}:${path}`,
        label: label(
          PART_LABELS[path] === undefined ? path : t(PART_LABELS[path] as 'chip.part.id'),
        ),
        tone: 'step' as const,
        pick: value({ step: step.id, path }),
      }));
    }
    if (step.tableId === null) return [];
    const tableId = step.tableId;
    return [
      {
        key: `step:${step.id}`,
        label: label(t('chip.part.record')),
        hint: tableName(tableId),
        tone: 'step' as const,
        pick: ref(`[${step.id}]`),
      },
      ...fieldItems(
        names.fieldsOf(tableId),
        `step:${step.id}:`,
        (field) => ref(`[${step.id}].[${field.id}]`),
        t,
      ).map((item) => ({
        ...item,
        label: t('chip.stepField', { number: step.number, field: item.label }),
        tone: 'step' as const,
      })),
    ];
  });
  if (stepItems.length > 0) {
    sections.push({ key: 'steps', title: t('picker.steps'), items: stepItems });
  }
  return sections;
}
