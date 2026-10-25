/**
 * Shape of a formula equivalence fixture (SPEC §9.4): data only, so the TS
 * evaluator (T453) and the SQL compiler (T454, this harness) replay the same
 * cases. `fixture-source.ts` decides which fixture the harness loads.
 *
 * Values are JSON:
 * - row values by field **name** as the API writes them: text, number
 *   (number or decimal string), boolean, select option **names**, date
 *   `YYYY-MM-DD`, datetime ISO instant, user ids, attachment objects;
 * - `expected` by the formula's result type: number as a decimal string
 *   (or number), text, boolean, date `YYYY-MM-DD`, datetime ISO instant,
 *   list as an array of those, `null` for an empty value / error.
 */

export interface FormulaFixtureField {
  readonly name: string;
  /** `@cellhive/field-types` type. */
  readonly type: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface FormulaFixtureCase {
  /** Unique, stable name. */
  readonly name: string;
  /** Display form (field names, as typed in the editor). */
  readonly formula: string;
  readonly row?: Readonly<Record<string, unknown>>;
  /** Record id of the row (RECORD_ID() cases); a generated one when absent. */
  readonly rowId?: string;
  /** IANA zone of the formula (ADR-21). */
  readonly tz: string;
  /** Fixed `NOW()` (ISO instant). */
  readonly now: string;
  readonly expected: unknown;
  /**
   * Only for cases that depend on other tables (links, `[Table]`, LOOKUP):
   * replayed by T455, skipped by the same-row harness.
   */
  readonly crossTable?: boolean;
}

export interface FormulaFixture {
  /** Fields of the formula's table; the first one is the primary field (text). */
  readonly fields: readonly FormulaFixtureField[];
  readonly cases: readonly FormulaFixtureCase[];
}
