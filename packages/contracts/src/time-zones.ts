/**
 * IANA time zone names PostgreSQL can use (T819, QA S7).
 *
 * ICU — and so Node and Chrome (`Intl.DateTimeFormat().resolvedOptions()`)
 * — canonicalizes a zone to its CLDR id, which for a few zones is the old
 * IANA name: Chrome in Vietnam reports `Asia/Saigon`, not
 * `Asia/Ho_Chi_Minh`. Those old names live only in the `backward` file of
 * tzdata, which the `postgres:18` image (Debian 13, no `tzdata-legacy`)
 * does not ship: `AT TIME ZONE 'Asia/Saigon'` fails there. Every zone
 * Cellhive stores or hands to SQL goes through {@link canonicalTimeZone}:
 * aliases (`US/Eastern`, `Etc/UTC`) become their canonical zone, and the
 * names of {@link IANA_PRIMARY} become the IANA primary name.
 *
 * A UTC offset (`+07:00`, `UTC+7`) is not a time zone here
 * ({@link isUtcOffset}): it has no daylight saving rules, and PostgreSQL
 * reads `+07:00` as a POSIX zone, whose sign counts hours west of
 * Greenwich. The fixed zones of tzdata are `Etc/GMT-14` … `Etc/GMT+12`, in
 * that POSIX sign (`Etc/GMT-7` is seven hours ahead of UTC).
 */

/**
 * Names ICU reports as canonical whose IANA primary name differs.
 *
 * - CLDR ids (CLDR `timezone.xml` `iana=`): `Asia/Saigon` → `Asia/Ho_Chi_Minh`…
 * - POSIX-style names, links of the `backward` file of tzdata **2026c** (the
 *   version of the `postgres:18` image: Debian `tzdata 2026c-0+deb13u1`;
 *   https://github.com/eggert/tz/blob/2026c/backward): `CST6CDT`, `EST5EDT`,
 *   `MST7MDT`, `PST8PDT`, `EST`, `MST`, `HST`. ICU 78.3 (Node 24.22) still
 *   reports the first four as canonical; the last three are listed for an
 *   ICU that does.
 * - The 13 `SystemV/*` names: zones of ICU only (ICU `icuzones`, from the
 *   tzdata `systemv` file removed in tzdata 2020b; `backward` has no
 *   `SystemV/` link), with the US daylight saving rules of 1976. A name
 *   whose `TZ` string has a `backward` link maps to that link's target
 *   (`SystemV/EST5EDT` → `EST5EDT` → `America/New_York`, `SystemV/EST5` →
 *   `EST` → `America/Panama`, `MST7` → `MST`, `HST10` → `HST`); the other
 *   fixed ones to the `Etc/GMT+N` zone of their offset (tzdata `etcetera`),
 *   the other two with daylight saving time to the zone of that time
 *   (`AST4ADT` Atlantic → `America/Halifax`, `YST9YDT` → `America/Anchorage`).
 */
export const IANA_PRIMARY: Readonly<Record<string, string>> = Object.freeze({
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
  // tzdata 2026c `backward`.
  CST6CDT: 'America/Chicago',
  EST5EDT: 'America/New_York',
  MST7MDT: 'America/Denver',
  PST8PDT: 'America/Los_Angeles',
  EST: 'America/Panama',
  MST: 'America/Phoenix',
  HST: 'Pacific/Honolulu',
  // ICU `icuzones` (no `backward` link of their own).
  'SystemV/AST4': 'Etc/GMT+4',
  'SystemV/AST4ADT': 'America/Halifax',
  'SystemV/CST6': 'Etc/GMT+6',
  'SystemV/CST6CDT': 'America/Chicago',
  'SystemV/EST5': 'America/Panama',
  'SystemV/EST5EDT': 'America/New_York',
  'SystemV/HST10': 'Pacific/Honolulu',
  'SystemV/MST7': 'America/Phoenix',
  'SystemV/MST7MDT': 'America/Denver',
  'SystemV/PST8': 'Etc/GMT+8',
  'SystemV/PST8PDT': 'America/Los_Angeles',
  'SystemV/YST9': 'Etc/GMT+9',
  'SystemV/YST9YDT': 'America/Anchorage',
});

/**
 * `+07:00`, `-0530`, `+7`, `+7.5`, `UTC+7`, `GMT+07:00`, `UTC −5` (U+2212),
 * any case. `Etc/GMT-7` (an IANA zone) does not match.
 */
const UTC_OFFSET = /^(?:(?:UTC|GMT|UT)\s*)?[+\-\u2212]\s*\d{1,2}(?:[:.,]?\d{1,2}){0,2}$/iu;

/** True when `zone` is a UTC offset written as a time zone (`+07:00`, `UTC+7`), which Cellhive refuses. */
export function isUtcOffset(zone: string): boolean {
  return UTC_OFFSET.test(zone.trim());
}

/** Why a value is not a time zone Cellhive accepts ({@link timeZoneProblem}). */
export type TimeZoneProblem = 'utc_offset' | 'unknown';

/**
 * `params.hint` of every `INVALID_TIME_ZONE` (CONTRACTS §1.1): what to send
 * instead. A time zone is never converted from an offset.
 */
export const TIME_ZONE_HINT =
  'Send an IANA time zone name such as Asia/Ho_Chi_Minh or UTC; UTC offsets such as +07:00 ' +
  'or UTC+7 are not accepted';

/** The message of an `INVALID_TIME_ZONE` issue. */
export function timeZoneProblemMessage(problem: TimeZoneProblem): string {
  return problem === 'utc_offset'
    ? 'A UTC offset is not a time zone: use an IANA time zone name such as Asia/Ho_Chi_Minh'
    : 'Must be an IANA time zone';
}

/** The zone ICU resolves `zone` to, `null` when it does not know it or it is an offset. */
function resolve(zone: string): string | null {
  if (zone === '' || isUtcOffset(zone)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // ICU writes every offset it accepts as `±HH:MM`.
  return isUtcOffset(resolved) ? null : resolved;
}

/**
 * The IANA primary name of `zone` (`Asia/Saigon` → `Asia/Ho_Chi_Minh`,
 * `US/Eastern` and `EST5EDT` → `America/New_York`), or `null` when the
 * runtime does not know the zone or it is a UTC offset ({@link isUtcOffset}).
 * Not a string, or empty → `null`.
 */
export function canonicalTimeZone(zone: unknown): string | null {
  if (typeof zone !== 'string') return null;
  const resolved = resolve(zone);
  return resolved === null ? null : (IANA_PRIMARY[resolved] ?? resolved);
}

/**
 * `null` when `zone` is a time zone Cellhive accepts, else why not: a UTC
 * offset, or a name the runtime does not know (not a string included).
 * The one check behind `timeZoneSchema`, the date field's `options.timezone`
 * (`isValidTimeZone` of `@cellhive/field-types`) and the `schedule` trigger.
 */
export function timeZoneProblem(zone: unknown): TimeZoneProblem | null {
  if (typeof zone === 'string' && isUtcOffset(zone)) return 'utc_offset';
  return canonicalTimeZone(zone) === null ? 'unknown' : null;
}

/** Every zone of the runtime once, by IANA primary name, sorted (time zone pickers). */
export function canonicalTimeZones(): string[] {
  let zones: readonly string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const zone of zones) {
    const name = canonicalTimeZone(zone);
    if (name !== null) names.add(name);
  }
  return [...names].sort();
}
