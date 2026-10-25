/** Offset pagination of a repository list (CONTRACTS §1.1). */
export interface PageRequest {
  readonly offset: number;
  readonly limit: number;
}

/** One page of rows and the total number of matching rows. */
export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}

/** `count(*)` comes back as `int8` (a `bigint`, see `type-parsers.ts`). */
export function countOf(row: { count: bigint | number | string } | undefined): number {
  return row === undefined ? 0 : Number(row.count);
}
