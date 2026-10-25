import { canonicalTimeZone } from '@cellhive/contracts';

import type { BaseAccess } from './access.service.js';
import type { Principal } from '../auth/principal.js';
import type { JsonValue } from '@cellhive/server-core';

/** A setting of a JSON `settings` object (`undefined` when absent). */
export function settingOf(settings: JsonValue, key: 'locale' | 'timezone'): unknown {
  return typeof settings === 'object' && settings !== null && !Array.isArray(settings)
    ? settings[key]
    : undefined;
}

/** An IANA zone the runtime knows. */
export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first of `zones` the runtime knows, by the IANA primary name
 * PostgreSQL knows (`Asia/Saigon`, stored before T819, → `Asia/Ho_Chi_Minh`),
 * else `fallback`.
 */
export function firstTimeZone(zones: readonly unknown[], fallback: string): string {
  for (const zone of zones) {
    const name = canonicalTimeZone(zone);
    if (name !== null) return name;
  }
  return canonicalTimeZone(fallback) ?? fallback;
}

/**
 * The zone of a principal's date operands and `cell_format=text`: the
 * user's own, else the organization's, else `fallback` (instance default).
 */
export function userTimeZone(principal: Principal, base: BaseAccess, fallback: string): string {
  return firstTimeZone(
    [principal.user.timezone, settingOf(base.org.membership.settings, 'timezone')],
    fallback,
  );
}
