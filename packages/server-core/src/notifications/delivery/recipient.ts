import type { Organization, User } from '../../db/schema.js';
import type { AccessDefaults } from '../../import/member-access.js';
import type { NotificationPreferenceRow } from '../notification-preferences.repository.js';
import type { NotificationChannel, NotificationType } from '@cellhive/contracts';

/** A stored preference of one type and channel, or `undefined` (the type default applies). */
export function preferenceOf(
  rows: readonly NotificationPreferenceRow[],
  type: NotificationType,
  channel: NotificationChannel,
): boolean | undefined {
  return rows.find((row) => row.type === type && row.channel === channel)?.enabled;
}

function settingOf(organization: Organization, key: 'locale' | 'timezone'): unknown {
  const settings = organization.settings;
  return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
    ? settings[key]
    : undefined;
}

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The recipient's time zone (CONTRACTS §22.3: `users.timezone`, then the
 * organization's, then `DEFAULT_TIMEZONE`).
 */
export function timeZoneOf(
  user: Pick<User, 'timezone'>,
  organization: Organization | undefined,
  defaults: AccessDefaults,
): string {
  return (
    [
      user.timezone,
      organization === undefined ? undefined : settingOf(organization, 'timezone'),
    ].find(isTimeZone) ?? defaults.timeZone
  );
}

/** The recipient's language: `users.locale`, then the organization's, then `DEFAULT_LOCALE`. */
export function localeOf(
  user: Pick<User, 'locale'>,
  organization: Organization | undefined,
  defaults: AccessDefaults,
): string {
  const isLocale = (value: unknown): value is string => typeof value === 'string' && value !== '';
  return (
    [user.locale, organization === undefined ? undefined : settingOf(organization, 'locale')].find(
      isLocale,
    ) ?? defaults.locale
  );
}

/** The hour (0–23) of `at` on the wall clock of `timeZone`. */
export function localHourOf(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(at)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour ?? '0') % 24;
}
