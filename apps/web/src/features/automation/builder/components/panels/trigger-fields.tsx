import { foldText } from '@cellhive/filter-dsl';
import { Input, Select } from '@cellhive/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { asFieldId, isUnset } from '../../model/draft';
import { useFields } from '../env';

import { PanelField, Segmented, useIssuesAt } from './common';

import type { AutomationTrigger, FieldDto } from '@cellhive/contracts';

type UpdatedTrigger = Extract<AutomationTrigger, { type: 'record.updated' }>;
type DateTrigger = Extract<AutomationTrigger, { type: 'record.date_reached' }>;

const TRIGGER = 'trigger';
const PATH = {
  watch: 'watch_fields',
  field: 'field_id',
  offset: 'offset_minutes',
  time: 'time_of_day',
} as const;
const DIRECTIONS = ['before', 'on', 'after'] as const;
const UNITS = ['minutes', 'hours', 'days'] as const;

/** Virtual formula/lookup fields: computed on read, they never change by themselves (T509). */
export function isVirtual(field: FieldDto): boolean {
  return field.compute_mode === 'virtual';
}

/**
 * "Run only when these fields change" of `record.updated` (ADR-26, T509;
 * board "S5 · Automation builder"): at least one; virtual computed fields
 * are listed but cannot be chosen, with why.
 */
export function WatchFieldsEditor({
  trigger,
  onChange,
}: {
  readonly trigger: UpdatedTrigger;
  readonly onChange: (trigger: UpdatedTrigger) => void;
}) {
  const { t } = useTranslation('automationBuilder');
  const fields = useFields(isUnset(trigger.table_id) ? null : trigger.table_id);
  const [query, setQuery] = useState('');
  const hintId = useId();
  const needle = foldText(query.trim());
  const shown = fields.filter((field) => needle === '' || foldText(field.name).includes(needle));
  const watched = new Set(trigger.watch_fields);
  return (
    <PanelField
      label={t('trigger.watch')}
      step={TRIGGER}
      path={PATH.watch}
      hint={t('trigger.watchHint')}
      group
    >
      {(control) => (
        <div
          className="flex flex-col rounded-md border border-line-control bg-surface"
          data-testid="watch-fields"
        >
          <div className="border-b border-line p-1.5">
            <Input
              value={query}
              aria-label={t('trigger.watchSearch')}
              placeholder={t('trigger.watchSearch')}
              aria-describedby={control['aria-describedby']}
              className="h-8 border-0 max-lg:h-control"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <ul className="flex max-h-56 flex-col overflow-y-auto py-1" tabIndex={-1}>
            {shown.map((field) => {
              const virtual = isVirtual(field);
              const reasonId = `${hintId}-${field.id}`;
              return (
                <li key={field.id}>
                  <label
                    className={
                      virtual
                        ? 'flex min-h-8 cursor-not-allowed items-start gap-2 px-2.5 py-1 text-body text-fg-muted max-lg:min-h-control'
                        : 'flex min-h-8 cursor-pointer items-start gap-2 px-2.5 py-1 text-body max-lg:min-h-control'
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={watched.has(field.id)}
                      disabled={virtual && !watched.has(field.id)}
                      aria-describedby={virtual ? reasonId : undefined}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...trigger.watch_fields, field.id]
                          : trigger.watch_fields.filter((id) => id !== field.id);
                        onChange({ ...trigger, watch_fields: next });
                      }}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{field.name}</span>
                      {virtual ? (
                        <span id={reasonId} className="text-label font-normal text-fg-muted">
                          {t('trigger.virtual')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </PanelField>
  );
}

/** Date fields `record.date_reached` accepts: datetime, created_at, stored formula/lookup dates. */
export function isDateField(field: FieldDto): boolean {
  if (field.type === 'datetime' || field.type === 'created_at') return true;
  if (field.type !== 'formula' && field.type !== 'lookup') return false;
  const kind = (field.result_type as { kind?: string } | undefined)?.kind;
  return (kind === 'date' || kind === 'datetime') && field.compute_mode === 'stored';
}

function dateOnly(field: FieldDto | undefined): boolean {
  if (field === undefined) return false;
  if (field.type === 'datetime') {
    const format = (field.options as { style?: { format?: string } } | undefined)?.style?.format;
    return format === undefined || !format.includes('HH');
  }
  return (field.result_type as { kind?: string } | undefined)?.kind === 'date';
}

type Unit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1_440 };

function unitOf(minutes: number): Unit {
  const amount = Math.abs(minutes);
  if (amount !== 0 && amount % 1_440 === 0) return 'days';
  if (amount !== 0 && amount % 60 === 0) return 'hours';
  return amount === 0 ? 'days' : 'minutes';
}

/**
 * `record.date_reached` (SPEC §11.2, board): the date field, how long
 * before or after (minutes, hours, days), and the time of day for a field
 * without time (default 09:00 in the field's zone, ADR-21).
 */
export function DateReachedEditor({
  trigger,
  onChange,
}: {
  readonly trigger: DateTrigger;
  readonly onChange: (trigger: DateTrigger) => void;
}) {
  const { t } = useTranslation('automationBuilder');
  const fields = useFields(isUnset(trigger.table_id) ? null : trigger.table_id);
  const dates = fields.filter(isDateField);
  const field = fields.find((item) => item.id === trigger.field_id);
  const [unit, setUnit] = useState<Unit>(() => unitOf(trigger.offset_minutes));
  const direction =
    trigger.offset_minutes === 0 ? 'on' : trigger.offset_minutes < 0 ? 'before' : 'after';
  const amount = Math.abs(trigger.offset_minutes) / UNIT_MINUTES[unit];
  const offsetIssues = useIssuesAt(TRIGGER, PATH.offset);
  const setOffset = (nextAmount: number, nextUnit: Unit, nextDirection: string) => {
    const minutes = Math.round(nextAmount * UNIT_MINUTES[nextUnit]);
    onChange({
      ...trigger,
      offset_minutes: nextDirection === 'on' ? 0 : nextDirection === 'before' ? -minutes : minutes,
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <PanelField label={t('trigger.dateField')} step={TRIGGER} path={PATH.field}>
        {(control) =>
          dates.length === 0 ? (
            <p className="text-label font-normal text-fg-muted">{t('trigger.noDateField')}</p>
          ) : (
            <Select
              {...control}
              value={trigger.field_id}
              data-testid="trigger-date-field"
              onChange={(event) => {
                onChange({ ...trigger, field_id: asFieldId(event.target.value) });
              }}
            >
              <option value="">{t('values.choose')}</option>
              {dates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          )
        }
      </PanelField>
      <PanelField label={t('trigger.when')} step={TRIGGER} path={PATH.offset} group>
        {() => (
          <div className="flex flex-col gap-2">
            <Segmented
              label={t('trigger.when')}
              value={direction}
              options={DIRECTIONS.map((value) => ({
                value,
                label: t(`trigger.direction.${value}`),
              }))}
              onChange={(next) => {
                setOffset(next === 'on' ? 0 : Math.max(1, amount), unit, next);
              }}
            />
            {direction === 'on' ? null : (
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={String(amount)}
                  className="w-24"
                  aria-label={t('trigger.offsetAmount')}
                  aria-invalid={offsetIssues.length > 0 || undefined}
                  onChange={(event) => {
                    const next = event.target.valueAsNumber;
                    if (Number.isFinite(next) && next >= 0) setOffset(next, unit, direction);
                  }}
                />
                <Select
                  className="w-32"
                  aria-label={t('trigger.offsetUnit')}
                  value={unit}
                  onChange={(event) => {
                    const next = event.target.value as Unit;
                    setUnit(next);
                    setOffset(amount, next, direction);
                  }}
                >
                  {UNITS.map((value) => (
                    <option key={value} value={value}>
                      {t(`trigger.unit.${value}`)}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}
      </PanelField>
      {dateOnly(field) ? (
        <PanelField
          label={t('trigger.timeOfDay')}
          step={TRIGGER}
          path={PATH.time}
          hint={t('trigger.timeOfDayHint')}
        >
          {(control) => (
            <Input
              {...control}
              type="time"
              className="w-32"
              value={trigger.time_of_day ?? '09:00'}
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  ...trigger,
                  time_of_day: value === '' || value === '09:00' ? null : value,
                });
              }}
            />
          )}
        </PanelField>
      ) : null}
    </div>
  );
}
