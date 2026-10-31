import {
  auditActionsOfPrefix,
  type AuditActionPrefix,
  type AuditViaKind,
  type Id,
} from '@cellhive/contracts';
import { sql, type RawBuilder, type SqlBool } from 'kysely';

import { afterCursor, cursorTimestamp, pageWithCursor, type KeysetCursor } from '../db/cursor.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { ActorType, JsonValue } from '../db/schema.js';

/** An audit entry as the read APIs need it (ADR-23, CONTRACTS §11). */
export interface AuditLogRow {
  readonly id: Id<'aud'>;
  readonly organization_id: Id<'org'> | null;
  readonly base_id: Id<'bse'> | null;
  readonly table_id: Id<'tbl'> | null;
  readonly actor_type: ActorType;
  readonly actor_id: string | null;
  /**
   * Display name of the actor (CONTRACTS §11.1): a user's display name
   * (`null` once deleted); for a share link, the current name of its target
   * view/form (`null` once deleted); `null` for other actors.
   */
  readonly actor_name: string | null;
  /** Share link actors: the target view/form of the link, else `null`. */
  readonly actor_view_id: Id<'viw'> | null;
  readonly via: JsonValue | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly batch_id: string | null;
  readonly request_id: string | null;
  readonly before: JsonValue | null;
  readonly after: JsonValue | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly created_at: Date;
  /** `created_at` with microseconds, for the keyset cursor. */
  readonly cursor_at: string;
}

export interface AuditLogPage {
  readonly items: AuditLogRow[];
  readonly nextCursor: string | null;
}

/**
 * Filters of the audit log admin API (CONTRACTS §11.4); all optional.
 * Different filters combine with AND, the values of one list with OR; an
 * empty list matches nothing.
 */
export interface AuditLogFilter {
  readonly actorIds?: readonly string[];
  readonly baseId?: Id<'bse'>;
  readonly tableId?: Id<'tbl'>;
  readonly entityType?: string;
  readonly entityId?: string;
  /** Exact actions. */
  readonly actions?: readonly string[];
  /** Closed action groups (`record.`, …): each stands for the catalogue actions it starts. */
  readonly actionPrefixes?: readonly AuditActionPrefix[];
  readonly via?: readonly AuditViaKind[];
  readonly batchId?: string;
  /** Inclusive. */
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
}

/** `via` key of each source of the `via` filter (CONTRACTS §11.1). */
const VIA_KEYS: Readonly<Record<AuditViaKind, string>> = {
  api_token: 'api_token_id',
  automation: 'automation_id',
  share_link: 'share_link_id',
  import: 'import_job_id',
  mcp: 'mcp',
};

/**
 * The exact actions `filter` allows, `undefined` = any. Action groups expand
 * to the catalogue actions they start (an equality list the action index
 * can serve, unlike `LIKE` under a non-C collation); with both `actions`
 * and `actionPrefixes`, an action must satisfy both.
 */
export function auditActionsOf(filter: AuditLogFilter): readonly string[] | undefined {
  const exact = filter.actions === undefined ? undefined : [...new Set(filter.actions)];
  if (filter.actionPrefixes === undefined) return exact;
  const grouped = new Set<string>(
    filter.actionPrefixes.flatMap((prefix) => auditActionsOfPrefix(prefix)),
  );
  return exact === undefined ? [...grouped] : exact.filter((action) => grouped.has(action));
}

/** `column = value`, or `column = ANY(values)` for several, or false for none. */
function oneOf(column: RawBuilder<unknown>, values: readonly string[]): RawBuilder<SqlBool> {
  if (values.length === 0) return sql<SqlBool>`false`;
  if (values.length === 1) return sql<SqlBool>`${column} = ${values[0]}`;
  return sql<SqlBool>`${column} = ANY(${sql.val([...values])}::text[])`;
}

/** SQL conditions on `meta.audit_logs AS a` of an admin filter (organization excluded). */
function auditFilterConditions(filter: AuditLogFilter): RawBuilder<SqlBool>[] {
  const conditions: RawBuilder<SqlBool>[] = [];
  const equal = (column: string, value: string | undefined) => {
    if (value !== undefined) conditions.push(sql<SqlBool>`${sql.ref(`a.${column}`)} = ${value}`);
  };
  if (filter.actorIds !== undefined) {
    conditions.push(oneOf(sql`a.actor_id`, [...new Set(filter.actorIds)]));
  }
  equal('base_id', filter.baseId);
  equal('table_id', filter.tableId);
  equal('entity_type', filter.entityType);
  equal('entity_id', filter.entityId);
  const actions = auditActionsOf(filter);
  if (actions !== undefined) conditions.push(oneOf(sql`a.action`, actions));
  if (filter.via !== undefined) {
    const keys = [...new Set(filter.via.map((kind) => VIA_KEYS[kind]))];
    conditions.push(
      keys.length === 0 ? sql<SqlBool>`false` : sql<SqlBool>`a.via ?| ${sql.val(keys)}::text[]`,
    );
  }
  equal('batch_id', filter.batchId);
  if (filter.from !== undefined) {
    conditions.push(sql<SqlBool>`a.created_at >= ${filter.from.toISOString()}::timestamptz`);
  }
  if (filter.to !== undefined) {
    conditions.push(sql<SqlBool>`a.created_at < ${filter.to.toISOString()}::timestamptz`);
  }
  return conditions;
}

export interface RecordHistoryFilter {
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
  /**
   * Field ids the viewer can read now. An entry that changed fields but none
   * of these is left out (ADR-23 §4); deletes, restores and entries without
   * any field stay.
   */
  readonly visibleFieldIds: readonly string[];
  /** Only entries that changed this field (`?field=`). */
  readonly fieldId?: string;
}

export interface PageRequest {
  readonly cursor: KeysetCursor | null;
  readonly limit: number;
}

/** `meta.audit_redact` by entity or by user (ADR-23 §5). */
export type AuditRedaction =
  | { readonly entityType: string; readonly entityIds: readonly string[] }
  | { readonly userId: Id<'usr'> };

const RECORD_ACTIONS_WITHOUT_FIELDS = ['record.deleted', 'record.restored'];

/**
 * Reads of `meta.audit_logs` (ADR-23). Writes stay with `AuditWriter`
 * (append-only); the only change is redaction through `meta.audit_redact`.
 * Every query is bound to `scope.organizationId`, so an entry of another
 * organization is never returned nor counted.
 */
export class AuditLogsRepository
  extends TenantRepository<'audit_logs'>
  implements TenantRepositoryContract<AuditLogsRepository>
{
  constructor(db: Db) {
    super(db, 'audit_logs');
  }

  /** One entry of the organization, or `undefined`. */
  async getById(scope: OrgScope, id: string): Promise<AuditLogRow | undefined> {
    const { rows } = await sql<AuditLogRow>`
      ${this.selectEntries(scope)}
         AND a.id = ${id}
       LIMIT 1
    `.execute(this.executor(scope));
    return rows[0];
  }

  /**
   * History of one record, newest first (`audit_logs_entity_idx`): its
   * `record.*` entries in `tableId`, filtered in SQL by field visibility so
   * that pages stay full.
   */
  async listRecordHistory(
    scope: OrgScope,
    filter: RecordHistoryFilter,
    page: PageRequest,
  ): Promise<AuditLogPage> {
    const changed = sql`(coalesce(a.before, '{}'::jsonb) || coalesce(a.after, '{}'::jsonb))`;
    const conditions: RawBuilder<SqlBool>[] = [
      sql<SqlBool>`a.entity_type = 'record'`,
      sql<SqlBool>`a.entity_id = ${filter.recordId}`,
      sql<SqlBool>`a.table_id = ${filter.tableId}`,
      sql<SqlBool>`a.action LIKE 'record.%'`,
    ];
    if (filter.fieldId !== undefined) {
      conditions.push(sql<SqlBool>`${changed} ? ${filter.fieldId}`);
    } else {
      conditions.push(sql<SqlBool>`(
        a.action = ANY(${sql.val(RECORD_ACTIONS_WITHOUT_FIELDS)}::text[])
        OR ${changed} = '{}'::jsonb
        OR ${changed} ?| ${sql.val([...filter.visibleFieldIds])}::text[]
      )`);
    }
    return this.page(scope, conditions, page);
  }

  /**
   * Number of `record` entries per batch id (ADR-23: "A edited 500 cells").
   * Uses `audit_logs_batch_idx`.
   */
  async countRecordBatches(
    scope: OrgScope,
    batchIds: readonly string[],
  ): Promise<Map<string, number>> {
    const ids = [...new Set(batchIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.executor(scope)
      .selectFrom('meta.audit_logs')
      .select(['batch_id', (eb) => eb.fn.countAll<bigint>().as('count')])
      .where('organization_id', '=', scope.organizationId)
      .where('entity_type', '=', 'record')
      .where(sql<SqlBool>`batch_id = ANY(${sql.val(ids)}::text[])`)
      .groupBy('batch_id')
      .execute();
    return new Map(rows.map((row) => [row.batch_id ?? '', Number(row.count)]));
  }

  /**
   * The organization's entries matching `filter`, newest first. A keyset
   * page on `(created_at, id)`: the planner picks the index of the most
   * selective filter (`audit_logs_actor_idx`, `audit_logs_action_idx`,
   * `audit_logs_base_idx`, `audit_logs_entity_idx`, … or
   * `audit_logs_org_created_idx`), and `from`/`to` prune the monthly
   * partitions.
   */
  async list(scope: OrgScope, filter: AuditLogFilter, page: PageRequest): Promise<AuditLogPage> {
    return this.page(scope, auditFilterConditions(filter), page);
  }

  /**
   * The base an `audit.base_export` job exports (`base_id` of its
   * `audit.exported` entry, written with the job), or `null`. Uses
   * `audit_logs_entity_idx`.
   */
  async exportedBaseOf(scope: OrgScope, jobId: Id<'job'>): Promise<Id<'bse'> | null> {
    const row = await this.executor(scope)
      .selectFrom('meta.audit_logs')
      .select('base_id')
      .where('organization_id', '=', scope.organizationId)
      .where('entity_type', '=', 'job')
      .where('entity_id', '=', jobId)
      .where('action', '=', 'audit.exported')
      .limit(1)
      .executeTakeFirst();
    return row?.base_id ?? null;
  }

  /**
   * Whether a record of the table was created or updated with a value for
   * `fieldId` since `since` (T403: a revert keeping later edits re-checks,
   * under the schema lock, that nobody wrote the field after it merged the
   * edits).
   */
  async hasRecordFieldChangesSince(
    scope: OrgScope,
    input: {
      readonly tableId: Id<'tbl'>;
      readonly fieldId: Id<'fld'>;
      /** A `Date`, or database time as text (microseconds kept). */
      readonly since: Date | string;
    },
  ): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.audit_logs')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', input.tableId)
      .where(sql<SqlBool>`created_at >= ${input.since}::timestamptz`)
      .where('action', 'in', ['record.created', 'record.updated'])
      // A redacted entry cannot prove the field untouched: fail safe.
      .where(sql<SqlBool>`((after ? ${input.fieldId}) OR (after = '{"redacted": true}'::jsonb))`)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Records among `recordIds` whose audit trail since `since` **proves**
   * that `fieldId` was not written (T403 revert fail-safe): at least one
   * `record.*` entry since then, none naming the field, none redacted. A
   * record with no entry (missing trail) or a redacted one is not proven.
   */
  async recordsProvablyUntouched(
    scope: OrgScope,
    input: {
      readonly tableId: Id<'tbl'>;
      readonly fieldId: Id<'fld'>;
      readonly recordIds: readonly string[];
      readonly since: Date;
    },
  ): Promise<Set<string>> {
    if (input.recordIds.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.audit_logs')
      .select((eb) => [
        'entity_id',
        eb.fn
          .countAll<bigint>()
          .filterWhere(
            sql<SqlBool>`((after ? ${input.fieldId}) OR (before ? ${input.fieldId}) OR (after = '{"redacted": true}'::jsonb) OR (before = '{"redacted": true}'::jsonb))`,
          )
          .as('unsafe'),
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', input.tableId)
      .where('entity_type', '=', 'record')
      .where('entity_id', 'in', [...input.recordIds])
      .where('created_at', '>=', input.since)
      .where('action', 'like', 'record.%')
      .groupBy('entity_id')
      .execute();
    return new Set(
      rows
        .filter((row) => row.entity_id !== null && Number(row.unsafe) === 0)
        .map((row) => row.entity_id as string),
    );
  }

  /**
   * Records among `recordIds` whose audit trail since `since` names
   * `fieldId` or was redacted (T404 revert of a link `to_single`: those
   * cells may have been edited and keep their value). Link writes always
   * leave an entry on the record whose cell changed (both sides, ADR-23),
   * so a record with no entry since `since` was not written there.
   */
  async recordsWithFieldChangesSince(
    scope: OrgScope,
    input: {
      readonly tableId: Id<'tbl'>;
      readonly fieldId: Id<'fld'>;
      readonly recordIds: readonly string[];
      readonly since: Date;
    },
  ): Promise<Set<string>> {
    if (input.recordIds.length === 0) return new Set();
    const rows = await this.executor(scope)
      .selectFrom('meta.audit_logs')
      .select('entity_id')
      .distinct()
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', input.tableId)
      .where('entity_type', '=', 'record')
      .where('entity_id', 'in', [...input.recordIds])
      .where('created_at', '>', input.since)
      .where('action', 'like', 'record.%')
      .where(
        sql<SqlBool>`((after ? ${input.fieldId}) OR (before ? ${input.fieldId}) OR (after = '{"redacted": true}'::jsonb) OR (before = '{"redacted": true}'::jsonb))`,
      )
      .execute();
    return new Set(rows.flatMap((row) => (row.entity_id === null ? [] : [row.entity_id])));
  }

  /**
   * `meta.audit_redact` (ADR-23 §5) for the organization: never touches
   * entries whose actor is `requestedBy` nor `audit.*` entries. Returns the
   * number of rows changed.
   */
  async redact(
    scope: OrgScope,
    requestedBy: Id<'usr'>,
    redaction: AuditRedaction,
  ): Promise<number> {
    const call =
      'userId' in redaction
        ? sql<{ n: bigint }>`SELECT meta.audit_redact(
            p_organization_id => ${scope.organizationId}::text,
            p_requested_by => ${requestedBy}::text,
            p_user_id => ${redaction.userId}::text
          ) AS n`
        : sql<{ n: bigint }>`SELECT meta.audit_redact(
            p_organization_id => ${scope.organizationId}::text,
            p_requested_by => ${requestedBy}::text,
            p_entity_type => ${redaction.entityType}::text,
            p_entity_ids => ${sql.val([...redaction.entityIds])}::text[]
          ) AS n`;
    const { rows } = await call.execute(this.executor(scope));
    return Number(rows[0]?.n ?? 0);
  }

  // -------------------------------------------------------------------------

  private selectEntries(scope: OrgScope): RawBuilder<unknown> {
    return sql`
      SELECT a.id, a.organization_id, a.base_id, a.table_id, a.actor_type, a.actor_id,
             CASE
               WHEN a.actor_type = 'user' THEN
                 CASE WHEN u.status = 'deleted' THEN NULL ELSE u.display_name END
               WHEN a.actor_type = 'share_link' THEN sv.name
             END AS actor_name,
             sv.id AS actor_view_id,
             a.via, a.action, a.entity_type, a.entity_id, a.batch_id, a.request_id,
             a.before, a.after, host(a.ip) AS ip, a.user_agent, a.created_at,
             ${cursorTimestamp(sql`a.created_at`)} AS cursor_at
        FROM meta.audit_logs AS a
        LEFT JOIN meta.users AS u ON a.actor_type = 'user' AND u.id = a.actor_id
        LEFT JOIN meta.share_links AS sl
               ON a.actor_type = 'share_link' AND sl.organization_id = a.organization_id
              AND sl.id = a.actor_id
        LEFT JOIN meta.views AS sv
               ON sv.organization_id = sl.organization_id AND sv.id = sl.target_id
              AND sl.target_type IN ('view', 'form')
       WHERE a.organization_id = ${scope.organizationId}`;
  }

  private async page(
    scope: OrgScope,
    conditions: readonly RawBuilder<SqlBool>[],
    page: PageRequest,
  ): Promise<AuditLogPage> {
    const all = [...conditions];
    if (page.cursor !== null) all.push(afterCursor(sql`a.created_at`, sql`a.id`, page.cursor));
    const where = all.length === 0 ? sql`` : sql` AND ${sql.join(all, sql` AND `)}`;
    const { rows } = await sql<AuditLogRow>`
      ${this.selectEntries(scope)}${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${page.limit + 1}
    `.execute(this.executor(scope));
    const { items, nextCursor } = pageWithCursor(rows, page.limit, (row) => ({
      at: row.cursor_at,
      id: row.id,
    }));
    return { items, nextCursor };
  }
}
