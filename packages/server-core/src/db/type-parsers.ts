import pg from 'pg';

/**
 * Result type parsers for every connection created by `createDb`. They are
 * passed per pool (`types` option), never registered globally on `pg.types`,
 * so other `pg` users in the process are unaffected.
 *
 * | Type        | OID  | JS value                   | Why |
 * |-------------|------|----------------------------|-----|
 * | `date`      | 1082 | `'YYYY-MM-DD'` string      | A calendar date has no time zone; `pg` would build a `Date` at local midnight. |
 * | `date[]`    | 1182 | `string[]`                 | Same. |
 * | `int8`      | 20   | `bigint`                   | Exact beyond 2^53 (`count(*)`, `permission_version`, `__auto`); unlike a string it cannot be compared or concatenated by mistake, and `JSON.stringify` throws instead of silently losing precision, so API mappers convert explicitly. |
 * | `int8[]`    | 1016 | `bigint[]`                 | Same. |
 * | `numeric`   | 1700 | `string` (pg default)      | Arbitrary precision; converting to `number` could round. Callers parse where the field type allows. |
 * | `timestamptz` | 1184 | `Date` (pg default)      | Sessions run in UTC (`SET TIME ZONE 'UTC'`). |
 */
export const OID = {
  int8: 20,
  int8Array: 1016,
  textArray: 1009,
  date: 1082,
  dateArray: 1182,
  numeric: 1700,
} as const;

type TextParser = (value: string) => unknown;

// `pg.types.TypeId` lists scalar OIDs only; array OIDs are valid too.
const getBuiltinParser = pg.types.getTypeParser as (
  oid: number,
  format: 'text' | 'binary',
) => (value: string) => unknown;

const parseTextArray = getBuiltinParser(OID.textArray, 'text') as (
  value: string,
) => (string | null)[];

const TEXT_OVERRIDES: Readonly<Record<number, TextParser>> = {
  [OID.int8]: (value) => BigInt(value),
  [OID.int8Array]: (value) =>
    parseTextArray(value).map((item) => (item === null ? null : BigInt(item))),
  [OID.date]: (value) => value,
  [OID.dateArray]: (value) => parseTextArray(value),
  [OID.numeric]: (value) => value,
};

/** The `types` option of `pg.Pool` / `pg.Client`. */
export const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (format !== 'binary') {
      const override = TEXT_OVERRIDES[oid];
      if (override !== undefined) return override;
    }
    return getBuiltinParser(oid, format ?? 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};
