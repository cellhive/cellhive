import { createHash } from 'node:crypto';

import {
  apiTokenViaPresenter,
  AUDIT_BASE_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPE,
  auditRefIdsOf,
  AuditLogsRepository,
  AuditRefsRepository,
  AuditWriter,
  decodeCursor,
  enqueue,
  JobsRepository,
  withTxScope,
  type AppConfig,
  type AuditContext,
  type AuditLogFilter,
  type AuditLogRow,
  type Db,
  type JsonObject,
  type JsonValue,
  type OrgScope,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { CACHE_KEY_PREFIX, cacheCommand } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, CACHE_CLIENT, DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type {
  AuditLogEntryDto,
  AuditLogFilters,
  AuditLogList,
  AuditRefsDto,
  BaseAuditLogFilters,
  BaseAuditLogQuery,
  ExportAuditLogsRequest,
  ExportBaseAuditLogsRequest,
  Id,
  JobAccepted,
  OrgAuditLogQuery,
  RedactAuditLogsRequest,
  RedactAuditLogsResponse,
} from '@cellhive/contracts';
import type { Redis } from 'ioredis';

function objectOf(value: JsonValue | null): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

/** An entry as the admin API returns it (CONTRACTS §11.4): storage-form `before`/`after`. */
export function auditLogEntryDtoOf(row: AuditLogRow): AuditLogEntryDto {
  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name },
    via: objectOf(row.via),
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    base_id: row.base_id,
    table_id: row.table_id,
    batch_id: row.batch_id,
    request_id: row.request_id,
    before: objectOf(row.before),
    after: objectOf(row.after),
    ip: row.ip,
    user_agent: row.user_agent,
  };
}

function filterOf(query: AuditLogFilters): AuditLogFilter {
  return {
    ...(query.actor_id === undefined ? {} : { actorIds: query.actor_id }),
    ...(query.base_id === undefined ? {} : { baseId: query.base_id }),
    ...(query.table_id === undefined ? {} : { tableId: query.table_id }),
    ...(query.entity_type === undefined ? {} : { entityType: query.entity_type }),
    ...(query.entity_id === undefined ? {} : { entityId: query.entity_id }),
    ...(query.action === undefined ? {} : { actions: query.action }),
    ...(query.action_prefix === undefined ? {} : { actionPrefixes: query.action_prefix }),
    ...(query.via === undefined ? {} : { via: query.via }),
    ...(query.batch_id === undefined ? {} : { batchId: query.batch_id }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.to === undefined ? {} : { to: new Date(query.to) }),
  };
}

/** The filter keys of a list query (`cursor`, `limit`, `include` are not filters). */
const FILTER_KEYS = [
  'actor_id',
  'base_id',
  'table_id',
  'entity_type',
  'entity_id',
  'action',
  'action_prefix',
  'via',
  'batch_id',
  'from',
  'to',
] as const satisfies readonly (keyof AuditLogFilters)[];

/**
 * The filters of a query in a canonical form: only the set filters, keys in
 * a fixed order, each list sorted without duplicates, times as ISO
 * 8601 UTC. Two queries asking for the same entries normalise equally, so
 * paging through a result ("Load more") or reordering repeated parameters
 * is the same view.
 */
export function normalizedAuditFilters(query: AuditLogFilters): JsonObject {
  const normalized: Record<string, JsonValue> = {};
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      normalized[key] = [...new Set<string>(value)].sort();
    } else if (key === 'from' || key === 'to') {
      normalized[key] = new Date(value).toISOString();
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

/** How long one `audit.viewed` covers the same viewer, scope and filters (BACKLOG T709). */
export const AUDIT_VIEW_DEDUP_MS = 10 * 60 * 1000;

const auditWriter = new AuditWriter();

type AuditScope =
  | { readonly kind: 'org'; readonly orgId: Id<'org'> }
  | { readonly kind: 'base'; readonly baseId: Id<'bse'> };

/**
 * Audit log admin API (ADR-23 §4–5, CONTRACTS §11.4). Organization lists,
 * exports and redaction need organization owner/admin (redaction: owner
 * only); base lists and exports need base admin. Anyone else who cannot use
 * the log gets `404`, so its existence is not revealed. Reading the log is
 * audited (`audit.viewed`, at most once per viewer, scope and filters every
 * 10 minutes); exports and redactions are audited in the transaction that
 * performs them.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditLogsRepository) private readonly logs: AuditLogsRepository,
    @Inject(AuditRefsRepository) private readonly refs: AuditRefsRepository,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
  ) {}

  async listOrg(
    principal: Principal,
    orgId: Id<'org'>,
    query: OrgAuditLogQuery,
    meta: RequestMeta,
  ): Promise<AuditLogList> {
    const org = await this.requireOrgAdmin(principal, orgId);
    const cursor = decodeCursor(query.cursor);
    await this.recordView(org.scope, principal, meta, { kind: 'org', orgId }, query);
    const page = await this.logs.list(org.scope, filterOf(query), {
      cursor,
      limit: query.limit,
    });
    return this.listOf(page, query.include === 'refs', {
      scope: org.scope,
      principal,
      baseId: null,
      isOrgAdmin: org.isAdmin,
    });
  }

  async listBase(
    principal: Principal,
    baseId: Id<'bse'>,
    query: BaseAuditLogQuery,
    meta: RequestMeta,
  ): Promise<AuditLogList> {
    const base = await this.requireBaseAdmin(principal, baseId);
    const cursor = decodeCursor(query.cursor);
    await this.recordView(base.org.scope, principal, meta, { kind: 'base', baseId }, query);
    const page = await this.logs.list(
      base.org.scope,
      { ...filterOf(query), baseId },
      { cursor, limit: query.limit },
    );
    return this.listOf(page, query.include === 'refs', {
      scope: base.org.scope,
      principal,
      baseId,
      isOrgAdmin: base.org.isAdmin,
    });
  }

  /** `202 { job_id }`: the `audit.export` job, its `meta.jobs` row and `audit.exported`, in one transaction. */
  async export(
    principal: Principal,
    orgId: Id<'org'>,
    body: ExportAuditLogsRequest,
    meta: RequestMeta,
  ): Promise<JobAccepted> {
    const org = await this.requireOrgAdmin(principal, orgId);
    return this.startExport(org.scope, principal, meta, {
      type: AUDIT_EXPORT_JOB_TYPE,
      format: body.format,
      filters: normalizedAuditFilters(body.filters ?? {}),
      baseId: null,
    });
  }

  /**
   * `POST /bases/:id/audit-logs/export` (T709): like the organization
   * export, restricted to the base (`filters.base_id`, set here and never
   * from the body), as an `audit.base_export` job.
   */
  async exportBase(
    principal: Principal,
    baseId: Id<'bse'>,
    body: ExportBaseAuditLogsRequest,
    meta: RequestMeta,
  ): Promise<JobAccepted> {
    const base = await this.requireBaseAdmin(principal, baseId);
    const filters: BaseAuditLogFilters = body.filters ?? {};
    return this.startExport(base.org.scope, principal, meta, {
      type: AUDIT_BASE_EXPORT_JOB_TYPE,
      format: body.format,
      filters: { ...normalizedAuditFilters(filters), base_id: baseId },
      baseId,
    });
  }

  /** Organization owner only; never the caller's own entries nor `audit.*` (ADR-23 §5). */
  async redact(
    principal: Principal,
    orgId: Id<'org'>,
    body: RedactAuditLogsRequest,
    meta: RequestMeta,
  ): Promise<RedactAuditLogsResponse> {
    // Admins can see the log, so they learn they may not redact it (403);
    // anyone else cannot see it at all (404).
    const org = await this.requireOrgAdmin(principal, orgId);
    if (org.role !== 'owner') {
      throw permissionDenied('Only organization owners can redact the audit log.');
    }
    const redacted = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      const count = await this.logs.redact(
        scope,
        principal.userId,
        'user_id' in body
          ? { userId: body.user_id }
          : { entityType: body.entity_type, entityIds: body.entity_ids },
      );
      // The request itself, without any value (ADR-23 §5).
      await auditWriter.write(tx, {
        action: 'audit.redacted',
        organizationId: orgId,
        entityType: 'user_id' in body ? 'user' : 'org',
        entityId: 'user_id' in body ? body.user_id : orgId,
        after:
          'user_id' in body
            ? { user_id: body.user_id, redacted: count }
            : { entity_type: body.entity_type, entity_ids: [...body.entity_ids], redacted: count },
        context: this.contextOf(principal, meta),
      });
      return count;
    });
    return { redacted };
  }

  // -------------------------------------------------------------------------

  /** Organization owner/admin; anyone else gets `404` (CONTRACTS §11.4). */
  private async requireOrgAdmin(principal: Principal, orgId: Id<'org'>) {
    const org = await this.access.findOrg(principal, orgId);
    if (org?.isAdmin !== true) throw notFound();
    return org;
  }

  /** Base admin; anyone else, members who can read the base included, gets `404`. */
  private async requireBaseAdmin(principal: Principal, baseId: Id<'bse'>) {
    const base = await this.access.findBase(principal, baseId);
    if (base === undefined || !base.access.is_admin) throw notFound();
    return base;
  }

  private contextOf(principal: Principal, meta: RequestMeta): AuditContext {
    return auditContextOf(meta, { type: 'user', id: principal.userId });
  }

  /** The job, its `audit.export` task and `audit.exported`, in one transaction. */
  private async startExport(
    scope: OrgScope,
    principal: Principal,
    meta: RequestMeta,
    input: {
      readonly type: string;
      readonly format: 'csv';
      readonly filters: JsonObject;
      readonly baseId: Id<'bse'> | null;
    },
  ): Promise<JobAccepted> {
    const jobId = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const job = await this.jobs.create(txScope, {
        type: input.type,
        createdBy: principal.userId,
      });
      await enqueue(tx, 'audit.export', {
        organization_id: scope.organizationId,
        job_id: job.id,
        filters: input.filters as Record<string, string | string[]>,
      });
      await auditWriter.write(tx, {
        action: 'audit.exported',
        organizationId: scope.organizationId,
        baseId: input.baseId,
        entityType: 'job',
        entityId: job.id,
        after: { format: input.format, filters: input.filters },
        context: this.contextOf(principal, meta),
      });
      return job.id;
    });
    return { job_id: jobId };
  }

  private async listOf(
    page: { readonly items: AuditLogRow[]; readonly nextCursor: string | null },
    withRefs: boolean,
    viewer: {
      readonly scope: OrgScope;
      readonly principal: Principal;
      readonly baseId: Id<'bse'> | null;
      readonly isOrgAdmin: boolean;
    },
  ): Promise<AuditLogList> {
    // API tokens of other users stay anonymous for a base admin who is not an
    // organization admin (S6 decision #19) — in `via` and so in `refs`.
    const viaOf = await apiTokenViaPresenter(this.refs, viewer.scope, page.items, {
      userId: viewer.principal.userId,
      isOrgAdmin: viewer.isOrgAdmin,
    });
    const rows = page.items.map((row) => ({ ...row, via: viaOf(row) }));
    return {
      items: rows.map(auditLogEntryDtoOf),
      next_cursor: page.nextCursor,
      retention_days: this.config.limits.auditRetentionDays,
      ...(withRefs ? { refs: await this.refsOf(rows, viewer) } : {}),
    };
  }

  /**
   * `refs` of a page (CONTRACTS §11.4): one lookup per kind, for the ids of
   * the page only; the base route names fields and tables of its base only.
   * An API token's name is shown to organization owners/admins and to the
   * token's owner (S6 decision #19); `null` otherwise and once it is gone.
   */
  private async refsOf(
    rows: readonly AuditLogRow[],
    viewer: {
      readonly scope: OrgScope;
      readonly principal: Principal;
      readonly baseId: Id<'bse'> | null;
      readonly isOrgAdmin: boolean;
    },
  ): Promise<AuditRefsDto> {
    const ids = auditRefIdsOf(rows);
    const [users, fields, tables, tokens] = await Promise.all([
      this.refs.users(viewer.scope, ids.users),
      this.refs.fields(viewer.scope, ids.fields, viewer.baseId),
      this.refs.tables(viewer.scope, ids.tables, viewer.baseId),
      this.refs.apiTokens(viewer.scope, ids.apiTokens),
    ]);
    const userNames = new Map(users.map((user) => [user.id as string, user.display_name]));
    const tokenById = new Map(tokens.map((token) => [token.id as string, token]));
    return {
      users: Object.fromEntries(
        ids.users.map((id) => [id, { display_name: userNames.get(id) ?? null }]),
      ),
      fields: Object.fromEntries(
        fields.map((field) => [
          field.id,
          { name: field.name, table_id: field.table_id, deleted: field.deleted },
        ]),
      ),
      tables: Object.fromEntries(
        tables.map((table) => [table.id, { name: table.name, deleted: table.deleted }]),
      ),
      api_tokens: Object.fromEntries(
        ids.apiTokens.map((id) => {
          const token = tokenById.get(id);
          const named =
            token !== undefined && (viewer.isOrgAdmin || token.user_id === viewer.principal.userId);
          return [id, { name: named ? token.name : null }];
        }),
      ),
    };
  }

  /**
   * `audit.viewed` at most once per viewer, scope and normalised filters
   * every 10 minutes (BACKLOG T709): a Valkey key set with `NX` decides;
   * further pages of the same view ("Load more") carry the same filters and
   * write nothing. When Valkey cannot answer, the view is written anyway
   * (an extra entry beats a missing one).
   */
  private async recordView(
    scope: OrgScope,
    principal: Principal,
    meta: RequestMeta,
    target: AuditScope,
    query: AuditLogFilters,
  ): Promise<void> {
    const entityId = target.kind === 'org' ? target.orgId : target.baseId;
    const filters = normalizedAuditFilters(query);
    const digest = createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 32);
    const key = `${CACHE_KEY_PREFIX}audit:viewed:${principal.userId}:${target.kind}:${entityId}:${digest}`;
    let first = true;
    try {
      const set = await cacheCommand(this.cache, (client) =>
        client.set(key, '1', 'PX', AUDIT_VIEW_DEDUP_MS, 'NX'),
      );
      first = set === 'OK';
    } catch (error) {
      this.logger.warn(
        { err: error, org_id: scope.organizationId },
        'audit.viewed: Valkey unavailable, writing the view without deduplication',
      );
    }
    if (!first) return;
    try {
      await this.db.withTx(async (tx) => {
        await auditWriter.write(tx, {
          action: 'audit.viewed',
          organizationId: scope.organizationId,
          baseId: target.kind === 'base' ? target.baseId : null,
          entityType: target.kind,
          entityId,
          context: this.contextOf(principal, meta),
        });
      });
    } catch (error) {
      // Let the next request write it instead.
      await this.cache.del(key).catch(() => undefined);
      throw error;
    }
  }
}
