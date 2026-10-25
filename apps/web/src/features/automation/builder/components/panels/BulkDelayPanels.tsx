import {
  MAX_DELAY_MINUTES,
  MAX_UPDATE_RECORDS_LIMIT,
  MIN_DELAY_MINUTES,
  UPDATE_RECORDS_BATCH_SIZE,
} from '@cellhive/contracts';
import { Input, Select, Switch } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../../lib/api';
import { isAutomationValue } from '../../../../../lib/automation/condition-editor';
import { conditionSlot } from '../../model/check';
import { asTableId, isUnset } from '../../model/draft';
import { useBuilderEnv, useFields } from '../env';
import { FieldMapEditor } from '../values/FieldMapEditor';
import { FilterScopeContext, FilterValueSource } from '../values/FilterValueSource';
import { ValueInput } from '../values/ValueInput';

import { filterIssues, TableSelect, type ActionPanelProps } from './ActionPanels';
import { Note, PanelField, Segmented } from './common';

import type { StepKey } from '../../model/issues';
import type { AutomationValue } from '@cellhive/contracts';

const PATH = {
  fields: 'config.fields',
  filter: 'config.filter',
  limit: 'config.limit',
  minutes: 'config.minutes',
  until: 'config.until',
  recheck: 'config.recheck_condition',
} as const;
const MODES = ['minutes', 'until'] as const;
const UNITS = ['minutes', 'hours', 'days'] as const;
type Unit = (typeof UNITS)[number];
const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1_440 };
const DATETIME = 'datetime';
const COUNT_NOTE = 'update-records-count';
const UNTIL_INPUT = 'delay-until';

function hasSourceValue(filter: unknown): boolean {
  if (typeof filter !== 'object' || filter === null) return false;
  const node = filter as Record<string, unknown>;
  if (Array.isArray(node['items'])) return (node['items'] as unknown[]).some(hasSourceValue);
  if (node['item'] !== undefined) return hasSourceValue(node['item']);
  return isAutomationValue(node['value']);
}

/**
 * How many records match the filter now (board "S5 · Automation builder -
 * action": "Hiện khớp 312 bản ghi"): one `records/query` of one row with
 * its count, only for a filter without values from the automation (those
 * are known when the step runs).
 */
function useMatchCount(tableId: string | null, filter: Readonly<Record<string, unknown>>) {
  const usable = tableId !== null && Object.keys(filter).length > 0 && !hasSourceValue(filter);
  return useQuery({
    queryKey: ['automation-builder', 'match-count', tableId, JSON.stringify(filter)],
    queryFn: async ({ signal }) => {
      const page = await api.records.query(
        tableId ?? '',
        { filter, limit: 1, fields: [] },
        { signal },
      );
      if ('total' in page) return { count: page.total, estimated: false };
      if ('total_estimate' in page) return { count: page.total_estimate, estimated: true };
      return { count: page.records.length, estimated: true };
    },
    enabled: usable,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * `update_records` (SPEC §11.5, ADR-26 §6; T506): a table, the records
 * matching conditions — values may come from the automation (field of the
 * trigger record, trigger data, earlier step) — the values to set and the
 * most records it may change (more matching → the step fails, nothing
 * written). Says how many match now and that writes go by batches of 1 000.
 */
export function UpdateRecordsPanel({
  action,
  scope,
  onChange,
}: ActionPanelProps<'update_records'>) {
  const { t, i18n } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const config = action.config;
  const tableId = isUnset(config.table_id) ? null : config.table_id;
  const fields = useFields(tableId);
  const ConditionEditor = env.ConditionEditor;
  const count = useMatchCount(tableId, config.filter);
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const numbers = new Intl.NumberFormat(i18n.language);
  return (
    <div className="flex flex-col gap-4">
      <TableSelect
        step={step}
        label={t('action.updateIn')}
        value={config.table_id}
        onChange={(next) => {
          onChange({
            ...action,
            config: { table_id: asTableId(next), filter: {}, fields: {}, limit: config.limit },
          });
        }}
      />
      {tableId === null ? null : (
        <>
          <FilterScopeContext.Provider value={scope}>
            <ConditionEditor
              key={`${tableId}:${String(env.resetKey)}`}
              tableId={tableId}
              orgId={env.orgId}
              value={Object.keys(config.filter).length === 0 ? null : config.filter}
              nested
              issues={filterIssues(step, PATH.filter, env.issues)}
              label={t('action.updateWhere')}
              emptyText={t('action.updateNoCondition')}
              ValueSource={FilterValueSource}
              onChange={(state) => {
                env.setConditionState(conditionSlot(step, PATH.filter), state);
                set({ filter: state.filter ?? {} });
              }}
            />
          </FilterScopeContext.Provider>
          <PanelField label={t('action.setValues')} step={step} path={PATH.fields} group>
            {() => (
              <FieldMapEditor
                step={step}
                path={PATH.fields}
                fields={fields}
                value={config.fields}
                scope={scope}
                issues={env.issues}
                onChange={(next) => {
                  set({ fields: next });
                }}
              />
            )}
          </PanelField>
          <PanelField
            label={t('action.limit')}
            step={step}
            path={PATH.limit}
            hint={t('action.updateLimitHint', { max: MAX_UPDATE_RECORDS_LIMIT })}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                min={1}
                max={MAX_UPDATE_RECORDS_LIMIT}
                className="w-32"
                value={String(config.limit)}
                onChange={(event) => {
                  const next = event.target.valueAsNumber;
                  if (Number.isInteger(next)) {
                    set({ limit: Math.min(MAX_UPDATE_RECORDS_LIMIT, Math.max(1, next)) });
                  }
                }}
              />
            )}
          </PanelField>
          <Note
            tone={
              count.data !== undefined && count.data.count > config.limit ? 'danger' : 'warning'
            }
            testId={COUNT_NOTE}
            title={
              count.data === undefined
                ? t('action.matchUnknown')
                : t(count.data.estimated ? 'action.matchAbout' : 'action.matchNow', {
                    count: count.data.count,
                    formatted: numbers.format(count.data.count),
                  })
            }
          >
            {count.data !== undefined && count.data.count > config.limit
              ? t('action.matchOverLimit', { limit: numbers.format(config.limit) })
              : t('action.batches', { size: numbers.format(UPDATE_RECORDS_BATCH_SIZE) })}
          </Note>
        </>
      )}
    </div>
  );
}

function unitOf(minutes: number): Unit {
  if (minutes % 1_440 === 0) return 'days';
  if (minutes % 60 === 0) return 'hours';
  return 'minutes';
}

/**
 * `delay` (SPEC §11.5, ADR-18; T506): wait a duration (1 minute – 30 days)
 * or until a date (a constant, a date field of the trigger record, trigger
 * data…), then optionally check the trigger record again — no longer
 * matching ends the run as "skipped".
 */
export function DelayPanel({ action, scope, onChange }: ActionPanelProps<'delay'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const config = action.config;
  const recheckId = useId();
  const [unit, setUnit] = useState<Unit>(() => unitOf(config.minutes ?? 60));
  const mode = config.until === null ? 'minutes' : 'until';
  const amount = (config.minutes ?? UNIT_MINUTES[unit]) / UNIT_MINUTES[unit];
  const ConditionEditor = env.ConditionEditor;
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const setMinutes = (nextAmount: number, nextUnit: Unit) => {
    const minutes = Math.round(nextAmount * UNIT_MINUTES[nextUnit]);
    set({ minutes: Math.min(MAX_DELAY_MINUTES, Math.max(MIN_DELAY_MINUTES, minutes)) });
  };
  return (
    <div className="flex flex-col gap-4">
      <PanelField label={t('delay.mode')} step={step} path={PATH.minutes} group>
        {() => (
          <Segmented
            label={t('delay.mode')}
            value={mode}
            options={MODES.map((value) => ({ value, label: t(`delay.modes.${value}`) }))}
            onChange={(next) => {
              if (next === 'minutes') set({ minutes: UNIT_MINUTES[unit], until: null });
              else set({ minutes: null, until: { literal: '' } });
            }}
          />
        )}
      </PanelField>
      {mode === 'minutes' ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              step={1}
              className="w-24"
              aria-label={t('delay.amount')}
              value={String(amount)}
              data-testid="delay-amount"
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                if (Number.isFinite(next) && next > 0) setMinutes(next, unit);
              }}
            />
            <Select
              className="w-32"
              aria-label={t('delay.unit')}
              value={unit}
              onChange={(event) => {
                const next = event.target.value as Unit;
                setUnit(next);
                setMinutes(amount, next);
              }}
            >
              {UNITS.map((value) => (
                <option key={value} value={value}>
                  {t(`trigger.unit.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-label font-normal text-fg-muted">{t('delay.hint')}</p>
        </div>
      ) : (
        <PanelField
          label={t('delay.until')}
          step={step}
          path={PATH.until}
          hint={t('delay.untilHint')}
        >
          {(control) => (
            <ValueInput
              value={
                config.until !== null && 'literal' in config.until && config.until.literal === ''
                  ? undefined
                  : (config.until ?? undefined)
              }
              onChange={(value: AutomationValue | undefined) => {
                set({ until: value ?? { literal: '' } });
              }}
              field={null}
              allowTemplate={false}
              literal={DATETIME}
              scope={scope}
              label={t('delay.until')}
              invalid={control['aria-invalid']}
              describedBy={control['aria-describedby']}
              testId={UNTIL_INPUT}
            />
          )}
        </PanelField>
      )}
      {scope.triggerTableId === null ? null : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <Switch
              id={recheckId}
              checked={config.recheck_condition !== null}
              data-testid="delay-recheck"
              onChange={(event) => {
                env.setConditionState(conditionSlot(step, PATH.recheck), null);
                set({ recheck_condition: event.target.checked ? {} : null });
              }}
            />
            <label htmlFor={recheckId} className="text-body font-medium">
              {t('delay.recheck')}
            </label>
          </div>
          {config.recheck_condition === null ? null : (
            <>
              <ConditionEditor
                key={`${scope.triggerTableId}:${String(env.resetKey)}`}
                tableId={scope.triggerTableId}
                orgId={env.orgId}
                value={
                  Object.keys(config.recheck_condition).length === 0
                    ? null
                    : config.recheck_condition
                }
                issues={filterIssues(step, PATH.recheck, env.issues)}
                label={t('delay.recheckWhere')}
                emptyText={t('delay.recheckEmpty')}
                onChange={(state) => {
                  env.setConditionState(conditionSlot(step, PATH.recheck), state);
                  set({ recheck_condition: state.filter ?? {} });
                }}
              />
              <p className="text-label font-normal text-fg-muted">{t('delay.recheckHint')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
