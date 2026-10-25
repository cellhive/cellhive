import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { chartSlotOfOptionColor, type MetricConfig } from '../model/chart-model';
import {
  fieldNumberStyle,
  metricFormatter,
  percentFormatter,
  type NumberFormatter,
  type WidgetNumberFormat,
} from '../model/format';
import { groupLabel, type GroupTexts } from '../model/labels';

import type { FieldDto, WidgetDataColumn, WidgetGroupValue } from '@cellhive/contracts';

/** How a widget's numbers and groups read on this screen. */
export interface WidgetPresentation {
  readonly locale: string;
  readonly format: (metricId: string) => NumberFormatter;
  readonly percent: NumberFormatter;
  readonly metricName: (metric: MetricConfig) => string;
  readonly label: (cell: WidgetGroupValue, column: WidgetDataColumn | undefined) => string;
  readonly optionSlot: (value: string) => number | undefined;
  readonly fieldName: (fieldId: string | null | undefined) => string | null;
  readonly otherLabel: string;
}

interface SelectOption {
  readonly id: string;
  readonly color?: number;
}

function optionsOf(field: FieldDto | undefined): readonly SelectOption[] {
  const options = (field?.options as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? (options as SelectOption[]) : [];
}

/**
 * (T811) Formatting of one widget: metric number formats (widget format,
 * else the field's style — FRONTEND §9.1 `Intl`), metric names, group
 * labels (empty group, checkbox, date buckets, ranges) and select option
 * colors of the dimension field. `fields`: the readable fields of the
 * widget's table (`GET /tables/:id/fields`), when loaded.
 */
export function useWidgetPresentation(
  metrics: readonly MetricConfig[],
  numberFormat: WidgetNumberFormat | null | undefined,
  fields: readonly FieldDto[] | undefined,
  optionFieldIds: readonly (string | null | undefined)[],
): WidgetPresentation {
  const { t, i18n } = useTranslation('dashboard');
  const locale = i18n.language;
  return useMemo(() => {
    const byId = new Map<string, FieldDto>((fields ?? []).map((field) => [field.id, field]));
    const formatters = new Map<string, NumberFormatter>();
    for (const metric of metrics) {
      const field = metric.field === null ? undefined : byId.get(metric.field);
      formatters.set(
        metric.id,
        metricFormatter(locale, numberFormat, fieldNumberStyle(field?.options), metric.aggregation),
      );
    }
    const plain = metricFormatter(locale, null, null, null);
    const texts: GroupTexts = {
      empty: t('group.empty'),
      other: t('group.other'),
      checked: t('group.checked'),
      unchecked: t('group.unchecked'),
      noAccess: t('group.noAccess'),
      unknownUser: t('group.unknownUser'),
      weekOf: (date) => t('group.weekOf', { date }),
      quarter: (quarter, year) => t('group.quarter', { quarter, year }),
    };
    const slots = new Map<string, number>();
    for (const fieldId of optionFieldIds) {
      if (fieldId === null || fieldId === undefined) continue;
      optionsOf(byId.get(fieldId)).forEach((option, position) => {
        slots.set(option.id, chartSlotOfOptionColor(option.color, position));
      });
    }
    const fieldName = (fieldId: string | null | undefined) =>
      fieldId === null || fieldId === undefined ? null : (byId.get(fieldId)?.name ?? null);
    return {
      locale,
      format: (metricId) => formatters.get(metricId) ?? plain,
      percent: percentFormatter(locale),
      metricName: (metric) =>
        metric.label !== null && metric.label !== ''
          ? metric.label
          : t(`metric.${metric.aggregation}`, { field: fieldName(metric.field) ?? '' }),
      label: (cell, column) => groupLabel(cell, column, locale, texts, plain),
      optionSlot: (value) => slots.get(value),
      fieldName,
      otherLabel: texts.other,
    };
  }, [fields, locale, metrics, numberFormat, optionFieldIds, t]);
}
