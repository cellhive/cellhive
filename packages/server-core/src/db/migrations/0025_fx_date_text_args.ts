import { sql, type Kysely } from 'kysely';

/**
 * Migration 0025 (QA S4b M4): a text at a date/datetime parameter of a
 * formula is read with the `TODATE` rule, as in Lark — `DAY("2000-01-03")`,
 * `DATEDIF("2000-01-01", "2000-01-08", "D")`, `HOUR("11:40:59")` and
 * `TEXT("2021-01-01", "ddd")` (SPEC §9.2, §9.4). The typecheck lets text
 * through, and both backends coerce it:
 *
 * - `fx.date_text_arg(t, tz)`: the local date of `fx.todate(t, tz)` — the
 *   same rule as `TODATE`, `NULL` for anything else. The day-based date
 *   functions wrap a text argument with it (`fx.day`, `fx.weekday`,
 *   `fx.datedif`, `fx.eomonth`, `fx.workday`, `fx.networkdays`).
 * - `fx.wall_time(t, tz)`: the instant of the `TODATE` rule, or of a bare
 *   wall-clock time `H:mm[:ss]` read at 1970-01-01 (Lark's
 *   `HOUR("11:40:59")`). The wall-clock reading functions wrap a text
 *   argument with it (`fx.hour`, `fx.minute`, `fx.second`).
 * - `fx.text_text(v, fmt, tz)`: `TEXT` with a text value — a date-token
 *   pattern (holding a `Y M D H S` letter after the `C`-collation upper)
 *   formats the parsed text, anything else passes the text through. The TS
 *   evaluator answers with `hasDateToken` (`evaluate/text-format.ts`).
 *
 * Like 0021/0023: every function is `IMMUTABLE PARALLEL SAFE STRICT`, never
 * reads `TimeZone`, `lc_*` or `DateStyle`, and is self-contained so the
 * number can change at merge. Forward-only: `CREATE OR REPLACE`, no `down`.
 */

const STRICT = 'IMMUTABLE PARALLEL SAFE STRICT';

const FUNCTIONS = [
  // A text date argument: the local date of the TODATE rule (fx.todate, 0021).
  `CREATE OR REPLACE FUNCTION fx.date_text_arg(t text, tz text) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT fx.local_date(fx.todate(t, tz), tz)
   $$`,
  // A text wall-clock argument: the TODATE rule, or a bare H:mm[:ss] at
  // 1970-01-01 (a date-shaped text without a time reads as its local midnight,
  // so HOUR("2000-01-01") is 0 — as HOUR(DATE(2000, 1, 1)) is).
  `CREATE OR REPLACE FUNCTION fx.wall_time(t text, tz text) RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT coalesce(
       fx.todate(t, tz),
       (SELECT fx.make_local(1970, 1, 1, m[1]::integer, m[2]::integer, coalesce(m[3], '0')::integer, tz)
          FROM (SELECT regexp_match(btrim(t), '^ *([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))? *$') AS m) AS p
         -- Out of range like the TS parseWallClock: hour > 23, minute or second > 59 → NULL.
         WHERE m[1]::integer <= 23 AND m[2]::integer <= 59 AND coalesce(m[3], '0')::integer <= 59)
     )
   $$`,
  // Whether a TEXT pattern formats a date or time: it holds a Y, M, D, H or S
  // letter (the first letters of the tokens of fx.text_date, 0023) after the
  // C-collation upper — what the TS evaluator's `hasDateToken` mirrors.
  `CREATE OR REPLACE FUNCTION fx.text_text(v text, fmt text, tz text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     BEGIN
       IF regexp_match(upper(fmt COLLATE "C"), '[YMDHS]') IS NOT NULL THEN
         -- The wall clock in the zone (a timestamptz cast would use the session TimeZone).
         RETURN fx.text_date(fx.local(fx.wall_time(v, tz), tz), fmt);
       END IF;
       RETURN v;
     END
   $$`,
];

/** Applies `CREATE OR REPLACE` of every function above. */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of FUNCTIONS) {
    await sql.raw(statement).execute(db);
  }
}

/** Forward-only: nothing to undo. */
export async function down(): Promise<void> {}
