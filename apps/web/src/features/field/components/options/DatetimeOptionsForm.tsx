import { canonicalTimeZone, canonicalTimeZones } from '@cellhive/contracts';
import {
  DATETIME_FORMATS,
  datetimeFieldType,
  datetimeOptionsSchema,
  isDateOnlyFormat,
  type DatetimeFormat,
  type DatetimeOptions,
  type SystemTimeOptions,
} from '@cellhive/field-types';
import { FormField, Select } from '@cellhive/ui';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** By IANA primary name, as the server stores them (`Asia/Ho_Chi_Minh`, never `Asia/Saigon`). */
function useTimeZones(): readonly string[] {
  return useMemo(() => canonicalTimeZones(), []);
}

/** "dd/MM/yyyy HH:mm · 25/09/2026 09:30": the pattern with an example. */
function formatLabel(format: DatetimeFormat, locale: string): string {
  const options = datetimeOptionsSchema.parse({ style: { format }, timezone: 'UTC' });
  const sample = isDateOnlyFormat(format) ? '2026-09-25' : '2026-09-25T09:30:00.000Z';
  const example = datetimeFieldType.formatText(sample, options, { locale, timeZone: 'UTC' });
  return `${format} · ${example}`;
}

interface FormatAndZoneProps {
  readonly format: DatetimeFormat;
  readonly timezone: string | undefined;
  readonly onChange: (format: DatetimeFormat, timezone: string | undefined) => void;
}

/** Display format and time zone (`datetime`, `created_at`, `updated_at`). */
function FormatAndZone({ format, timezone, onChange }: FormatAndZoneProps) {
  const { t, i18n } = useTranslation('field');
  const zones = useTimeZones();
  return (
    <>
      <FormField label={t('datetime.format')}>
        {(control) => (
          <Select
            {...control}
            value={format}
            onChange={(event) => {
              onChange(event.target.value as DatetimeFormat, timezone);
            }}
          >
            {DATETIME_FORMATS.map((option) => (
              <option key={option} value={option}>
                {formatLabel(option, i18n.language)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={t('datetime.timezone')} hint={t('datetime.timezoneHint')}>
        {(control) => (
          <Select
            {...control}
            value={timezone === undefined ? '' : (canonicalTimeZone(timezone) ?? timezone)}
            onChange={(event) => {
              onChange(format, event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">{t('datetime.defaultZone')}</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    </>
  );
}

/** `timezone` set, or removed (the org zone applies). */
function withZone<T extends { timezone?: string | undefined }>(
  value: T,
  timezone: string | undefined,
): T {
  const next = { ...value };
  if (timezone === undefined) delete next.timezone;
  else next.timezone = timezone;
  return next;
}

export interface DatetimeOptionsFormProps {
  readonly value: DatetimeOptions;
  readonly onChange: (value: DatetimeOptions) => void;
}

/** `datetime` options: format (date only or with time), zone, default value. */
export function DatetimeOptionsForm({ value, onChange }: DatetimeOptionsFormProps) {
  const { t } = useTranslation('field');
  const createdTime = typeof value.default_value === 'object' && value.default_value !== null;
  return (
    <>
      <FormatAndZone
        format={value.style.format}
        timezone={value.timezone}
        onChange={(format, timezone) => {
          onChange(withZone<DatetimeOptions>({ ...value, style: { format } }, timezone));
        }}
      />
      <FormField label={t('defaultValue')}>
        {(control) => (
          <Select
            {...control}
            value={createdTime ? 'created' : 'none'}
            onChange={(event) => {
              onChange({
                ...value,
                default_value:
                  event.target.value === 'created' ? { $slot: 'record_created_time' } : null,
              });
            }}
          >
            <option value="none">{t('datetime.noDefault')}</option>
            <option value="created">{t('datetime.createdTimeDefault')}</option>
          </Select>
        )}
      </FormField>
    </>
  );
}

export interface SystemTimeOptionsFormProps {
  readonly value: SystemTimeOptions;
  readonly onChange: (value: SystemTimeOptions) => void;
}

/** `created_at` / `updated_at`: display only. */
export function SystemTimeOptionsForm({ value, onChange }: SystemTimeOptionsFormProps) {
  return (
    <FormatAndZone
      format={value.style.format}
      timezone={value.timezone}
      onChange={(format, timezone) => {
        onChange(withZone<SystemTimeOptions>({ ...value, style: { format } }, timezone));
      }}
    />
  );
}
