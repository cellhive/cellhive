# Shared formula fixture (TS ≡ SQL)

Data-driven cases for SPEC §9.4 "test tương đương": the TS evaluator (T453,
`packages/formula-engine/test/evaluate-fixture.test.ts`) and the SQL compiler
(T454 same-row cases, T455 links and `[Table]`) must give the same result for
every case. The files are plain JSON so any harness can read them;
`formula-fixture.ts` is a small loader for Vitest.

## Files

- `formula-schema.json`
  - `defaults`: formula table (`Dữ liệu`), formula row ID, `tz`
    (`Asia/Ho_Chi_Minh`), `now` (`2026-09-28T07:30:00.000Z`), `locale` (`und`).
  - `tables`: `SnapshotField`s (`id`, `name`, `type`, `options`, `linkTableId`)
    per table, plus `primary` (name of the primary field = record title).
    Field types and options are those of `@cellhive/field-types`; select
    options carry fixed IDs.
  - `records`: rows of `Khách hàng` and `Đơn hàng` (by table name, in table
    order), cells by field name — the data links and `[Table]` read.
- `formula-cases.json`: `{ "cases": [...] }`, each case:

| Key                   | Meaning                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | unique, `<FUNCTION>-<what>` or `op-…`, `link-…`, `table-…`                                                                                                                                                                                                   |
| `formula`             | display form (names); resolve with `resolveNames(parse(f, { form: 'display' }), snapshot)`                                                                                                                                                                   |
| `table`, `rowId`      | formula table (default `Dữ liệu`) and ID of the formula row (also the SQL record id when set)                                                                                                                                                                |
| `row`                 | cells of the formula row by field name, records API JSON shape (select = option ID, date-only `YYYY-MM-DD`, datetime ISO with offset, user = user ID, link = record IDs); missing = empty                                                                    |
| `tz`, `now`, `locale` | override the defaults                                                                                                                                                                                                                                        |
| `expected`            | result as `evaluate` returns it (below)                                                                                                                                                                                                                      |
| `type`                | `formatType(result_type)` of `analyze`                                                                                                                                                                                                                       |
| `tolerance`           | numbers only: allowed relative difference (irrational results)                                                                                                                                                                                               |
| `scope`               | `same_row` (only the row's own cells, T454) or `cross_table` (links or `[Table]`, T455)                                                                                                                                                                      |
| `lookup`              | optional, `cross_table`: a lookup field `{ from, select, where, aggregate }` by names (select operands = option names, `{ "field_ref": name }` = field of the formula table), evaluated through `lookupToAst` instead of `formula` (then a description only) |

## Comparing results

`evaluate` returns JSON: numbers as exact decimal text without trailing zeros
(`"1.5"`, never `1.50` or `1.5e3`) — compare as decimals; dates `YYYY-MM-DD`;
datetimes `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC); booleans; texts; users by ID;
records `{ id, title }`; lists as arrays; **an empty list is `null`** (what
`array_agg` gives for no row). `NOW()`/`TODAY()` cases need `now()` bound to
the case's `now`.

## Replay on PostgreSQL

`packages/server-core/test/formula/fixture-source.ts` adapts this fixture for
T454's harness (`equivalence.int.test.ts`): the formula table's fields
(primary first, link fields left out), select cells as option names, `tz`/
`now` defaults filled in, `scope: cross_table` cases skipped (T455), `rowId`
used as the record id when a case sets one (`RECORD_ID()` cases). The cases
`t454-…` come from T454's interim fixture (its fields `Title`, `Name`,
`Amount`… are part of the formula table).

## Semantics pinned down by the fixture

The value conventions are those of SPEC §9.4 ("Quy ước giá trị chung của hai
backend", `fx.*` of migration 0021); the TS evaluator mirrors them:

- **Numbers** are `numeric`: `+ - *` exact; `/` rounds half away from zero at
  PostgreSQL's `select_div_scale` (`1 / 3` → 20 decimals, `10 / 3` → 16);
  `SQRT` at `numeric_sqrt`'s scale, `STDEV` = `stddev_samp`, `AVERAGE` =
  `avg`, `DURATION(d, h, m, s)` = `d + h/24 + m/1440 + s/86400` (empty parts
  0); `ROUND*` halve away from zero, places clamped to ±1000; `%` ≡ `MOD`
  (sign of the divisor); `FLOOR`/`CEILING` use |factor|; `POWER` beyond
  10^±1000, `EXP` beyond e^2302 and `PRODUCT` from 10^1000 are empty; `PI()`
  has 50 decimals. `EXP`/`LN`/`LOG`/non-integer `POWER` go through doubles
  (cases carry a `tolerance`). Number → text drops trailing zeros.
  Integer arguments are truncated toward zero and clamped to ±2,147,483,647.
- **Empty values**: an empty input gives an empty result (strict), except:
  `&`/`CONCATENATE`/`FORMAT` read empty as `""`; `SUM`, `COUNTA`, `COUNTIF`,
  `SUMIF` and `PRODUCT` of nothing are `0`; `AVERAGE`/`MEDIAN`/`MAX`/`MIN`
  of nothing are empty; aggregates skip empty elements. Conditions (`AND`,
  `OR`, `NOT`, `IF`, `IFS`, `&&`, `||`, FILTER/COUNTIF/SUMIF) read empty as
  `FALSE`; an optional boolean left empty takes its default (`SORT`).
  `CONTAINTEXT` of an empty value is `FALSE`.
- **Comparisons**: `=`/`!=` never give empty — texts (and users) compare with
  empty text ≡ empty, lists element by element (an empty list ≡ empty), other
  values `IS NOT DISTINCT FROM`; texts are case-sensitive; a date equals a
  datetime at its local midnight. `<`, `<=`, `>`, `>=` with an empty side are
  `FALSE`. `CONTAIN`/`CONTAINSALL`/`CONTAINSONLY` are SQL array overlap /
  containment: empty elements never match, `CONTAINSONLY` of an empty range
  is `FALSE`. Texts in `CONTAIN*` ignore case (T473) when every argument is
  plain text or a record title — `fx.fold`: Unicode 16.0 simple lowercase
  mapping (`İ` → `i`, `ẞ` → `ß`, `ß` ≠ `ss`, `Σ` → `σ`, accents kept); user
  IDs and `RECORD_ID()` make the whole call exact. Lookup `where`
  conditions (`lookup` cases) keep Filter DSL semantics: exact option names,
  no folding. `LOWER`/`UPPER` use the same simple mappings (`ı` → `I`,
  `ß` stays, no final sigma).
- **Errors** are empty (`fx.*` safe variants). `IFERROR(x, y)` ≡
  `COALESCE(x, y)`. `ISERROR(x)` is true when `x` is empty and every `[Field]`
  it reads has a value.
- **Texts** count code points (`LEN("😀👍")` = 2). `TRIM` works on ASCII
  spaces. `FIND` → -1 when absent. `SPLIT("", x)` → empty list, `SPLIT(x, "")`
  → `[x]`. `ENCODEURL` ≡ `encodeURIComponent`. `HYPERLINK(url, label)` →
  `[label](url)` (url alone without a label). `VALUE` reads a plain decimal
  (exponent of 1–3 digits). `TEXT(number, …)` accepts `[#0,]…[.[#0]…][%]`
  (Excel placeholders: `TEXT(0.5, "#.##")` → `.5`); `TEXT(date, …)` the
  tokens `YYYY YY MMMM MMM MM M DDDD DDD DD D HH H SS` in any letter case
  (English names; `MM`/`M` after an hour or before `SS` are minutes; `[h]`
  → empty) — T473. `UNACCENT`
  is PostgreSQL `unaccent`.
- **REGEX** (open question S4b #7): pattern ≤ 500 characters (else empty),
  applied to the first 10,000 characters; `REGEXEXTRACT` returns the whole
  first match; `REGEXREPLACE` replaces every match and reads `\1`…`\9`, `\&`,
  `\\` in the replacement like `regexp_replace`. Only syntax PostgreSQL ARE and
  JavaScript share is used.
- **Dates** use the explicit `tz` (ADR-21), never the machine or session zone;
  a datetime field with its own `options.timezone` is read in that zone (kept
  through `LET` and date arithmetic, dropped by any function call, as in the
  compiler). Local times follow PostgreSQL's `AT TIME ZONE`: a skipped time
  (DST gap) moves forward, a repeated one (fall-back) is the later instant.
  `date ± n` moves `floor(n)` days, `datetime ± n` exactly `n × 86400` s;
  `date − date` = whole days, with a datetime `extract(epoch …) / 86400`.
  `DATE(y, m, d)` rolls months/days over (year 1–9999). `TODATE` reads
  `YYYY-M-D`/`YYYY/M/D` with optional ` H:mm[:ss]` (or `T`), no offset, in
  `tz`. `EDATE` of a datetime keeps its wall-clock time. `WORKDAY` beyond
  100,000 days is empty. Datetime as text: `YYYY-MM-DD HH:mm:ss` in its zone.
- **Lists**: `SORT`/`SORTBY` put empty keys last and keep ties in order;
  `UNIQUE` keeps one empty element; `LISTCOMBINE` keeps empty elements (an
  empty list adds none); `ARRAYJOIN` of nothing is `""`; `LOOKUP` ≡
  `[T].FILTER(CurrentValue.[M] = v).[R]` (mode 1 on a multi-value `M`:
  `CONTAIN`), always a list.
