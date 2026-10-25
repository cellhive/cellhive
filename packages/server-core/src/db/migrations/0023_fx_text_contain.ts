import { sql, type Kysely } from 'kysely';

/**
 * Migration 0023 (BACKLOG T473): `TEXT` patterns after Lark, `LOWER`/`UPPER`
 * and the case folding of `CONTAIN`/`CONTAINSALL`/`CONTAINSONLY` (SPEC §9.4).
 *
 * - `fx.text_number` and `fx.text_date` are replaced (same signatures, so the
 *   compiler and the dependent SQL are unchanged): number patterns
 *   `[#0,]…[.[#0]…][%]`; date tokens in any letter case, English month and
 *   weekday names, `MM`/`M` as minutes next to an hour or `SS` token.
 * - `fx.lower` / `fx.upper` (`LOWER`/`UPPER`) and `fx.fold(text)` /
 *   `fx.fold_all(text[])` (`CONTAIN*`): Unicode simple case mappings through
 *   the built-in `pg_c_utf8` collation — independent of the column
 *   collation, `lc_ctype` and ICU (unlike `lower()` under `und-x-icu`, which
 *   maps `İ` to `i̇`). The TS evaluator applies the same tables
 *   (`lowerCase`, `upperCase`, `foldCase`).
 *
 * Like 0021: every function is `IMMUTABLE PARALLEL SAFE`, never reads
 * `TimeZone`, `lc_*` or `DateStyle` (pattern letters are upper-cased with
 * the `C` collation, ASCII only; no `to_char`), and is self-contained so the
 * number can change at merge. Forward-only: `CREATE OR REPLACE`, no `down`.
 */

const STRICT = 'IMMUTABLE PARALLEL SAFE STRICT';

const FUNCTIONS = [
  // LOWER/UPPER: simple case mappings (Unicode of the server: 16.0 for PostgreSQL 18),
  // whatever the collation of the argument; the result keeps the caller's collation.
  `CREATE OR REPLACE FUNCTION fx.lower(t text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT lower(t COLLATE pg_c_utf8)
   $$`,
  `CREATE OR REPLACE FUNCTION fx.upper(t text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT upper(t COLLATE pg_c_utf8)
   $$`,
  // CONTAIN* case folding: the simple lowercase mapping.
  `CREATE OR REPLACE FUNCTION fx.fold(t text) RETURNS text LANGUAGE sql ${STRICT} AS $$
     SELECT lower(t COLLATE pg_c_utf8)
   $$`,
  `CREATE OR REPLACE FUNCTION fx.fold_all(a text[]) RETURNS text[] LANGUAGE sql ${STRICT} AS $$
     SELECT ARRAY(SELECT lower(u.v COLLATE pg_c_utf8) FROM unnest(a) WITH ORDINALITY AS u(v, i) ORDER BY u.i)
   $$`,
  // TEXT(number, pattern): in the integer part (≤ 40 characters) each 0 is a minimum digit,
  // # an optional one, a "," between placeholders groups thousands; after "." (≤ 20
  // placeholders) round to as many decimals, trailing zeros dropped down to the last 0;
  // % multiplies by 100. A zero integer part without a 0 is omitted and the point is kept
  // (Excel). Any other pattern → NULL.
  `CREATE OR REPLACE FUNCTION fx.text_number(x numeric, fmt text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       m text[];
       int_pat text;
       frac_pat text;
       decimals integer;
       min_decimals integer;
       min_int integer;
       v numeric;
       digits text;
       int_part text;
       frac_part text;
       grouped text := '';
     BEGIN
       m := regexp_match(fmt, '^([#0,]{0,40})(?:(\\.)([#0]{0,20}))?(%?)$');
       IF m IS NULL THEN RETURN NULL; END IF;
       int_pat := m[1];
       frac_pat := coalesce(m[3], '');
       IF replace(int_pat || frac_pat, ',', '') = '' THEN RETURN NULL; END IF;
       IF left(int_pat, 1) = ',' OR right(int_pat, 1) = ',' THEN RETURN NULL; END IF;
       decimals := char_length(frac_pat);
       min_decimals := CASE WHEN strpos(frac_pat, '0') = 0 THEN 0
                            ELSE decimals - strpos(reverse(frac_pat), '0') + 1 END;
       min_int := char_length(int_pat) - char_length(replace(int_pat, '0', ''));
       v := round(CASE WHEN m[4] = '%' THEN x * 100 ELSE x END, decimals);
       digits := abs(v)::text;
       int_part := split_part(digits, '.', 1);
       frac_part := split_part(digits, '.', 2);
       WHILE char_length(frac_part) > min_decimals AND right(frac_part, 1) = '0' LOOP
         frac_part := left(frac_part, -1);
       END LOOP;
       IF int_part = '0' THEN int_part := ''; END IF;
       IF char_length(int_part) < min_int THEN int_part := lpad(int_part, min_int, '0'); END IF;
       IF strpos(int_pat, ',') > 0 THEN
         WHILE char_length(int_part) > 3 LOOP
           grouped := ',' || right(int_part, 3) || grouped;
           int_part := left(int_part, char_length(int_part) - 3);
         END LOOP;
         int_part := int_part || grouped;
       END IF;
       RETURN CASE WHEN v < 0 THEN '-' ELSE '' END || int_part
              || CASE WHEN m[2] IS NULL THEN '' ELSE '.' || frac_part END
              || m[4];
     END
   $$`,
  // TEXT(date, pattern): YYYY YY MMMM MMM MM M DDDD DDD DD D HH H SS, letters in any case
  // (ASCII only); MM/M right after an hour token or right before SS (other characters in
  // between) are minutes; English names; any other character is copied; [h], [mm], [ss]
  // (elapsed time, Phase 2) → NULL.
  `CREATE OR REPLACE FUNCTION fx.text_date(v timestamp, fmt text) RETURNS text LANGUAGE plpgsql ${STRICT} AS $$
     DECLARE
       up text := upper(fmt COLLATE "C");
       n integer := char_length(fmt);
       i integer := 1;
       len integer;
       k text;
       kinds text[] := ARRAY[]::text[];
       lits text[] := ARRAY[]::text[];
       total integer;
       j integer;
       prev text;
       nxt text;
       acc text := '';
       months text[] := ARRAY['January', 'February', 'March', 'April', 'May', 'June', 'July',
                              'August', 'September', 'October', 'November', 'December'];
       weekdays text[] := ARRAY['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                                'Friday', 'Saturday'];
       month_name text := months[extract(month FROM v)::integer];
       day_name text := weekdays[extract(dow FROM v)::integer + 1];
     BEGIN
       IF up ~ '\\[[HMS]+\\]' THEN RETURN NULL; END IF;
       WHILE i <= n LOOP
         IF substr(up, i, 4) = 'YYYY' THEN k := 'Y4'; len := 4;
         ELSIF substr(up, i, 2) = 'YY' THEN k := 'Y2'; len := 2;
         ELSIF substr(up, i, 4) = 'MMMM' THEN k := 'M4'; len := 4;
         ELSIF substr(up, i, 3) = 'MMM' THEN k := 'M3'; len := 3;
         ELSIF substr(up, i, 2) = 'MM' THEN k := 'M2'; len := 2;
         ELSIF substr(up, i, 1) = 'M' THEN k := 'M1'; len := 1;
         ELSIF substr(up, i, 4) = 'DDDD' THEN k := 'D4'; len := 4;
         ELSIF substr(up, i, 3) = 'DDD' THEN k := 'D3'; len := 3;
         ELSIF substr(up, i, 2) = 'DD' THEN k := 'D2'; len := 2;
         ELSIF substr(up, i, 1) = 'D' THEN k := 'D1'; len := 1;
         ELSIF substr(up, i, 2) = 'HH' THEN k := 'H2'; len := 2;
         ELSIF substr(up, i, 1) = 'H' THEN k := 'H1'; len := 1;
         ELSIF substr(up, i, 2) = 'SS' THEN k := 'S2'; len := 2;
         ELSE k := 'L'; len := 1;
         END IF;
         kinds := kinds || k;
         lits := lits || substr(fmt, i, len);
         i := i + len;
       END LOOP;
       total := coalesce(array_length(kinds, 1), 0);
       FOR t IN 1 .. total LOOP
         k := kinds[t];
         IF k = 'M1' OR k = 'M2' THEN
           j := t - 1;
           WHILE j >= 1 AND kinds[j] = 'L' LOOP j := j - 1; END LOOP;
           prev := CASE WHEN j >= 1 THEN kinds[j] ELSE '' END;
           j := t + 1;
           WHILE j <= total AND kinds[j] = 'L' LOOP j := j + 1; END LOOP;
           nxt := CASE WHEN j <= total THEN kinds[j] ELSE '' END;
           IF prev = 'H1' OR prev = 'H2' OR nxt = 'S2' THEN
             k := CASE k WHEN 'M1' THEN 'N1' ELSE 'N2' END;
           END IF;
         END IF;
         acc := acc || CASE k
           WHEN 'L' THEN lits[t]
           WHEN 'Y4' THEN fx.pad(extract(year FROM v), 4)
           WHEN 'Y2' THEN fx.pad(mod(extract(year FROM v), 100), 2)
           WHEN 'M4' THEN month_name
           WHEN 'M3' THEN left(month_name, 3)
           WHEN 'M2' THEN fx.pad(extract(month FROM v), 2)
           WHEN 'M1' THEN extract(month FROM v)::integer::text
           WHEN 'N2' THEN fx.pad(extract(minute FROM v), 2)
           WHEN 'N1' THEN extract(minute FROM v)::integer::text
           WHEN 'D4' THEN day_name
           WHEN 'D3' THEN left(day_name, 3)
           WHEN 'D2' THEN fx.pad(extract(day FROM v), 2)
           WHEN 'D1' THEN extract(day FROM v)::integer::text
           WHEN 'H2' THEN fx.pad(extract(hour FROM v), 2)
           WHEN 'H1' THEN extract(hour FROM v)::integer::text
           ELSE fx.pad(floor(extract(second FROM v)), 2)
         END;
       END LOOP;
       RETURN acc;
     END
   $$`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of FUNCTIONS) {
    await sql.raw(statement).execute(db);
  }
}
