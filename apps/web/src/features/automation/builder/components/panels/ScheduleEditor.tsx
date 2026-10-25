import { canonicalTimeZone, canonicalTimeZones } from '@cellhive/contracts';
import { Input, Select } from '@cellhive/ui';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { zoneOffsetLabel } from '../../../list/model/cron';
import { cronOf, nextRuns, presetOf, type SchedulePreset } from '../../model/schedule';
import { useBuilderEnv } from '../env';

import { PanelField, Segmented } from './common';

import type { AutomationTrigger } from '@cellhive/contracts';

type ScheduleTrigger = Extract<AutomationTrigger, { type: 'schedule' }>;

const TRIGGER = 'trigger';
const KINDS = ['daily', 'weekly', 'monthly', 'cron'] as const;
const PATH = { cron: 'cron', timezone: 'timezone', none: '' } as const;

/** Weekdays in the order of the board (Mon … Sun), 0 = Sunday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

function clockOf(preset: SchedulePreset): string {
  if (preset.kind === 'cron') return '08:00';
  return `${String(preset.hour).padStart(2, '0')}:${String(preset.minute).padStart(2, '0')}`;
}

/** By IANA primary name, as the server stores them (`Asia/Ho_Chi_Minh`, never `Asia/Saigon`). */
function zones(): string[] {
  return canonicalTimeZones();
}

/**
 * The `schedule` trigger (SPEC §11.2; board "S5 · Automation builder -
 * trigger và điều kiện"): daily / weekly / monthly at a time, or a cron;
 * the time zone (the organization's by default); always the cron
 * expression and the next 5 runs in that zone.
 */
export function ScheduleEditor({
  trigger,
  onChange,
}: {
  readonly trigger: ScheduleTrigger;
  readonly onChange: (trigger: ScheduleTrigger) => void;
}) {
  const { t, i18n } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const preset = presetOf(trigger.cron);
  // The kind chosen stays while the cron typed does not read as it (a custom cron).
  const [mode, setMode] = useState<SchedulePreset['kind']>(preset.kind);
  const kind = mode === 'cron' ? 'cron' : preset.kind === 'cron' ? 'cron' : preset.kind;
  const zone = trigger.timezone ?? env.orgTimeZone;
  const runs = useMemo(() => nextRuns(trigger.cron, zone, new Date(), 5), [trigger.cron, zone]);
  const allZones = useMemo(() => zones(), []);
  const time = clockOf(preset);
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const set = (next: SchedulePreset) => {
    onChange({ ...trigger, cron: cronOf(next) });
  };
  const format = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: zone,
  });
  const clock = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="schedule-editor">
      <PanelField label={t('schedule.repeat')} step={TRIGGER} path={PATH.none} group>
        {() => (
          <Segmented
            label={t('schedule.repeat')}
            value={kind}
            options={KINDS.map((value) => ({
              value,
              label: t(`schedule.kind.${value}`),
            }))}
            onChange={(next) => {
              setMode(next);
              if (next === 'daily') set({ kind: 'daily', hour, minute });
              if (next === 'weekly') {
                set({
                  kind: 'weekly',
                  hour,
                  minute,
                  weekdays: preset.kind === 'weekly' ? preset.weekdays : [1],
                });
              }
              if (next === 'monthly') {
                set({
                  kind: 'monthly',
                  hour,
                  minute,
                  day: preset.kind === 'monthly' ? preset.day : 1,
                });
              }
            }}
          />
        )}
      </PanelField>
      {kind === 'weekly' && preset.kind === 'weekly' ? (
        <PanelField label={t('schedule.onDays')} step={TRIGGER} path={PATH.none} group>
          {() => (
            <div className="flex flex-wrap gap-1">
              {WEEK.map((day) => {
                const on = preset.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    className={
                      on
                        ? 'h-control min-w-9 rounded-md border border-accent bg-accent-soft px-2 text-label text-fg'
                        : 'h-control min-w-9 rounded-md border border-line-control bg-surface px-2 text-label font-normal text-fg-muted'
                    }
                    onClick={() => {
                      const next = on
                        ? preset.weekdays.filter((item) => item !== day)
                        : [...preset.weekdays, day];
                      if (next.length > 0) set({ ...preset, weekdays: next });
                    }}
                  >
                    {t(`schedule.weekday.${String(day)}` as 'schedule.weekday.1')}
                  </button>
                );
              })}
            </div>
          )}
        </PanelField>
      ) : null}
      {kind === 'monthly' && preset.kind === 'monthly' ? (
        <PanelField label={t('schedule.dayOfMonth')} step={TRIGGER} path={PATH.none}>
          {(control) => (
            <Select
              {...control}
              value={String(preset.day)}
              onChange={(event) => {
                set({ ...preset, day: Number(event.target.value) });
              }}
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>
                  {day}
                </option>
              ))}
            </Select>
          )}
        </PanelField>
      ) : null}
      {kind === 'cron' ? (
        <PanelField
          label={t('schedule.cron')}
          step={TRIGGER}
          path={PATH.cron}
          hint={t('schedule.cronHint')}
        >
          {(control) => (
            <Input
              {...control}
              value={trigger.cron}
              spellCheck={false}
              autoComplete="off"
              className="font-code"
              data-testid="schedule-cron"
              onChange={(event) => {
                onChange({ ...trigger, cron: event.target.value });
              }}
            />
          )}
        </PanelField>
      ) : (
        <PanelField label={t('schedule.time')} step={TRIGGER} path={PATH.cron}>
          {(control) => (
            <Input
              {...control}
              type="time"
              step={60}
              value={time}
              className="w-32"
              data-testid="schedule-time"
              onChange={(event) => {
                const [h, m] = event.target.value.split(':').map(Number);
                if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m))
                  return;
                if (preset.kind !== 'cron') set({ ...preset, hour: h, minute: m });
              }}
            />
          )}
        </PanelField>
      )}
      <PanelField label={t('schedule.timezone')} step={TRIGGER} path={PATH.timezone}>
        {(control) => (
          <Select
            {...control}
            value={
              trigger.timezone === null
                ? ''
                : (canonicalTimeZone(trigger.timezone) ?? trigger.timezone)
            }
            onChange={(event) => {
              onChange({
                ...trigger,
                timezone: event.target.value === '' ? null : event.target.value,
              });
            }}
          >
            <option value="">
              {t('schedule.orgZone', {
                zone: env.orgTimeZone,
                offset: zoneOffsetLabel(env.orgTimeZone) ?? '',
              })}
            </option>
            {allZones.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        )}
      </PanelField>
      {kind === 'cron' ? null : (
        <p className="text-label font-normal text-fg-muted">
          {t('schedule.expression')}{' '}
          <code className="rounded-sm bg-surface-sunken px-1 font-code text-fg">
            {trigger.cron}
          </code>
        </p>
      )}
      <section aria-labelledby="schedule-next" className="flex flex-col gap-1.5">
        <h3 id="schedule-next" className="text-label text-fg">
          {t('schedule.next')}
        </h3>
        {runs === null || runs.length === 0 ? (
          <p className="text-label font-normal text-fg-muted">{t('schedule.noNext')}</p>
        ) : (
          <ul
            className="flex flex-col rounded-md bg-surface-sunken px-3 py-1.5"
            data-testid="schedule-next"
          >
            {runs.map((run) => (
              <li
                key={run.getTime()}
                className="flex justify-between gap-3 py-0.5 text-label font-normal"
              >
                <span>{format.format(run)}</span>
                <span className="tabular-nums">{clock.format(run)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
