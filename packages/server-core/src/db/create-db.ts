import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  sql,
  type IsolationLevel,
  type Transaction,
} from 'kysely';
import pg from 'pg';

import { AppError } from '../errors/app-error.js';

import { isStatementTimeout } from './pg-errors.js';
import { typeParsers } from './type-parsers.js';

import type { Database } from './schema.js';

/** `statement_timeout` for work done while serving a request (SPEC §14.2). */
export const REQUEST_STATEMENT_TIMEOUT_MS = 10_000;
/** `statement_timeout` for background jobs (SPEC §14.2). */
export const JOB_STATEMENT_TIMEOUT_MS = 60_000;

/** A transaction started by `Db.withTx`. */
export type Tx = Transaction<Database>;
/** Anything queries can run on: the pool (`db.kysely`) or a transaction. */
export type DbExecutor = Kysely<Database>;

export interface TxOptions {
  /**
   * `SET LOCAL statement_timeout` for this transaction, in milliseconds.
   * Defaults to `REQUEST_STATEMENT_TIMEOUT_MS`; jobs pass
   * `JOB_STATEMENT_TIMEOUT_MS`. `0` disables the timeout (migrations only).
   */
  readonly timeoutMs?: number;
  readonly isolationLevel?: IsolationLevel;
  /**
   * `SET LOCAL application_name` for this transaction (`[A-Za-z0-9_.:-]`,
   * at most 63 characters): names the backend in `pg_stat_activity` while
   * the transaction runs, so another connection can cancel exactly this
   * transaction's statement (`pg_cancel_backend`), including a lock wait.
   * Reverts when the transaction ends.
   */
  readonly applicationName?: string;
}

/** Characters allowed in `TxOptions.applicationName` (inlined in `SET LOCAL`). */
const APPLICATION_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,63}$/;

export interface Db {
  /** Query builder on the pool. Prefer `withTx` for anything that writes. */
  readonly kysely: Kysely<Database>;
  /**
   * Runs `fn` in a transaction with a transaction-scoped `statement_timeout`.
   * Commits when `fn` resolves, rolls back when it throws. A statement
   * cancelled by the timeout surfaces as `AppError('QUERY_TIMEOUT')` (504).
   * Events, audit entries and jobs written by `fn` must use the same `tx`.
   *
   * `withTx` itself runs no snapshot-taking statement: the first query of
   * `fn` takes the snapshot of a `REPEATABLE READ` transaction, so `fn` may
   * first take locks (`LOCK TABLE`) that the snapshot must postdate.
   */
  withTx<T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /**
   * Closes every pooled connection once the queries in flight finished;
   * queries started afterwards fail. Calling it again returns the same promise.
   */
  destroy(): Promise<void>;
}

export interface DbConfig {
  readonly url: string;
  readonly poolMax: number;
  /** `application_name` seen in `pg_stat_activity`. */
  readonly applicationName?: string;
  /**
   * Session-wide `statement_timeout` for queries outside `withTx`, in
   * milliseconds. Defaults to `REQUEST_STATEMENT_TIMEOUT_MS`; `0` disables it.
   */
  readonly statementTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  /**
   * Called when an idle pooled connection fails (e.g. the server restarted).
   * Without a handler such an error would crash the process.
   */
  readonly onIdleError?: (error: Error) => void;
  /**
   * Called with the SQL text (never the parameters) of every query, e.g. to
   * assert in tests that user input never reaches SQL text. Not for logging
   * in production: statements can be large.
   */
  readonly onQuery?: (sqlText: string) => void;
}

/** Work to run once a transaction has committed (e.g. realtime publishing). */
export type CommitHook = () => void | Promise<void>;

/** Hooks of the transactions currently open through `Db.withTx`. */
const commitHooks = new WeakMap<Tx, CommitHook[]>();
/** Hooks registered with `last` (they run after every other hook of the transaction). */
const lastCommitHooks = new WeakMap<Tx, CommitHook[]>();

/**
 * Runs `hook` after `tx` commits, in registration order; nothing runs when
 * it rolls back. `withTx` awaits the hooks before it resolves, so the caller
 * observes them as done. A hook must handle its own errors: one that throws
 * is ignored so that it can never fail a committed change. `tx` must be an
 * open transaction of `Db.withTx` (anything else is a programming error).
 * `last`: the hook runs after every hook registered without it, whenever it
 * was registered (realtime of recomputed values follows the write that
 * caused them, T459).
 */
export function afterCommit(
  tx: Tx,
  hook: CommitHook,
  options: { readonly last?: boolean } = {},
): void {
  const hooks = (options.last === true ? lastCommitHooks : commitHooks).get(tx);
  if (hooks === undefined) {
    throw new TypeError('afterCommit: not an open transaction of Db.withTx');
  }
  hooks.push(hook);
}

async function runCommitHooks(hooks: readonly CommitHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch {
      // Documented contract: hooks report their own failures.
    }
  }
}

function assertTimeout(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * Creates the Kysely instance and its `pg` pool. Connections are opened
 * lazily; every new connection is set to UTC (`SET TIME ZONE 'UTC'`) and gets
 * the session `statement_timeout` before its first query.
 */
export function createDb(config: DbConfig): Db {
  const sessionTimeoutMs = config.statementTimeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS;
  assertTimeout('statementTimeoutMs', sessionTimeoutMs);

  const pool = new pg.Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: config.applicationName ?? 'cellhive',
    types: typeParsers,
  });
  pool.on('error', (error) => {
    config.onIdleError?.(error);
  });
  let ended: Promise<void> | undefined;

  const onQuery = config.onQuery;
  const kysely = new Kysely<Database>({
    ...(onQuery === undefined
      ? {}
      : {
          log: (event) => {
            onQuery(event.query.sql);
          },
        }),
    dialect: new PostgresDialect({
      pool,
      onCreateConnection: async (connection) => {
        await connection.executeQuery(CompiledQuery.raw("SET TIME ZONE 'UTC'"));
        await connection.executeQuery(
          CompiledQuery.raw("SELECT set_config('statement_timeout', $1, false)", [
            String(sessionTimeoutMs),
          ]),
        );
      },
    }),
  });

  return {
    kysely,
    async withTx<T>(fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
      const timeoutMs = options.timeoutMs ?? REQUEST_STATEMENT_TIMEOUT_MS;
      assertTimeout('timeoutMs', timeoutMs);
      const { applicationName } = options;
      if (applicationName !== undefined && !APPLICATION_NAME_PATTERN.test(applicationName)) {
        throw new RangeError('applicationName must match [A-Za-z0-9_.:-]{1,63}');
      }
      const builder =
        options.isolationLevel === undefined
          ? kysely.transaction()
          : kysely.transaction().setIsolationLevel(options.isolationLevel);
      const hooks: CommitHook[] = [];
      const last: CommitHook[] = [];
      let transaction: Tx | undefined;
      try {
        const result = await builder.execute(async (tx) => {
          transaction = tx;
          commitHooks.set(tx, hooks);
          lastCommitHooks.set(tx, last);
          // A utility statement, unlike `SELECT set_config(…)`: it takes no
          // snapshot (see `Db.withTx`). `timeoutMs` is a checked integer.
          await sql`SET LOCAL statement_timeout = ${sql.raw(String(timeoutMs))}`.execute(tx);
          if (applicationName !== undefined) {
            // Checked against APPLICATION_NAME_PATTERN above; `SET` takes no parameters.
            await sql`SET LOCAL application_name = ${sql.lit(applicationName)}`.execute(tx);
          }
          return fn(tx);
        });
        if (transaction !== undefined) {
          commitHooks.delete(transaction);
          lastCommitHooks.delete(transaction);
        }
        await runCommitHooks([...hooks, ...last]);
        return result;
      } catch (error) {
        // Rolled back: the hooks are dropped.
        if (transaction !== undefined) {
          commitHooks.delete(transaction);
          lastCommitHooks.delete(transaction);
        }
        if (isStatementTimeout(error)) {
          throw new AppError('QUERY_TIMEOUT', {
            detail: 'The query took too long and was cancelled.',
            params: { timeout_ms: timeoutMs },
            cause: error,
          });
        }
        throw error;
      }
    },
    // Ends the pool itself, not through `kysely.destroy()`: Kysely's driver
    // forgets its pool before ending it, so a query whose new connection
    // was still opening then fails before running `onCreateConnection` and
    // never gives the connection back — `pool.end()` waited for it forever
    // and a graceful shutdown with a realtime re-check in flight hung.
    // `pool.end()` alone lets queries in flight finish and refuses new ones.
    destroy: () => (ended ??= pool.end()),
  };
}
