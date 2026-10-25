import { sql, type SqlBool } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { AuditLogRow } from './audit-logs.repository.js';
import type { Db } from '../db/create-db.js';
import type { JsonValue } from '../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** Ids an audit page refers to, by kind (`include=refs`, CONTRACTS §11.4). */
export interface AuditRefIds {
  readonly users: readonly string[];
  readonly fields: readonly string[];
  readonly tables: readonly string[];
  readonly apiTokens: readonly string[];
}

const FIELD_ID = /^fld_[A-Za-z0-9]+$/;

function objectOf(value: JsonValue | null): Record<string, JsonValue> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * The ids the entries of a page carry, and only those (CONTRACTS §11.4):
 * user actors and `user` entities; field ids keying `before`/`after` of
 * record entries and `field` entities; `table_id` and `table` entities;
 * `via.api_token_id` and `api_token` entities. Values inside `before`/`after`
 * are never read as ids (a text cell may hold any string).
 */
export function auditRefIdsOf(rows: readonly AuditLogRow[]): AuditRefIds {
  const users = new Set<string>();
  const fields = new Set<string>();
  const tables = new Set<string>();
  const apiTokens = new Set<string>();
  for (const row of rows) {
    if (row.actor_type === 'user' && row.actor_id !== null) users.add(row.actor_id);
    if (row.table_id !== null) tables.add(row.table_id);
    const via = objectOf(row.via);
    if (typeof via?.['api_token_id'] === 'string') apiTokens.add(via['api_token_id']);
    if (row.entity_id !== null) {
      if (row.entity_type === 'user') users.add(row.entity_id);
      if (row.entity_type === 'field') fields.add(row.entity_id);
      if (row.entity_type === 'table') tables.add(row.entity_id);
      if (row.entity_type === 'api_token') apiTokens.add(row.entity_id);
    }
    if (row.entity_type === 'record') {
      for (const side of [row.before, row.after]) {
        for (const key of Object.keys(objectOf(side) ?? {})) {
          if (FIELD_ID.test(key)) fields.add(key);
        }
      }
    }
  }
  return {
    users: [...users],
    fields: [...fields],
    tables: [...tables],
    apiTokens: [...apiTokens],
  };
}

export interface AuditUserRef {
  readonly id: Id<'usr'>;
  /** `null` once the user is deleted. */
  readonly display_name: string | null;
}

export interface AuditFieldRef {
  readonly id: Id<'fld'>;
  readonly name: string;
  readonly table_id: Id<'tbl'>;
  readonly deleted: boolean;
}

export interface AuditTableRef {
  readonly id: Id<'tbl'>;
  readonly name: string;
  readonly deleted: boolean;
}

export interface AuditApiTokenRef {
  readonly id: Id<'tok'>;
  readonly name: string;
  readonly user_id: Id<'usr'>;
}

/**
 * Name lookups for `include=refs` of the audit log (CONTRACTS §11.4): one
 * query per kind, each bound to `scope.organizationId`. `baseId` limits
 * fields and tables to one base (the base route never names another base's
 * schema).
 */
export class AuditRefsRepository
  extends TenantRepository<'audit_logs'>
  implements TenantRepositoryContract<AuditRefsRepository>
{
  constructor(db: Db) {
    super(db, 'audit_logs');
  }

  /**
   * Users among `ids` that belong to the organization or appear as actor
   * in its audit log (`audit_logs_actor_idx`): a user of another
   * organization only is never named.
   */
  async users(scope: OrgScope, ids: readonly string[]): Promise<AuditUserRef[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<AuditUserRef>`
      SELECT u.id,
             CASE WHEN u.status = 'deleted' THEN NULL ELSE u.display_name END AS display_name
        FROM meta.users AS u
       WHERE u.id = ANY(${sql.val([...ids])}::text[])
         AND (
           EXISTS (SELECT 1 FROM meta.org_members AS m
                    WHERE m.organization_id = ${scope.organizationId} AND m.user_id = u.id)
           OR EXISTS (SELECT 1 FROM meta.audit_logs AS a
                       WHERE a.organization_id = ${scope.organizationId} AND a.actor_id = u.id)
         )
    `.execute(this.executor(scope));
    return rows;
  }

  async fields(
    scope: OrgScope,
    ids: readonly string[],
    baseId: Id<'bse'> | null,
  ): Promise<AuditFieldRef[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<AuditFieldRef>`
      SELECT f.id, f.name, f.table_id, (f.deleted_at IS NOT NULL) AS deleted
        FROM meta.fields AS f
        JOIN meta.tables AS t ON t.organization_id = f.organization_id AND t.id = f.table_id
       WHERE f.organization_id = ${scope.organizationId}
         AND f.id = ANY(${sql.val([...ids])}::text[])
         AND ${baseId === null ? sql<SqlBool>`true` : sql<SqlBool>`t.base_id = ${baseId}`}
    `.execute(this.executor(scope));
    return rows;
  }

  async tables(
    scope: OrgScope,
    ids: readonly string[],
    baseId: Id<'bse'> | null,
  ): Promise<AuditTableRef[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<AuditTableRef>`
      SELECT t.id, t.name, (t.deleted_at IS NOT NULL) AS deleted
        FROM meta.tables AS t
       WHERE t.organization_id = ${scope.organizationId}
         AND t.id = ANY(${sql.val([...ids])}::text[])
         AND ${baseId === null ? sql<SqlBool>`true` : sql<SqlBool>`t.base_id = ${baseId}`}
    `.execute(this.executor(scope));
    return rows;
  }

  async apiTokens(scope: OrgScope, ids: readonly string[]): Promise<AuditApiTokenRef[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.api_tokens')
      .select(['id', 'name', 'user_id'])
      .where('organization_id', '=', scope.organizationId)
      .where(sql<SqlBool>`id = ANY(${sql.val([...ids])}::text[])`)
      .execute();
  }
}
