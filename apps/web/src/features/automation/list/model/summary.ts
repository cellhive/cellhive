import { formatClock, readCron, weekdayName, zoneOffsetLabel } from './cron';

import type { AutomationDto, AutomationTrigger } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/**
 * Names the list resolves from the schema the caller reads (tables, fields,
 * views); `undefined` when not known (not loaded yet, deleted, or not
 * readable — then a neutral word is shown, never an id).
 */
export interface SchemaNames {
  table: (tableId: string) => string | undefined;
  field: (tableId: string, fieldId: string) => string | undefined;
  view: (viewId: string) => string | undefined;
  /** (T612) Name of an incoming webhook (`webhook.received`); absent when not readable. */
  hook?: ((hookId: string) => string | undefined) | undefined;
}

export interface TriggerSummary {
  /** "When a record is updated". */
  readonly label: string;
  /** "Tickets · watching Priority"; `null` when there is nothing more to say. */
  readonly detail: string | null;
}

/** Table of a trigger (`form.submitted` and `schedule` have none). */
export function triggerTableId(trigger: AutomationTrigger): string | null {
  return 'table_id' in trigger ? trigger.table_id : null;
}

/** Most watched fields named before "+N". */
const WATCHED_SHOWN = 2;

/** "7 days before", "2 hours after", "on" (offset 0) — of `record.date_reached`. */
function offsetText(t: TFunction<'automation'>, minutes: number): string {
  if (minutes === 0) return t('trigger.offset.on');
  const amount = Math.abs(minutes);
  const direction = minutes < 0 ? 'before' : 'after';
  if (amount % 1440 === 0) return t(`trigger.offset.days_${direction}`, { count: amount / 1440 });
  if (amount % 60 === 0) return t(`trigger.offset.hours_${direction}`, { count: amount / 60 });
  return t(`trigger.offset.minutes_${direction}`, { count: amount });
}

function scheduleText(
  t: TFunction<'automation'>,
  locale: string,
  cron: string,
  timeZone: string | null,
): string {
  const reading = readCron(cron);
  let text: string;
  switch (reading.kind) {
    case 'minutes':
      text = t('trigger.cron.minutes', { count: reading.every });
      break;
    case 'hourly':
      text = t('trigger.cron.hourly', { minute: String(reading.minute).padStart(2, '0') });
      break;
    case 'daily':
      text = t('trigger.cron.daily', { time: formatClock(locale, reading.hour, reading.minute) });
      break;
    case 'weekdays':
      text = t('trigger.cron.weekdays', {
        time: formatClock(locale, reading.hour, reading.minute),
      });
      break;
    case 'weekly':
      text = t('trigger.cron.weekly', {
        day: weekdayName(locale, reading.weekday),
        time: formatClock(locale, reading.hour, reading.minute),
      });
      break;
    case 'monthly':
      text = t('trigger.cron.monthly', {
        day: reading.day,
        time: formatClock(locale, reading.hour, reading.minute),
      });
      break;
    case 'raw':
      text = t('trigger.cron.raw', { cron: reading.cron });
      break;
  }
  const zone = timeZone === null ? t('trigger.cron.orgZone') : zoneOffsetLabel(timeZone);
  return zone === null ? text : `${text} (${zone})`;
}

/**
 * One line about what starts an automation (board "S5 · Automation list":
 * "When a record is updated · Tickets · watching Priority"). Pure apart from
 * the translations; the condition of `record.matches` is not spelt out here
 * (that is the builder's, T521).
 */
export function summarizeTrigger(
  automation: Pick<AutomationDto, 'definition'>,
  names: SchemaNames,
  t: TFunction<'automation'>,
  locale: string,
): TriggerSummary {
  const trigger = automation.definition.trigger;
  const label = t(`trigger.type.${trigger.type}`);
  const table = (tableId: string) => names.table(tableId) ?? t('trigger.unknownTable');
  const field = (tableId: string, fieldId: string) =>
    names.field(tableId, fieldId) ?? t('trigger.unknownField');
  const join = (...parts: readonly string[]) => parts.join(' · ');
  switch (trigger.type) {
    case 'record.created':
    case 'record.deleted':
    case 'record.matches':
      return { label, detail: table(trigger.table_id) };
    case 'record.updated': {
      const watched = trigger.watch_fields
        .slice(0, WATCHED_SHOWN)
        .map((fieldId) => field(trigger.table_id, fieldId));
      const more = trigger.watch_fields.length - watched.length;
      const list =
        more > 0
          ? t('trigger.watchingMore', { fields: watched.join(', '), count: more })
          : t('trigger.watching', { fields: watched.join(', ') });
      return { label, detail: join(table(trigger.table_id), list) };
    }
    case 'form.submitted':
      return { label, detail: names.view(trigger.view_id) ?? t('trigger.unknownForm') };
    case 'schedule':
      return { label, detail: scheduleText(t, locale, trigger.cron, trigger.timezone) };
    case 'webhook.received':
      // (T612) The hook by name; base admins only read hooks (and only they manage these).
      return { label, detail: names.hook?.(trigger.incoming_webhook_id) ?? null };
    case 'record.date_reached': {
      const when = t('trigger.dateReached', {
        offset: offsetText(t, trigger.offset_minutes),
        field: field(trigger.table_id, trigger.field_id),
      });
      const time =
        trigger.time_of_day === null
          ? when
          : `${when}, ${formatClock(
              locale,
              Number(trigger.time_of_day.slice(0, 2)),
              Number(trigger.time_of_day.slice(3, 5)),
            )}`;
      return { label, detail: join(table(trigger.table_id), time) };
    }
    case 'button.clicked':
      return {
        label,
        detail: join(
          table(trigger.table_id),
          t('trigger.button', { field: field(trigger.table_id, trigger.field_id) }),
          t(`trigger.minPermission.${trigger.min_permission}`),
        ),
      };
  }
}
