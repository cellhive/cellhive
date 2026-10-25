import { BasesRepository, orgScope, type Db } from '../../src/db/index.js';

import type { Id } from '@cellhive/contracts';

export interface SeededTenant {
  readonly orgId: Id<'org'>;
  readonly userId: Id<'usr'>;
  readonly workspaceId: Id<'wsp'>;
  readonly baseId: Id<'bse'>;
}

/** 16 base62 characters derived from the organization id (stable, unique per org). */
function suffix(orgId: Id<'org'>): string {
  return orgId.slice(4);
}

/**
 * An organization with one user, one workspace and one base, as the
 * services under test expect them. `collation` goes to `settings.collation`.
 */
export async function seedTenant(
  db: Db,
  orgId: Id<'org'>,
  options: { readonly collation?: string } = {},
): Promise<SeededTenant> {
  const key = suffix(orgId);
  const userId: Id<'usr'> = `usr_${key}`;
  const workspaceId: Id<'wsp'> = `wsp_${key}`;
  await db.withTx(async (tx) => {
    await tx
      .insertInto('meta.organizations')
      .values({ id: orgId, name: key, slug: key.toLowerCase() })
      .execute();
    await tx
      .insertInto('meta.users')
      .values({ id: userId, email: `${key.toLowerCase()}@example.test`, display_name: key })
      .execute();
    await tx
      .insertInto('meta.workspaces')
      .values({ id: workspaceId, organization_id: orgId, name: key, slug: 'main' })
      .execute();
  });
  const base = await new BasesRepository(db).create(orgScope(orgId), {
    workspaceId,
    ownerId: userId,
    name: `Base ${key}`,
    ...(options.collation === undefined ? {} : { settings: { collation: options.collation } }),
  });
  return { orgId, userId, workspaceId, baseId: base.id };
}
