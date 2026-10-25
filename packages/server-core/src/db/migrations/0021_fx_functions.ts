import { sql, type Kysely } from 'kysely';

/**
 * Migration 0021 (BACKLOG T454): the `fx.*` SQL functions of the formula
 * compiler (SPEC §9.4, ADR-21). Schema `fx` exists since 0001.
 *
 * Every function is `IMMUTABLE PARALLEL SAFE` and really is: it never reads
 * the session `TimeZone`, `lc_*` or `DateStyle`. Calendar functions take the
 * IANA time zone as a parameter (`ts AT TIME ZONE tz`, immutable for an
 * explicit zone), dates and numbers are turned into text digit by digit
 * (`numeric` output and `int::text` do not depend on settings; `to_char`,
 * `date::text` and `timestamptz::date` are never used).
 *
 * Operations that can fail on a row's data return `NULL` instead of raising
 * (SPEC §9.4: one bad row must not fail a whole `SELECT`/`UPDATE`): inputs are
 * checked before the operation (division by zero, square root of a negative,
 * out-of-range dates, oversized powers); only the regular expression
 * functions trap errors (`EXCEPTION` block — a subtransaction for error
 * recovery is allowed in parallel-safe functions).
 *
 * Integer arguments (digits, counts, positions, months…) are truncated toward
 * zero and clamped to the `int` range by `fx.int_arg`, so no cast can overflow.
 *
 * Self-contained: no function or table of a later migration is used, so its
 * number can change at merge. This file is locked by `migrations.lock.json`:
 * never edit it once merged — replace functions in a new migration.
 */

const PURE = 'IMMUTABLE PARALLEL SAFE';
const STRICT = 'IMMUTABLE PARALLEL SAFE STRICT';

const NUMBERS = [
  // Integer argument: truncated toward zero, clamped to ±2147483647.
  `CREATE FUNCTION fx.int_arg(x numeric) RETURNS integer LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN x >= 2147483647 THEN 2147483647
                 WHEN x <= -2147483647 THEN -2147483647
                 ELSE trunc(x)::integer END
   $$`,
  // Canonical text of a number: no trailing zeros, never an exponent.
  `CREATE FUNCTION fx.num_text(x numeric) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT trim_scale(x)::text
   $$`,
  `CREATE FUNCTION fx.div(a numeric, b numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN b = 0 THEN NULL ELSE a / b END
   $$`,
  // MOD/%: the remainder has the sign of the divisor (like Excel and Lark).
  `CREATE FUNCTION fx.mod(a numeric, b numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN b = 0 THEN NULL
                 WHEN mod(a, b) <> 0 AND sign(mod(a, b)) <> sign(b) THEN mod(a, b) + b
                 ELSE mod(a, b) END
   $$`,
  `CREATE FUNCTION fx.quotient(a numeric, b numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN b = 0 THEN NULL ELSE div(a, b) END
   $$`,
  `CREATE FUNCTION fx.digits(d numeric) RETURNS integer LANGUAGE sql ${STRICT} AS $$
     SELECT greatest(-1000, least(1000, fx.int_arg(d)))
   $$`,
  // ROUND: halves away from zero (numeric round).
  `CREATE FUNCTION fx.round(x numeric, d numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT round(x, fx.digits(d))
   $$`,
  `CREATE FUNCTION fx.rounddown(x numeric, d numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT trunc(x, fx.digits(d))
   $$`,
  `CREATE FUNCTION fx.roundup(x numeric, d numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN trunc(x, fx.digits(d)) = x THEN trunc(x, fx.digits(d))
                 ELSE trunc(x, fx.digits(d)) + sign(x) * power(10::numeric, -fx.digits(d)) END
   $$`,
  // FLOOR/CEILING to a multiple of |factor|; factor 0 → NULL.
  `CREATE FUNCTION fx.floor(x numeric, f numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN f = 0 THEN NULL ELSE floor(x / abs(f)) * abs(f) END
   $$`,
  `CREATE FUNCTION fx.ceiling(x numeric, f numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN f = 0 THEN NULL ELSE ceil(x / abs(f)) * abs(f) END
   $$`,
  // POWER: NULL for 0^negative, negative^fraction and results beyond 10^±1000.
  `CREATE FUNCTION fx.power(b numeric, e numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN b = 0 AND e < 0 THEN NULL
                 WHEN b = 0 THEN CASE WHEN e = 0 THEN 1::numeric ELSE 0::numeric END
                 WHEN b < 0 AND e <> trunc(e) THEN NULL
                 WHEN abs(e * log(abs(b))) > 1000 THEN NULL
                 ELSE power(b, e) END
   $$`,
  `CREATE FUNCTION fx.sqrt(x numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN x < 0 THEN NULL ELSE sqrt(x) END
   $$`,
  // EXP: NULL beyond e^2302 (≈ 10^1000); tiny results are 0.
  `CREATE FUNCTION fx.exp(x numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN x > 2302 THEN NULL WHEN x < -2302 THEN 0::numeric ELSE exp(x) END
   $$`,
  `CREATE FUNCTION fx.ln(x numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN x <= 0 THEN NULL ELSE ln(x) END
   $$`,
  `CREATE FUNCTION fx.log(x numeric, b numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN x <= 0 OR b <= 0 OR b = 1 THEN NULL ELSE log(b, x) END
   $$`,
  `CREATE FUNCTION fx.pi() RETURNS numeric LANGUAGE sql ${PURE} AS $$
     SELECT 3.14159265358979323846264338327950288419716939937510::numeric
   $$`,
  // VALUE: a plain decimal (sign, digits, one point, exponent of 1-3 digits), spaces around.
  `CREATE FUNCTION fx.value(t text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN t ~ '^[ \\t\\n\\r]*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]{1,3})?[ \\t\\n\\r]*$'
                 THEN btrim(t, E' \\t\\n\\r')::numeric END
   $$`,
  // Aggregates over a list (NULL elements skipped).
  `CREATE FUNCTION fx.median(a numeric[]) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN n = 0 THEN NULL
                 WHEN n % 2 = 1 THEN s[n / 2 + 1]
                 ELSE (s[n / 2] + s[n / 2 + 1]) / 2 END
       FROM (SELECT coalesce(array_agg(v ORDER BY v), '{}') AS s, count(v)::integer AS n
               FROM unnest(a) AS u(v) WHERE v IS NOT NULL) AS sorted
   $$`,
  `CREATE FUNCTION fx.stdev(a numeric[]) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT stddev_samp(v) FROM unnest(a) AS u(v)
   $$`,
  // PRODUCT of no number is 0 (like Excel/Lark PRODUCT of an empty range).
  `CREATE FUNCTION fx.product(a numeric[]) RETURNS numeric LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       acc numeric := NULL;
       v numeric;
     BEGIN
       FOREACH v IN ARRAY a LOOP
         IF v IS NOT NULL THEN
           acc := coalesce(acc, 1) * v;
           IF abs(acc) >= 1e1000 THEN RETURN NULL; END IF;
         END IF;
       END LOOP;
       RETURN coalesce(acc, 0);
     END
   $$`,
  `CREATE FUNCTION fx.large(a numeric[], k numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN fx.int_arg(k) < 1 THEN NULL ELSE (
       SELECT v FROM unnest(a) AS u(v) WHERE v IS NOT NULL
        ORDER BY v DESC OFFSET fx.int_arg(k) - 1 LIMIT 1) END
   $$`,
  `CREATE FUNCTION fx.small(a numeric[], k numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN fx.int_arg(k) < 1 THEN NULL ELSE (
       SELECT v FROM unnest(a) AS u(v) WHERE v IS NOT NULL
        ORDER BY v ASC OFFSET fx.int_arg(k) - 1 LIMIT 1) END
   $$`,
  // RANK: 1 for the largest (smallest when ascending); -1 when the value is not in the list.
  `CREATE FUNCTION fx.rank(x numeric, a numeric[], ascending boolean) RETURNS numeric LANGUAGE sql ${PURE} AS $$
     SELECT CASE WHEN x IS NULL OR a IS NULL THEN NULL
                 WHEN NOT coalesce(x = ANY (a), false) THEN -1::numeric
                 ELSE 1 + (SELECT count(*) FROM unnest(a) AS u(v)
                            WHERE CASE WHEN coalesce(ascending, false) THEN v < x ELSE v > x END) END
   $$`,
];

const DATES = [
  // Wall-clock time of an instant in an explicit zone.
  `CREATE FUNCTION fx.local(ts timestamptz, tz text) RETURNS timestamp LANGUAGE sql ${STRICT} AS $$
     SELECT ts AT TIME ZONE tz
   $$`,
  `CREATE FUNCTION fx.local_date(ts timestamptz, tz text) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT (ts AT TIME ZONE tz)::date
   $$`,
  // Midnight of a calendar day in an explicit zone.
  `CREATE FUNCTION fx.date_to_ts(d date, tz text) RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT d::timestamp AT TIME ZONE tz
   $$`,
  // Dates the functions accept: years 1–9999 (no BC, no infinity).
  `CREATE FUNCTION fx.date_ok(d date) RETURNS boolean LANGUAGE sql ${STRICT} AS $$
     SELECT d >= DATE '0001-01-01' AND d <= DATE '9999-12-31'
   $$`,
  `CREATE FUNCTION fx.ts_ok(ts timestamptz) RETURNS boolean LANGUAGE sql ${STRICT} AS $$
     SELECT ts >= TIMESTAMPTZ '0001-01-02 00:00:00+00' AND ts <= TIMESTAMPTZ '9999-12-30 00:00:00+00'
   $$`,
  // Wall-clock parts → instant; NULL for an impossible date or time.
  `CREATE FUNCTION fx.make_local(y integer, mo integer, d integer, h integer, mi integer, s integer, tz text)
     RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN y < 1 OR y > 9999 OR mo < 1 OR mo > 12 OR d < 1 OR h > 23 OR mi > 59 OR s > 59
                   OR h < 0 OR mi < 0 OR s < 0 THEN NULL
                 WHEN d > extract(day FROM (make_date(y, mo, 1) + interval '1 month - 1 day')) THEN NULL
                 ELSE make_timestamp(y, mo, d, h, mi, s) AT TIME ZONE tz END
   $$`,
  // DATE(y, m, d): months and days roll over (DATE(2000, 13, 1) = 2001-01-01).
  `CREATE FUNCTION fx.date(y numeric, m numeric, d numeric) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN fx.int_arg(y) < 1 OR fx.int_arg(y) > 9999
                   OR abs(fx.int_arg(m)) > 120000 OR abs(fx.int_arg(d)) > 1000000
                   OR fx.int_arg(y)::bigint * 12 + fx.int_arg(m) - 1 NOT BETWEEN 12 AND 119999 THEN NULL
                 ELSE (make_date(fx.int_arg(y), 1, 1) + make_interval(months => fx.int_arg(m) - 1))::date
                      + (fx.int_arg(d) - 1) END
   $$`,
  // date ± days: whole days (the fraction is dropped toward minus infinity).
  `CREATE FUNCTION fx.date_add(d date, n numeric) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN NOT fx.date_ok(d) OR abs(n) > 1000000 THEN NULL
                 ELSE d + floor(n)::integer END
   $$`,
  // datetime ± days: exact 86 400-second days (microsecond precision), whatever the zone.
  `CREATE FUNCTION fx.ts_add(ts timestamptz, n numeric) RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN NOT fx.ts_ok(ts) OR abs(n) > 1000000 THEN NULL
                 ELSE ts + make_interval(secs => round(n * 86400, 6)::double precision) END
   $$`,
  `CREATE FUNCTION fx.ts_diff_days(a timestamptz, b timestamptz) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(epoch FROM (a - b)) / 86400
   $$`,
  `CREATE FUNCTION fx.year(d date) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(year FROM d)
   $$`,
  `CREATE FUNCTION fx.year(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(year FROM ts AT TIME ZONE tz)
   $$`,
  `CREATE FUNCTION fx.month(d date) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(month FROM d)
   $$`,
  `CREATE FUNCTION fx.month(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(month FROM ts AT TIME ZONE tz)
   $$`,
  `CREATE FUNCTION fx.day(d date) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(day FROM d)
   $$`,
  `CREATE FUNCTION fx.day(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(day FROM ts AT TIME ZONE tz)
   $$`,
  `CREATE FUNCTION fx.hour(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(hour FROM ts AT TIME ZONE tz)
   $$`,
  `CREATE FUNCTION fx.minute(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT extract(minute FROM ts AT TIME ZONE tz)
   $$`,
  `CREATE FUNCTION fx.second(ts timestamptz, tz text) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT floor(extract(second FROM ts AT TIME ZONE tz))
   $$`,
  // WEEKDAY: type 1 Sunday = 1 … Saturday = 7; type 2 Monday = 1 … Sunday = 7.
  `CREATE FUNCTION fx.weekday(d date, kind numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE fx.int_arg(kind) WHEN 1 THEN extract(dow FROM d) + 1
                                  WHEN 2 THEN extract(isodow FROM d) END
   $$`,
  // WEEKNUM: the week holding January 1 is week 1; weeks start Sunday (1) or Monday (2).
  `CREATE FUNCTION fx.weeknum(d date, kind numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE fx.int_arg(kind)
              WHEN 1 THEN floor((extract(doy FROM d) - 1
                                 + extract(dow FROM make_date(extract(year FROM d)::integer, 1, 1))) / 7) + 1
              WHEN 2 THEN floor((extract(doy FROM d) - 1
                                 + extract(isodow FROM make_date(extract(year FROM d)::integer, 1, 1)) - 1) / 7) + 1
            END
   $$`,
  // EDATE: same day n months later, clamped to the end of the month.
  `CREATE FUNCTION fx.edate(d date, n numeric) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN NOT fx.date_ok(d) OR abs(fx.int_arg(n)) > 12000 THEN NULL
                 ELSE (d + make_interval(months => fx.int_arg(n)))::date END
   $$`,
  `CREATE FUNCTION fx.edate(ts timestamptz, n numeric, tz text) RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN NOT fx.ts_ok(ts) OR abs(fx.int_arg(n)) > 12000 THEN NULL
                 ELSE ((ts AT TIME ZONE tz) + make_interval(months => fx.int_arg(n))) AT TIME ZONE tz END
   $$`,
  `CREATE FUNCTION fx.eomonth(d date, n numeric) RETURNS date LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN NOT fx.date_ok(d) OR abs(fx.int_arg(n)) > 12000 THEN NULL
                 ELSE (date_trunc('month', d + make_interval(months => fx.int_arg(n)))
                       + interval '1 month - 1 day')::date END
   $$`,
  // DATEDIF: whole Y/M/D between two dates (NULL when start > end or unknown unit).
  `CREATE FUNCTION fx.datedif(a date, b date, unit text) RETURNS numeric LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       months integer;
     BEGIN
       IF a > b OR NOT fx.date_ok(a) OR NOT fx.date_ok(b) THEN RETURN NULL; END IF;
       months := (extract(year FROM b)::integer - extract(year FROM a)::integer) * 12
                 + extract(month FROM b)::integer - extract(month FROM a)::integer
                 - CASE WHEN extract(day FROM b) < extract(day FROM a) THEN 1 ELSE 0 END;
       CASE upper(unit)
         WHEN 'D' THEN RETURN b - a;
         WHEN 'M' THEN RETURN months;
         WHEN 'Y' THEN RETURN months / 12;
         WHEN 'YM' THEN RETURN months % 12;
         WHEN 'MD' THEN RETURN b - fx.edate(a, months);
         WHEN 'YD' THEN RETURN b - fx.edate(a, (months / 12) * 12);
         ELSE RETURN NULL;
       END CASE;
     END
   $$`,
  // WORKDAY: n working days (Monday–Friday, not a holiday) after/before d; at most 100 000.
  `CREATE FUNCTION fx.workday(d date, n numeric, holidays date[]) RETURNS date LANGUAGE plpgsql ${PURE} AS $$
     DECLARE
       remaining integer;
       step integer;
       cur date := d;
     BEGIN
       IF d IS NULL OR n IS NULL OR NOT fx.date_ok(d) OR abs(n) > 100000 THEN RETURN NULL; END IF;
       remaining := abs(trunc(n))::integer;
       step := CASE WHEN n < 0 THEN -1 ELSE 1 END;
       WHILE remaining > 0 LOOP
         cur := cur + step;
         IF NOT fx.date_ok(cur) THEN RETURN NULL; END IF;
         IF extract(isodow FROM cur) < 6
            AND NOT coalesce(cur = ANY (holidays), false) THEN
           remaining := remaining - 1;
         END IF;
       END LOOP;
       RETURN cur;
     END
   $$`,
  // NETWORKDAYS: working days from a to b, both included (negative when a > b).
  `CREATE FUNCTION fx.networkdays(a date, b date, holidays date[]) RETURNS numeric LANGUAGE plpgsql ${PURE} AS $$
     DECLARE
       total integer;
       days integer;
       k integer;
     BEGIN
       IF a IS NULL OR b IS NULL OR NOT fx.date_ok(a) OR NOT fx.date_ok(b) THEN RETURN NULL; END IF;
       IF a > b THEN RETURN -fx.networkdays(b, a, holidays); END IF;
       total := b - a + 1;
       days := (total / 7) * 5;
       FOR k IN 0 .. (total % 7) - 1 LOOP
         IF extract(isodow FROM (a + (total / 7) * 7 + k)) < 6 THEN days := days + 1; END IF;
       END LOOP;
       days := days - (SELECT count(DISTINCT h) FROM unnest(holidays) AS u(h)
                          WHERE h BETWEEN a AND b AND extract(isodow FROM h) < 6);
       RETURN days;
     END
   $$`,
  // TODATE: "YYYY-M-D" or "YYYY/M/D", optionally " H:mm[:ss]" (or "T…"), wall-clock time in tz.
  `CREATE FUNCTION fx.todate(t text, tz text) RETURNS timestamptz LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN m IS NULL THEN NULL
                 ELSE fx.make_local(m[1]::integer, m[2]::integer, m[3]::integer,
                                    coalesce(m[4], '0')::integer, coalesce(m[5], '0')::integer,
                                    coalesce(m[6], '0')::integer, tz) END
       FROM (SELECT regexp_match(btrim(t),
               '^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$') AS m) AS parsed
   $$`,
  `CREATE FUNCTION fx.pad(n numeric, width integer) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT lpad(trunc(n)::bigint::text, width, '0')
   $$`,
  // Canonical text of a date ("YYYY-MM-DD") and of a datetime ("YYYY-MM-DD HH:mm:ss" in tz).
  `CREATE FUNCTION fx.date_text(d date) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT fx.pad(extract(year FROM d), 4) || '-' || fx.pad(extract(month FROM d), 2) || '-'
            || fx.pad(extract(day FROM d), 2)
   $$`,
  `CREATE FUNCTION fx.datetime_text(ts timestamptz, tz text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT fx.date_text((ts AT TIME ZONE tz)::date) || ' '
            || fx.pad(extract(hour FROM ts AT TIME ZONE tz), 2) || ':'
            || fx.pad(extract(minute FROM ts AT TIME ZONE tz), 2) || ':'
            || fx.pad(floor(extract(second FROM ts AT TIME ZONE tz)), 2)
   $$`,
  // TEXT(date, pattern): YYYY YY MM M DD D HH H mm ss; any other character is copied.
  `CREATE FUNCTION fx.text_date(v timestamp, fmt text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       acc text := '';
       i integer := 1;
       n integer := char_length(fmt);
       rest text;
     BEGIN
       WHILE i <= n LOOP
         rest := substr(fmt, i, 4);
         IF rest = 'YYYY' THEN acc := acc || fx.pad(extract(year FROM v), 4); i := i + 4;
         ELSIF left(rest, 2) = 'YY' THEN acc := acc || fx.pad(mod(extract(year FROM v), 100), 2); i := i + 2;
         ELSIF left(rest, 2) = 'MM' THEN acc := acc || fx.pad(extract(month FROM v), 2); i := i + 2;
         ELSIF left(rest, 1) = 'M' THEN acc := acc || fx.pad(extract(month FROM v), 1); i := i + 1;
         ELSIF left(rest, 2) = 'DD' THEN acc := acc || fx.pad(extract(day FROM v), 2); i := i + 2;
         ELSIF left(rest, 1) = 'D' THEN acc := acc || fx.pad(extract(day FROM v), 1); i := i + 1;
         ELSIF left(rest, 2) = 'HH' THEN acc := acc || fx.pad(extract(hour FROM v), 2); i := i + 2;
         ELSIF left(rest, 1) = 'H' THEN acc := acc || fx.pad(extract(hour FROM v), 1); i := i + 1;
         ELSIF left(rest, 2) = 'mm' THEN acc := acc || fx.pad(extract(minute FROM v), 2); i := i + 2;
         ELSIF left(rest, 2) = 'ss' THEN acc := acc || fx.pad(floor(extract(second FROM v)), 2); i := i + 2;
         ELSE acc := acc || left(rest, 1); i := i + 1;
         END IF;
       END LOOP;
       RETURN acc;
     END
   $$`,
  // TEXT(number, pattern): [#,##]0…[.0…][%] — minimum integer digits, fixed decimals,
  // optional thousands separator and percent; any other pattern → NULL.
  `CREATE FUNCTION fx.text_number(x numeric, fmt text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       m text[];
       decimals integer;
       v numeric;
       digits text;
       int_part text;
       frac_part text;
       grouped text := '';
     BEGIN
       m := regexp_match(fmt, '^(#,##)?(0{1,20})(?:\\.(0{1,20}))?(%)?$');
       IF m IS NULL THEN RETURN NULL; END IF;
       decimals := coalesce(char_length(m[3]), 0);
       v := round(CASE WHEN m[4] IS NULL THEN x ELSE x * 100 END, decimals);
       digits := abs(v)::text;
       int_part := split_part(digits, '.', 1);
       frac_part := split_part(digits, '.', 2);
       IF char_length(int_part) < char_length(m[2]) THEN
         int_part := lpad(int_part, char_length(m[2]), '0');
       END IF;
       IF m[1] IS NOT NULL THEN
         WHILE char_length(int_part) > 3 LOOP
           grouped := ',' || right(int_part, 3) || grouped;
           int_part := left(int_part, char_length(int_part) - 3);
         END LOOP;
         int_part := int_part || grouped;
       END IF;
       RETURN CASE WHEN v < 0 THEN '-' ELSE '' END || int_part
              || CASE WHEN decimals > 0 THEN '.' || frac_part ELSE '' END
              || coalesce(m[4], '');
     END
   $$`,
];

const TEXTS = [
  // LEFT/RIGHT/MID/FIND/REPLACE count Unicode code points; negative counts → NULL.
  `CREATE FUNCTION fx.left(t text, n numeric) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN n < 0 THEN NULL ELSE left(t, fx.int_arg(n)) END
   $$`,
  `CREATE FUNCTION fx.right(t text, n numeric) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN n < 0 THEN NULL ELSE right(t, fx.int_arg(n)) END
   $$`,
  `CREATE FUNCTION fx.mid(t text, s numeric, n numeric) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN s < 1 OR n < 0 THEN NULL ELSE substr(t, fx.int_arg(s), fx.int_arg(n)) END
   $$`,
  // FIND: 1-based position from start (default 1), -1 when not found.
  `CREATE FUNCTION fx.find(search text, within text, start numeric) RETURNS numeric LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN start < 1 THEN NULL
                 WHEN fx.int_arg(start) > char_length(within) + 1 THEN -1
                 WHEN strpos(substr(within, fx.int_arg(start)), search) = 0 THEN -1
                 ELSE strpos(substr(within, fx.int_arg(start)), search) + fx.int_arg(start) - 1 END
   $$`,
  `CREATE FUNCTION fx.replace(t text, s numeric, n numeric, new_text text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN s < 1 OR n < 0 THEN NULL
                 ELSE substr(t, 1, fx.int_arg(s) - 1) || new_text
                      || substr(t, least(fx.int_arg(s)::bigint + fx.int_arg(n), 2147483647)::integer) END
   $$`,
  // SUBSTITUTE: every occurrence, or only the n-th (n ≥ 1) when given.
  `CREATE FUNCTION fx.substitute(t text, search text, replacement text, occurrence numeric)
     RETURNS text LANGUAGE plpgsql ${PURE} AS $$
     DECLARE
       target integer;
       pos integer := 0;
       hit integer;
       k integer := 0;
     BEGIN
       IF t IS NULL OR search IS NULL OR replacement IS NULL THEN RETURN NULL; END IF;
       IF search = '' THEN RETURN t; END IF;
       IF occurrence IS NULL THEN RETURN replace(t, search, replacement); END IF;
       target := fx.int_arg(occurrence);
       IF target < 1 THEN RETURN NULL; END IF;
       LOOP
         hit := strpos(substr(t, pos + 1), search);
         IF hit = 0 THEN RETURN t; END IF;
         pos := pos + hit;
         k := k + 1;
         IF k = target THEN
           RETURN substr(t, 1, pos - 1) || replacement || substr(t, pos + char_length(search));
         END IF;
         pos := pos + char_length(search) - 1;
       END LOOP;
     END
   $$`,
  // TRIM: spaces at both ends removed, inner runs of spaces collapsed to one.
  `CREATE FUNCTION fx.trim(t text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT regexp_replace(btrim(t, ' '), ' {2,}', ' ', 'g')
   $$`,
  // SPLIT: an empty text is an empty list; an empty separator keeps the text whole.
  `CREATE FUNCTION fx.split(t text, sep text) RETURNS text[] LANGUAGE sql ${STRICT} AS $$
     SELECT CASE WHEN t = '' THEN '{}'::text[] ELSE string_to_array(t, sep) END
   $$`,
  // ENCODEURL: like JavaScript encodeURIComponent (UTF-8 bytes, A-Z a-z 0-9 - _ . ! ~ * ' ( ) kept).
  `CREATE FUNCTION fx.encodeurl(t text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT coalesce(string_agg(
              CASE WHEN b BETWEEN 48 AND 57 OR b BETWEEN 65 AND 90 OR b BETWEEN 97 AND 122
                        OR b IN (33, 39, 40, 41, 42, 45, 46, 95, 126) THEN chr(b)
                   ELSE '%' || upper(lpad(to_hex(b), 2, '0')) END, '' ORDER BY i), '')
       FROM (SELECT convert_to(t, 'UTF8') AS bytes) AS encoded,
            LATERAL generate_series(0, length(bytes) - 1) AS i,
            LATERAL get_byte(bytes, i) AS b
   $$`,
  // FORMAT: {1}, {2}, … replaced by the values (empty for NULL); other placeholders kept.
  `CREATE FUNCTION fx.format(template text, vals text[]) RETURNS text LANGUAGE plpgsql ${PURE} AS $$
     DECLARE
       acc text := '';
       pos integer := 1;
       hit integer;
       token text;
       k integer;
     BEGIN
       IF template IS NULL THEN RETURN NULL; END IF;
       LOOP
         hit := regexp_instr(template, '\\{[0-9]{1,3}\\}', pos);
         IF hit = 0 THEN RETURN acc || substr(template, pos); END IF;
         token := substring(template FROM hit FOR strpos(substr(template, hit), '}'));
         k := substring(token FROM 2 FOR char_length(token) - 2)::integer;
         acc := acc || substr(template, pos, hit - pos)
                || CASE WHEN k >= 1 AND k <= coalesce(cardinality(vals), 0)
                        THEN coalesce(vals[k], '') ELSE token END;
         pos := hit + char_length(token);
       END LOOP;
     END
   $$`,
  // HYPERLINK: "[label](url)", or the bare url without a label (rendered as a link by the UI
  // only for http, https and mailto).
  `CREATE FUNCTION fx.hyperlink(url text, label text) RETURNS text LANGUAGE sql ${PURE} AS $$
     SELECT CASE WHEN url IS NULL THEN NULL
                 WHEN label IS NULL OR label = '' THEN url
                 ELSE '[' || label || '](' || url || ')' END
   $$`,
  // REGEX*: pattern ≤ 500 characters, applied to the first 10 000 characters; bad pattern → NULL.
  `CREATE FUNCTION fx.regex_match(t text, pattern text) RETURNS boolean LANGUAGE plpgsql ${STRICT} AS $$
     BEGIN
       IF char_length(pattern) > 500 THEN RETURN NULL; END IF;
       RETURN left(t, 10000) ~ pattern;
     EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
       RETURN NULL;
     END
   $$`,
  `CREATE FUNCTION fx.regex_extract(t text, pattern text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     BEGIN
       IF char_length(pattern) > 500 THEN RETURN NULL; END IF;
       RETURN regexp_substr(left(t, 10000), pattern);
     EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
       RETURN NULL;
     END
   $$`,
  `CREATE FUNCTION fx.regex_replace(t text, pattern text, replacement text) RETURNS text
     LANGUAGE plpgsql ${STRICT} AS $$
     BEGIN
       IF char_length(pattern) > 500 THEN RETURN NULL; END IF;
       RETURN regexp_replace(left(t, 10000), pattern, replacement, 'g');
     EXCEPTION WHEN invalid_regular_expression OR program_limit_exceeded THEN
       RETURN NULL;
     END
   $$`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of [...NUMBERS, ...DATES, ...TEXTS]) {
    await sql.raw(statement).execute(db);
  }
}
