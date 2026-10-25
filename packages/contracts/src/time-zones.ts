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
 * aliases (`US/Eastern`, `Etc/UTC`) become their canonical zone, and the 18
 * CLDR ids below become the IANA primary name.
 */

/** CLDR canonical ids whose IANA primary name differs (CLDR `timezone.xml` `iana=`). */
const IANA_PRIMARY: Readonly<Record<string, string>> = {
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
};

/**
 * The IANA primary name of `zone` (`Asia/Saigon` → `Asia/Ho_Chi_Minh`,
 * `US/Eastern` → `America/New_York`), or `null` when the runtime does not
 * know the zone. Not a string, or empty → `null`.
 */
export function canonicalTimeZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone === '') return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return IANA_PRIMARY[resolved] ?? resolved;
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
