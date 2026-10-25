import { Buffer } from 'node:buffer';

import { sql, type RawBuilder } from 'kysely';

import { AppError } from '../errors/app-error.js';

/**
 * Keyset cursors of the cursor lists (CONTRACTS §1.1, §11): the sort key of
 * the last item of a page — a timestamp with microseconds and an id — as
 * opaque base64url JSON. The next page continues strictly after it in
 * `(timestamp DESC, id DESC)` order.
 */
export interface KeysetCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microseconds: PostgreSQL's precision). */
  readonly at: string;
  readonly id: string;
}

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID_PATTERN = /^[a-z]{3}_[0-9A-Za-z]{16}$/;
const MAX_CURSOR_LENGTH = 200;

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), 'utf8').toString('base64url');
}

function invalidCursor(path: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'The cursor is invalid.',
    errors: [{ path, code: 'INVALID_FORMAT', message: 'Invalid cursor' }],
  });
}

/** The cursor of a request (`undefined` = first page); malformed → `422 VALIDATION_FAILED`. */
export function decodeCursor(value: string | undefined, path = 'cursor'): KeysetCursor | null {
  if (value === undefined) return null;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor(path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor(path);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !AT_PATTERN.test(parsed[0]) ||
    !ID_PATTERN.test(parsed[1]) ||
    Number.isNaN(Date.parse(parsed[0]))
  ) {
    throw invalidCursor(path);
  }
  return { at: parsed[0], id: parsed[1] };
}

/** SQL text of a `timestamptz` in the cursor format (keeps the microseconds a `Date` drops). */
export function cursorTimestamp(column: RawBuilder<unknown>): RawBuilder<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `(column, id) < (cursor)`: rows after the cursor in `(column DESC, id DESC)` order. */
export function afterCursor(
  column: RawBuilder<unknown>,
  id: RawBuilder<unknown>,
  cursor: KeysetCursor,
): RawBuilder<boolean> {
  return sql<boolean>`(${column}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id}::text)`;
}

/**
 * One page from `limit + 1` fetched rows: the rows to return and the
 * cursor of the next page (`null` on the last one).
 */
export function pageWithCursor<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => KeysetCursor,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}
