import { idOf, type Id } from '@cellhive/contracts';

import {
  isGlobalTable,
  isTenantTable,
  type GlobalTableName,
  type TenantTableName,
} from './tables.js';

import type { Db, DbExecutor, Tx } from './create-db.js';

declare const orgScopeBrand: unique symbol;

/**
 * The tenant a repository call is scoped to (AGENTS.md rule 5). Only
 * `orgScope()` creates one: the brand makes a hand-written object literal a
 * compile error, and a registry rejects forged objects at runtime.
 */
export interface OrgScope {
  readonly [orgScopeBrand]: true;
  readonly organizationId: Id<'org'>;
  /** Transaction to run in; `undefined` = the pool. */
  readonly tx: Tx | undefined;
}

const organizationIdSchema = idOf('org');
const issuedScopes = new WeakSet<object>();

/**
 * Creates the scope for `organizationId`, optionally bound to a transaction
 * from `db.withTx`. The ID is validated; an invalid one is a programming
 * error, not a client error.
 */
export function orgScope(organizationId: Id<'org'>, tx?: Tx): OrgScope {
  if (!organizationIdSchema.safeParse(organizationId).success) {
    throw new TypeError('orgScope: organizationId is not an organization ID');
  }
  const scope = Object.freeze({ organizationId, tx }) as unknown as OrgScope;
  issuedScopes.add(scope);
  return scope;
}

/** The same organization, bound to `tx`. */
export function withTxScope(scope: OrgScope, tx: Tx): OrgScope {
  return orgScope(scope.organizationId, tx);
}

export function isOrgScope(value: unknown): value is OrgScope {
  return typeof value === 'object' && value !== null && issuedScopes.has(value);
}

/**
 * Compile-time contract of a tenant repository: every public method takes an
 * `OrgScope` as its first, required parameter. Use it as
 * `class XRepository extends TenantRepository<'x'> implements TenantRepositoryContract<XRepository>`;
 * a method without a scope then fails to compile.
 */
export type TenantRepositoryContract<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => unknown
    ? A extends [OrgScope, ...unknown[]]
      ? R[K]
      : `Tenant repository method '${K & string}' must take an OrgScope as its first parameter`
    : R[K];
};

/**
 * Base class for repositories of tenant tables (every `meta` table outside
 * `GLOBAL_TABLES`). Queries must filter on `organization_id =
 * scope.organizationId`; the isolation test of each repository proves it.
 */
export abstract class TenantRepository<T extends TenantTableName> {
  protected readonly table: T;

  protected constructor(
    protected readonly db: Db,
    table: T,
  ) {
    if (!isTenantTable(table)) {
      throw new TypeError(`TenantRepository: '${String(table)}' is not a tenant table`);
    }
    this.table = table;
  }

  /**
   * Executor for a call: the scope's transaction, or the pool. Throws for an
   * object that was not created by `orgScope()`.
   */
  protected executor(scope: OrgScope): DbExecutor {
    if (!isOrgScope(scope)) {
      throw new TypeError(`${this.constructor.name}: an OrgScope from orgScope() is required`);
    }
    return scope.tx ?? this.db.kysely;
  }
}

/**
 * Base class for repositories of the global tables only (closed list,
 * SPEC §5.10). Methods take no organization; any other table is rejected by
 * the type parameter and again at runtime.
 */
export abstract class GlobalRepository<T extends GlobalTableName> {
  protected readonly table: T;

  protected constructor(
    protected readonly db: Db,
    table: T,
  ) {
    if (!isGlobalTable(table)) {
      throw new TypeError(
        `GlobalRepository: '${String(table)}' is not a global table (SPEC §5.10 closed list)`,
      );
    }
    this.table = table;
  }

  /** The given transaction, or the pool. */
  protected executor(tx?: Tx): DbExecutor {
    return tx ?? this.db.kysely;
  }
}
