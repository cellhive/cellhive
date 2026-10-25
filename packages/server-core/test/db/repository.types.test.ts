/**
 * Type-level tests, enforced by `tsc` (`pnpm typecheck`): every
 * `@ts-expect-error` below must be an actual compile error, otherwise the
 * typecheck fails with "Unused '@ts-expect-error' directive". The functions
 * are never called at runtime.
 */
import { describe, expectTypeOf, it } from 'vitest';

import {
  BasesRepository,
  GlobalRepository,
  orgScope,
  TenantRepository,
  type Db,
  type OrgScope,
  type TenantRepositoryContract,
  type Tx,
} from '../../src/db/index.js';

const BASE_ID = 'bse_A1b2C3d4E5f6G7h8';
const WORKSPACE_ID = 'wsp_A1b2C3d4E5f6G7h8';

export function tenantCallsRequireAScope(repo: BasesRepository, tx: Tx): void {
  const scope = orgScope('org_A1b2C3d4E5f6G7h8', tx);
  void repo.getById(scope, BASE_ID);
  void repo.listByWorkspace(scope, WORKSPACE_ID);

  // @ts-expect-error — no organization scope at all.
  void repo.getById(BASE_ID);
  // @ts-expect-error — no organization scope at all.
  void repo.listByWorkspace(WORKSPACE_ID);
  // @ts-expect-error — a bare organization ID is not a scope.
  void repo.getById('org_A1b2C3d4E5f6G7h8', BASE_ID);
  // @ts-expect-error — a hand-written object lacks the OrgScope brand.
  void repo.getById({ organizationId: 'org_A1b2C3d4E5f6G7h8', tx: undefined }, BASE_ID);
  // @ts-expect-error — undefined is not a scope.
  void repo.update(undefined, BASE_ID, { name: 'x' });
  // @ts-expect-error — orgScope() only takes organization IDs.
  orgScope('usr_A1b2C3d4E5f6G7h8');
}

// A tenant repository whose public methods all take the scope first compiles…
export class GoodRepository
  extends TenantRepository<'groups'>
  implements TenantRepositoryContract<GoodRepository>
{
  constructor(db: Db) {
    super(db, 'groups');
  }

  count(scope: OrgScope, name: string): Promise<number> {
    void this.executor(scope);
    return Promise.resolve(name.length);
  }
}

// …one that forgets it on any public method does not.
export class MissingScopeRepository
  extends TenantRepository<'groups'>
  implements TenantRepositoryContract<MissingScopeRepository>
{
  constructor(db: Db) {
    super(db, 'groups');
  }

  // @ts-expect-error — `findByName` has no OrgScope parameter.
  findByName(name: string): Promise<string> {
    return Promise.resolve(name);
  }
}

export class OptionalScopeRepository
  extends TenantRepository<'groups'>
  implements TenantRepositoryContract<OptionalScopeRepository>
{
  constructor(db: Db) {
    super(db, 'groups');
  }

  // @ts-expect-error — an optional scope is not enough.
  list(scope?: OrgScope): Promise<number> {
    return Promise.resolve(scope === undefined ? 0 : 1);
  }
}

export class ScopeNotFirstRepository
  extends TenantRepository<'groups'>
  implements TenantRepositoryContract<ScopeNotFirstRepository>
{
  constructor(db: Db) {
    super(db, 'groups');
  }

  // @ts-expect-error — the scope must be the first parameter.
  get(id: string, scope: OrgScope): Promise<string> {
    return Promise.resolve(`${scope.organizationId}/${id}`);
  }
}

// GlobalRepository is limited to the closed global list, TenantRepository to the rest.
export class UsersRepository extends GlobalRepository<'users'> {
  constructor(db: Db) {
    super(db, 'users');
  }
}

// @ts-expect-error — `bases` is a tenant table.
export class GlobalBasesRepository extends GlobalRepository<'bases'> {}

// @ts-expect-error — `sessions` is a global table.
export class TenantSessionsRepository extends TenantRepository<'sessions'> {}

describe('repository typing', () => {
  it('OrgScope carries the organization ID and optional transaction', () => {
    expectTypeOf<OrgScope['organizationId']>().toEqualTypeOf<`org_${string}`>();
    expectTypeOf<OrgScope['tx']>().toEqualTypeOf<Tx | undefined>();
  });

  it('BasesRepository methods take the scope first', () => {
    expectTypeOf<Parameters<BasesRepository['getById']>[0]>().toEqualTypeOf<OrgScope>();
    expectTypeOf<Parameters<BasesRepository['create']>[0]>().toEqualTypeOf<OrgScope>();
    expectTypeOf<Parameters<BasesRepository['listByWorkspace']>[0]>().toEqualTypeOf<OrgScope>();
    expectTypeOf<Parameters<BasesRepository['update']>[0]>().toEqualTypeOf<OrgScope>();
  });
});
