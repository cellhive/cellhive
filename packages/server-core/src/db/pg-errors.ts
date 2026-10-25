import { AppError } from '../errors/app-error.js';

/** SQLSTATE codes the application reacts to. */
export const SQLSTATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
  queryCanceled: '57014',
  programLimitExceeded: '54000',
} as const;

/** The SQLSTATE of a `pg` error, or `undefined` for anything else. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Fields of a `pg` error that can quote data — the failing row ("Failing row
 * contains (…)"), a key value ("Key (email)=(…) already exists"), the
 * statement context — dropped from logged errors (QA S5c: the default pino
 * serializer logged them; AGENTS.md: never log record values).
 */
export const PG_ERROR_DATA_FIELDS = ['detail', 'hint', 'where', 'internalQuery'] as const;

/**
 * A serialized error (pino `stdSerializers.err` output) without the
 * {@link PG_ERROR_DATA_FIELDS} of a `pg` error, at any depth of its `cause`
 * chain. Other errors pass unchanged.
 */
export function withoutPgErrorData<T>(serialized: T): T {
  if (typeof serialized !== 'object' || serialized === null) return serialized;
  const source = serialized as Record<string, unknown>;
  const drop: ReadonlySet<string> = new Set(
    sqlStateOf(source) === undefined ? [] : PG_ERROR_DATA_FIELDS,
  );
  const out = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !drop.has(key))
      .map(([key, value]) => [key, key === 'cause' ? withoutPgErrorData(value) : value]),
  );
  return out as T;
}

/**
 * True when PostgreSQL cancelled the statement because `statement_timeout`
 * elapsed (not for a cancel requested by the client).
 */
export function isStatementTimeout(error: unknown): boolean {
  if (sqlStateOf(error) !== SQLSTATE.queryCanceled) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('statement timeout');
}

/**
 * True when a value is too large for a B-tree index entry ("index row size
 * … exceeds btree version 4 maximum 2704", "index row requires … bytes"):
 * a long text written to (or already in) a `unique_values` column, whose
 * partial unique index (SPEC §5.4) is a plain B-tree on the column.
 */
export function isIndexRowTooLarge(error: unknown): boolean {
  if (sqlStateOf(error) !== SQLSTATE.programLimitExceeded) return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /^index row (size|requires)\b/.test(message);
}

/**
 * `422 INVALID_CELL_VALUE` / `UNIQUE_VALUE_TOO_LONG` for an
 * {@link isIndexRowTooLarge} error of a record write (CONTRACTS §6). PostgreSQL
 * does not say which row or value: `path` is `records`.
 */
export function uniqueValueTooLongError(cause: unknown): AppError {
  return new AppError('INVALID_CELL_VALUE', {
    detail: 'A value is too long for a field with unique values.',
    errors: [
      {
        path: 'records',
        code: 'UNIQUE_VALUE_TOO_LONG',
        message: 'The value is too long for a field with unique values',
      },
    ],
    cause,
  });
}
