import { sql } from 'kysely';

import {
  orgScope,
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { HttpAllowlistRow, HttpAllowlistTable } from '../db/schema.js';
import type { OutboundAllowlistEntry } from '../net/resolve-target.js';
import type { Id } from '@cellhive/contracts';
import type { Insertable } from 'kysely';

export type NewHttpAllowlistEntry = Omit<
  Insertable<HttpAllowlistTable>,
  'organization_id' | 'created_at'
>;

/** An entry with the name of who added it (`null` when that member left). */
export type HttpAllowlistListRow = HttpAllowlistRow & { readonly created_by_name: string | null };

/**
 * `meta.http_allowlist` (BACKLOG T600, ADR-35 §3). Every query is scoped by
 * `organization_id`: an entry of another organization behaves exactly like
 * a missing one, and the SSRF guard of one organization never sees the
 * entries of another.
 */
export class HttpAllowlistRepository
  extends TenantRepository<'http_allowlist'>
  implements TenantRepositoryContract<HttpAllowlistRepository>
{
  constructor(db: Db) {
    super(db, 'http_allowlist');
  }

  async create(scope: OrgScope, input: NewHttpAllowlistEntry): Promise<HttpAllowlistRow> {
    return this.executor(scope)
      .insertInto('meta.http_allowlist')
      .values({ ...input, organization_id: scope.organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(
    scope: OrgScope,
    id: Id<'hal'>,
    options: { forUpdate?: boolean } = {},
  ): Promise<HttpAllowlistRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.http_allowlist')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Every entry, by pattern (byte order: stable across collations), with its creator's name. */
  async list(scope: OrgScope): Promise<HttpAllowlistListRow[]> {
    return this.executor(scope)
      .selectFrom('meta.http_allowlist as a')
      .leftJoin('meta.users as u', 'u.id', 'a.created_by')
      .selectAll('a')
      .select('u.display_name as created_by_name')
      .where('a.organization_id', '=', scope.organizationId)
      .orderBy(sql`a.pattern COLLATE "C"`)
      .orderBy('a.id')
      .execute();
  }

  async count(scope: OrgScope): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.http_allowlist')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async delete(scope: OrgScope, id: Id<'hal'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.http_allowlist')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** What the SSRF guard matches (`resolveOutboundTarget`). */
  async entries(scope: OrgScope): Promise<OutboundAllowlistEntry[]> {
    return this.executor(scope)
      .selectFrom('meta.http_allowlist')
      .select(['host', 'wildcard', 'port'])
      .where('organization_id', '=', scope.organizationId)
      .execute();
  }
}

/**
 * The allowlist source of `resolveOutboundTarget` backed by the database:
 * the organization's entries, read only when a URL needs them.
 */
export function httpAllowlistSource(
  db: Db,
): (organizationId: Id<'org'>) => Promise<OutboundAllowlistEntry[]> {
  const repository = new HttpAllowlistRepository(db);
  return (organizationId) => repository.entries(orgScope(organizationId));
}
