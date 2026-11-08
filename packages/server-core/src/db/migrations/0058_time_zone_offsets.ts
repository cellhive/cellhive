import { sql, type Kysely } from 'kysely';

/**
 * Migration 0058 (BACKLOG T1005; CONTRACTS §1.1, §13, §21): stored time
 * zones are IANA names PostgreSQL knows, never a UTC offset.
 *
 * Rewritten, in `meta.users.timezone`, `timezone` of
 * `meta.organizations.settings` and `meta.bases.settings`,
 * `options.timezone` of `meta.fields` (date fields) and `trigger.timezone`
 * of `meta.automations.definition` (`schedule`), deleted rows included:
 *
 * - a legacy name becomes its IANA primary name (`EST5EDT` →
 *   `America/New_York`, `SystemV/AST4` → `Etc/GMT+4`; {@link LEGACY_NAMES},
 *   names matched case-insensitively);
 * - a whole-hour UTC offset (`+07:00`, `+0700`, `+07`, `-05:00`, `UTC+7`,
 *   with U+2212 MINUS SIGN too) becomes the fixed zone of that offset, whose
 *   name has the POSIX sign: `+07:00` → `Etc/GMT-7` ({@link WHOLE_HOURS},
 *   `+00:00` → `UTC`);
 * - any other offset (`+05:30`, `-13:00`) is reset: a user gets no zone of
 *   their own (`NULL`: the organization's), everywhere else `UTC`. Only the
 *   count of reset values goes to the PostgreSQL log (`WARNING`), never a
 *   value.
 *
 * Other names are left as they are (0055 rewrote the aliases). Cell values
 * do not change; nothing is recomputed. Running the statement again changes
 * no row.
 *
 * The tables are data, not `Intl`, so the result does not depend on the
 * ICU of the process that runs it: the names are those `IANA_PRIMARY`
 * (`@cellhive/contracts`) adds on 2026-11-08 — tzdata 2026c `backward` (the
 * tzdata of `postgres:18`) for the POSIX-style names, ICU `icuzones` for
 * the `SystemV/*` ones — and every target is a zone of tzdata 2026c.
 *
 * Self-contained (only `meta.*` tables of 0001/0003/0027), so its number
 * can change at merge. This file is locked by `migrations.lock.json`: never
 * edit it once merged.
 */

/** Legacy name → IANA primary name (`IANA_PRIMARY` of `@cellhive/contracts`). */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
  CST6CDT: 'America/Chicago',
  EST5EDT: 'America/New_York',
  MST7MDT: 'America/Denver',
  PST8PDT: 'America/Los_Angeles',
  EST: 'America/Panama',
  MST: 'America/Phoenix',
  HST: 'Pacific/Honolulu',
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
};

/**
 * `±HH:MM` → the tzdata zone of that whole-hour offset (`etcetera`:
 * `Etc/GMT-14` … `Etc/GMT+12`, POSIX sign — `Etc/GMT-7` is UTC+7).
 */
const WHOLE_HOURS: Readonly<Record<string, string>> = {
  '+14:00': 'Etc/GMT-14',
  '+13:00': 'Etc/GMT-13',
  '+12:00': 'Etc/GMT-12',
  '+11:00': 'Etc/GMT-11',
  '+10:00': 'Etc/GMT-10',
  '+09:00': 'Etc/GMT-9',
  '+08:00': 'Etc/GMT-8',
  '+07:00': 'Etc/GMT-7',
  '+06:00': 'Etc/GMT-6',
  '+05:00': 'Etc/GMT-5',
  '+04:00': 'Etc/GMT-4',
  '+03:00': 'Etc/GMT-3',
  '+02:00': 'Etc/GMT-2',
  '+01:00': 'Etc/GMT-1',
  '+00:00': 'UTC',
  '-00:00': 'UTC',
  '-01:00': 'Etc/GMT+1',
  '-02:00': 'Etc/GMT+2',
  '-03:00': 'Etc/GMT+3',
  '-04:00': 'Etc/GMT+4',
  '-05:00': 'Etc/GMT+5',
  '-06:00': 'Etc/GMT+6',
  '-07:00': 'Etc/GMT+7',
  '-08:00': 'Etc/GMT+8',
  '-09:00': 'Etc/GMT+9',
  '-10:00': 'Etc/GMT+10',
  '-11:00': 'Etc/GMT+11',
  '-12:00': 'Etc/GMT+12',
};

/**
 * One statement; a DO block takes no parameters, so the tables come in
 * transaction-local settings (the migrator runs every migration in one
 * transaction). `targets`: stored value → its new value, `''` = reset.
 */
const REWRITE = `DO $$
DECLARE
  legacy jsonb := (
    SELECT jsonb_object_agg(lower(key), value)
      FROM jsonb_each_text(current_setting('cellhive.legacy_time_zones')::jsonb)
  );
  hours jsonb := current_setting('cellhive.whole_hour_offsets')::jsonb;
  targets jsonb;
  reset_count bigint;
BEGIN
  WITH stored AS (
    SELECT timezone AS zone FROM meta.users WHERE timezone IS NOT NULL
    UNION
    SELECT settings ->> 'timezone' FROM meta.organizations
     WHERE jsonb_typeof(settings -> 'timezone') = 'string'
    UNION
    SELECT settings ->> 'timezone' FROM meta.bases
     WHERE jsonb_typeof(settings -> 'timezone') = 'string'
    UNION
    SELECT options ->> 'timezone' FROM meta.fields
     WHERE jsonb_typeof(options -> 'timezone') = 'string'
    UNION
    SELECT definition #>> '{trigger,timezone}' FROM meta.automations
     WHERE jsonb_typeof(definition #> '{trigger,timezone}') = 'string'
  ), parsed AS (
    SELECT zone,
           legacy ->> lower(zone) AS primary_name,
           -- [1] sign, [2] hours, [3] minutes: '+07:00', '-0530', '+7', 'UTC+7', 'GMT -05'.
           regexp_match(
             translate(zone, U&'\\2212', '-'),
             '^\\s*(?:utc|gmt|ut)?\\s*([+-])\\s*([0-9]{1,2})(?::?([0-9]{2}))?\\s*$',
             'i'
           ) AS offset_parts
      FROM stored
  )
  SELECT coalesce(jsonb_object_agg(
           zone,
           coalesce(
             primary_name,
             hours ->> (offset_parts[1] || lpad(offset_parts[2], 2, '0') || ':'
                        || coalesce(offset_parts[3], '00')),
             ''
           )
         ), '{}'::jsonb)
    INTO targets
    FROM parsed
   WHERE primary_name IS NOT NULL OR offset_parts IS NOT NULL;

  SELECT count(*) INTO reset_count
    FROM (
      SELECT timezone AS zone FROM meta.users
      UNION ALL
      SELECT settings ->> 'timezone' FROM meta.organizations
       WHERE jsonb_typeof(settings -> 'timezone') = 'string'
      UNION ALL
      SELECT settings ->> 'timezone' FROM meta.bases
       WHERE jsonb_typeof(settings -> 'timezone') = 'string'
      UNION ALL
      SELECT options ->> 'timezone' FROM meta.fields
       WHERE jsonb_typeof(options -> 'timezone') = 'string'
      UNION ALL
      SELECT definition #>> '{trigger,timezone}' FROM meta.automations
       WHERE jsonb_typeof(definition #> '{trigger,timezone}') = 'string'
    ) AS all_stored
   WHERE targets ->> zone = '';

  -- A user without a zone of their own uses the organization's.
  UPDATE meta.users SET timezone = nullif(targets ->> timezone, '')
   WHERE targets ? timezone;

  UPDATE meta.organizations
     SET settings = jsonb_set(settings, '{timezone}',
                              to_jsonb(coalesce(nullif(targets ->> (settings ->> 'timezone'), ''), 'UTC')))
   WHERE jsonb_typeof(settings -> 'timezone') = 'string'
     AND targets ? (settings ->> 'timezone');

  UPDATE meta.bases
     SET settings = jsonb_set(settings, '{timezone}',
                              to_jsonb(coalesce(nullif(targets ->> (settings ->> 'timezone'), ''), 'UTC')))
   WHERE jsonb_typeof(settings -> 'timezone') = 'string'
     AND targets ? (settings ->> 'timezone');

  UPDATE meta.fields
     SET options = jsonb_set(options, '{timezone}',
                             to_jsonb(coalesce(nullif(targets ->> (options ->> 'timezone'), ''), 'UTC')))
   WHERE jsonb_typeof(options -> 'timezone') = 'string'
     AND targets ? (options ->> 'timezone');

  -- Only the schedule trigger has a zone.
  UPDATE meta.automations
     SET definition = jsonb_set(definition, '{trigger,timezone}',
                                to_jsonb(coalesce(nullif(targets ->> (definition #>> '{trigger,timezone}'), ''), 'UTC')))
   WHERE jsonb_typeof(definition #> '{trigger,timezone}') = 'string'
     AND targets ? (definition #>> '{trigger,timezone}');

  IF reset_count > 0 THEN
    RAISE WARNING 'migration 0058_time_zone_offsets: % stored UTC offset(s) without a whole-hour time zone were reset (users: to the organization zone; elsewhere: to UTC)', reset_count;
  END IF;
END
$$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  const legacy = JSON.stringify(LEGACY_NAMES);
  const hours = JSON.stringify(WHOLE_HOURS);
  await sql`
    SELECT set_config('cellhive.legacy_time_zones', ${legacy}, true),
           set_config('cellhive.whole_hour_offsets', ${hours}, true)
  `.execute(db);
  // Static SQL: no value in this statement comes from input.
  await sql.raw(REWRITE).execute(db);
}
