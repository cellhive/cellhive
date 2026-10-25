import {
  sharedFieldOptions,
  SHARE_UNLOCK_MAX_FAILURES,
  SHARE_UNLOCK_TTL_SECONDS,
  SHARE_UNLOCK_WINDOW_SECONDS,
  DASHBOARD_LINK,
  type FieldTypeName,
  type Id,
  type RecordReadParams,
  type ShareMeta,
  type ShareRecordGetQuery,
  type ShareRecordGroupCountsRequest,
  type ShareRecordQueryRequest,
  type ShareRecordSummariesRequest,
  type ShareUnlockRequest,
  type ProblemErrorItem,
  type ShareUnlockResponse,
  type SharedViewConfigDto,
} from '@cellhive/contracts';
import {
  AuditWriter,
  FieldsRepository,
  RecordQueryService,
  colorRuleFieldIds,
  restrictViewConfig,
  storedViewConfigOf,
  TablesRepository,
  type Db,
  type RecordGroupCountsOutput,
  type RecordListOutput,
  type RecordOutput,
  type RecordSummariesOutput,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { PasswordHasher } from '../../common/auth/password/password-hasher.js';
import { auditContextOf, requestMetaOf } from '../../common/auth/request-meta.js';
import { SessionService } from '../../common/auth/session.service.js';
import { iso } from '../../common/dto.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { DB } from '../../common/tokens.js';
import { isDashboardLink } from '../share-link/share-link-resolver.service.js';

import { ShareAccessStats } from './share-access-stats.js';
import { ShareAccessService, type OpenedShare } from './share-access.service.js';
import { sharedComputedParts, sharedResultKind } from './share-computed.js';
import { isHiddenQuestion } from './share-form-questions.js';
import { ShareUnlockCookies } from './share-unlock-cookies.js';
import { ShareUnlockThrottle } from './share-unlock-throttle.js';
import {
  COMPUTED_ATTACHMENTS,
  COMPUTED_RECORDS,
  redactSharedRecord,
  redactUsers,
  type ShareValueContext,
} from './share-values.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

function notFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

export { redactSharedRecord };

/**
 * Read-only access to a view through its share link (SPEC §15A, CONTRACTS
 * §16A; BACKLOG T305): meta, record query, record detail and unlock. Every
 * read goes through `RecordQueryService` with the link's record access,
 * `view_id` = the link's view and `viewScope: 'share_link'` (view filter
 * always applied and fail-closed, fields hidden in the view never
 * reachable). No realtime; files: `ShareFileService` (T409); export:
 * `ShareExportService` (T810).
 */
@Injectable()
export class ShareService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ShareAccessService) private readonly shares: ShareAccessService,
    @Inject(ShareAccessStats) private readonly stats: ShareAccessStats,
    @Inject(ShareUnlockCookies) private readonly cookies: ShareUnlockCookies,
    @Inject(ShareUnlockThrottle) private readonly throttle: ShareUnlockThrottle,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * `GET /shares/:token/meta`. A dashboard link has no view: `404` with
   * `errors[0].code = DASHBOARD_LINK` once every check passed, so that the
   * page reads `GET /shares/:token/dashboard` instead (T809).
   */
  async meta(token: string, request: FastifyRequest): Promise<ShareMeta> {
    const any = await this.shares.openAny(token, request);
    if (isDashboardLink(any.link)) {
      throw new AppError('NOT_FOUND', {
        detail: 'This is a dashboard link: read /dashboard.',
        errors: [{ path: '', code: DASHBOARD_LINK, message: 'A dashboard link' }],
      });
    }
    const opened = any as OpenedShare;
    const { link, view, access, scope, settings } = opened.link;
    const tableId = view.table_id;
    const table = await this.tables.getById(scope, tableId);
    if (table === undefined) throw notFound();
    const reachable = new Set<string>(Object.keys(access.access.tables[tableId]?.fields ?? {}));
    // Form links outside the organization hide `user` and `link` questions (T321, T410).
    const fields = (await this.fields.listByTable(scope, tableId)).filter(
      (field) => reachable.has(field.id) && !isHiddenQuestion(link, field.type),
    );
    const visible = new Set<string>(fields.map((field) => field.id));
    const downloadable = new Set<string>(
      opened.link.creator.resolved.access.tables[tableId]?.file_download_fields ?? [],
    );
    const restricted: Partial<ReturnType<typeof restrictViewConfig>> = restrictViewConfig(
      storedViewConfigOf(view.type, view.config),
      visible,
      undefined,
      undefined,
      // Summaries (T472) whose function the field no longer takes are left out.
      fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        options: field.options,
        required: field.required,
        result_type: field.result_type,
      })),
    );
    // The view filter always applies and is never returned (BACKLOG S3 decision 3).
    delete restricted.filter;
    // Sub-table columns name fields of linked tables, outside the link's scope (T402).
    delete restricted.record_detail;
    // Color rules (T816): those the server may apply through the link — every field
    // they name in its scope (fields hidden in the view are not) —, without filter.
    const hiddenInView = new Set<string>(restricted.hidden_fields ?? []);
    const colorRules = restricted.color_rules
      ?.filter(
        (rule) => rule.enabled && [...colorRuleFieldIds(rule)].every((id) => !hiddenInView.has(id)),
      )
      .map(({ id, enabled, color, target, field_id: fieldId }) => ({
        id,
        enabled,
        color,
        target,
        field_id: fieldId,
      }));
    delete restricted.color_rules;
    const config =
      colorRules === undefined ? restricted : { ...restricted, color_rules: colorRules };
    // Formula/lookup fields (T462): result type, `locked` for the link, error code only.
    const computed = await sharedComputedParts(
      this.db,
      scope,
      link.base_id,
      fields,
      opened.link.recordAccess,
    );
    this.stats.record(scope.organizationId, link.id, true);
    return {
      target_type: link.target_type === 'form' ? 'form' : 'view',
      table: {
        id: table.id,
        name: table.name,
        primary_field_id: table.primary_field_id as Id<'fld'>,
      },
      view: {
        id: view.id,
        name: view.name,
        type: view.type,
        config: config as SharedViewConfigDto,
      },
      fields: fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type as FieldTypeName,
        // Display keys only: never linked table/field ids, `record_filter`, expressions (T409).
        options: sharedFieldOptions(
          field.type,
          field.options,
          link.target_type === 'form' ? 'form' : 'view',
        ),
        is_primary: field.is_primary,
        description: field.description,
        ...computed.get(field.id),
      })),
      settings: {
        allow_copy: settings.allow_copy,
        allow_download: settings.allow_download,
        // Export (T810) also needs the creator's current download right.
        allow_export:
          link.target_type === 'view' &&
          settings.allow_export &&
          opened.link.creator.access.base_rule.download,
        allow_search: settings.allow_search,
        allow_viewer_filter_sort: settings.allow_viewer_filter_sort,
        show_record_detail: settings.show_record_detail,
      },
      download_fields: fields
        .filter(
          (field) =>
            field.type === 'attachment' &&
            link.target_type === 'view' &&
            settings.allow_download &&
            downloadable.has(field.id),
        )
        .map((field) => field.id),
      expires_at: link.expires_at === null ? null : iso(link.expires_at),
      csrf_token: opened.csrfToken,
    };
  }

  /** `POST /shares/:token/records/query`. */
  async queryRecords(
    token: string,
    params: RecordReadParams,
    body: ShareRecordQueryRequest,
    request: FastifyRequest,
  ): Promise<RecordListOutput> {
    const opened = await this.shares.open(token, request);
    const { link, view, scope, settings, recordAccess } = this.viewLink(opened);
    const refused = viewerChoices(settings, body);
    // Setting the view's sort aside is a viewer sort too (CONTRACTS §1.4, T311).
    if (!settings.allow_viewer_filter_sort && body.sort_mode === 'replace') {
      refused.push(notAllowed('sort_mode'));
    }
    refuseViewerChoices(refused);
    const result = await this.query.query(
      scope,
      view.table_id,
      recordAccess,
      defined({ ...body, ...params, view_id: view.id }),
      { viewScope: 'share_link' },
    );
    this.stats.record(scope.organizationId, link.id, false);
    const values = await this.valueContext(opened, token);
    return {
      ...result,
      records: result.records.map((record) => redactSharedRecord(record, values)),
    };
  }

  /**
   * `POST /shares/:token/records/group-counts` (T317): the counts behind the
   * group headers of a shared grid and the columns of a shared board.
   */
  async groupCounts(
    token: string,
    params: RecordReadParams,
    body: ShareRecordGroupCountsRequest,
    request: FastifyRequest,
  ): Promise<RecordGroupCountsOutput> {
    const opened = await this.shares.open(token, request);
    const { link, view, scope, settings, recordAccess } = this.viewLink(opened);
    const refused = viewerChoices(settings, {
      ...body,
      // The columns of a kanban board are the view's own grouping, not the viewer's.
      group: (await this.isBoardColumns(opened, params, body)) ? undefined : body.group,
    });
    refuseViewerChoices(refused);
    const result = await this.query.groupCounts(
      scope,
      view.table_id,
      recordAccess,
      defined({ ...body, ...params, view_id: view.id }),
      { viewScope: 'share_link' },
    );
    this.stats.record(scope.organizationId, link.id, false);
    return {
      ...result,
      groups: result.groups.map((group) => ({ ...group, values: group.values.map(redactUsers) })),
    };
  }

  /**
   * `POST /shares/:token/records/summaries` (T472): the summary bar of a
   * shared grid — the view's saved summaries on fields of the link, or the
   * viewer's with `allow_viewer_filter_sort`.
   */
  async summaries(
    token: string,
    params: RecordReadParams,
    body: ShareRecordSummariesRequest,
    request: FastifyRequest,
  ): Promise<RecordSummariesOutput> {
    const opened = await this.shares.open(token, request);
    const { link, view, scope, settings, recordAccess } = this.viewLink(opened);
    const refused = viewerChoices(settings, body);
    if (
      !settings.allow_viewer_filter_sort &&
      body.summaries !== undefined &&
      body.summaries !== null
    ) {
      refused.push(notAllowed('summaries'));
    }
    refuseViewerChoices(refused);
    const result = await this.query.summaries(
      scope,
      view.table_id,
      recordAccess,
      defined({ ...body, ...params, view_id: view.id }),
      { viewScope: 'share_link' },
    );
    this.stats.record(scope.organizationId, link.id, false);
    // Summary values are counts, numbers and dates; group values may be users.
    return {
      ...result,
      groups: result.groups.map((group) => ({ ...group, values: group.values.map(redactUsers) })),
    };
  }

  /** `group` is exactly the `kanban.group_field` of the shared kanban view. */
  private async isBoardColumns(
    opened: OpenedShare,
    params: RecordReadParams,
    body: ShareRecordGroupCountsRequest,
  ): Promise<boolean> {
    const { view, scope } = opened.link;
    if (view.type !== 'kanban' || body.group === undefined || body.group === null) return false;
    if (body.group.length !== 1) return false;
    const groupField = storedViewConfigOf(view.type, view.config).kanban?.group_field ?? null;
    const named = body.group[0]?.field;
    if (groupField === null || named === undefined) return false;
    if (params.field_key_type === 'id') return named === groupField;
    const field = (await this.fields.listByTable(scope, view.table_id)).find(
      (item) => item.id === groupField,
    );
    return field !== undefined && field.name === named;
  }

  /** `GET /shares/:token/records/:recordId` (only with `show_record_detail`). */
  async getRecord(
    token: string,
    recordId: string,
    query: ShareRecordGetQuery,
    request: FastifyRequest,
  ): Promise<RecordOutput> {
    const opened = await this.shares.open(token, request);
    const { link, view, scope, settings, recordAccess } = this.viewLink(opened);
    if (!settings.show_record_detail) throw notFound();
    // The link's access already holds the view filter (read rule) and leaves
    // out the fields hidden in the view (T304 `resolveShareLinkAccess`).
    const record = await this.query.getRecord(
      scope,
      view.table_id,
      recordId,
      recordAccess,
      defined(query),
    );
    this.stats.record(scope.organizationId, link.id, false);
    return redactSharedRecord(record, await this.valueContext(opened, token));
  }

  /** `POST /shares/:token/unlock`. */
  async unlock(
    token: string,
    body: ShareUnlockRequest,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ShareUnlockResponse> {
    // Every target has the same unlock (dashboard links too, T809).
    const opened = await this.shares.openAny(token, request, { allowLocked: true });
    const { link, scope } = opened.link;
    if (link.password_hash === null) return { expires_at: null, csrf_token: null };

    const meta = requestMetaOf(request);
    const key = `${link.id}:${meta.ip ?? 'unknown'}`;
    const lockedFor = await this.throttle.lockedFor(key);
    if (lockedFor > 0) throw locked(lockedFor);
    const attempt = await this.throttle.beginAttempt(key);
    if (!attempt.allowed) throw locked(attempt.retryAfterSeconds);

    if (await this.hasher.verify(link.password_hash, body.password)) {
      await this.throttle.reset(key);
      const issued = this.cookies.issue(link);
      void reply.header(
        'set-cookie',
        this.cookies.serialize(link.id, issued.value, {
          secure: this.sessions.secureCookies(request),
          maxAgeSeconds: SHARE_UNLOCK_TTL_SECONDS,
        }),
      );
      return { expires_at: iso(issued.expiresAt), csrf_token: issued.csrfToken };
    }

    if (await this.throttle.recordFailure(key, attempt)) {
      await this.db.withTx((tx) =>
        new AuditWriter().write(tx, {
          action: 'share_link.unlock_failed',
          organizationId: scope.organizationId,
          baseId: link.base_id,
          tableId: link.table_id,
          entityType: 'share_link',
          entityId: link.id,
          after: {
            failures: SHARE_UNLOCK_MAX_FAILURES,
            locked_seconds: SHARE_UNLOCK_WINDOW_SECONDS,
          },
          context: {
            ...auditContextOf(meta, { type: 'share_link', id: link.id }),
            via: { share_link_id: link.id },
          },
        }),
      );
      this.logger.warn({ share_link_id: link.id }, 'share link unlock locked after failures');
    }
    throw new AppError('SHARE_PASSWORD_INVALID', { detail: 'Wrong password for this link.' });
  }

  /** Field types by id and name, to rewrite link, attachment (T409) and computed record values (T462). */
  private async valueContext(opened: OpenedShare, token: string): Promise<ShareValueContext> {
    const { scope, view } = opened.link;
    const types = new Map<string, string>();
    for (const field of await this.fields.listByTable(scope, view.table_id)) {
      const kind = sharedResultKind(field);
      const type =
        kind === 'record'
          ? COMPUTED_RECORDS
          : kind === 'attachment'
            ? COMPUTED_ATTACHMENTS
            : field.type;
      types.set(field.id, type);
      types.set(field.name, type);
    }
    return { token, types };
  }

  /** Records are read through view links only; a form link has no records to show. */
  private viewLink(opened: OpenedShare): OpenedShare['link'] {
    if (opened.link.link.target_type !== 'view') throw notFound();
    return opened.link;
  }
}

function notAllowed(path: string): ProblemErrorItem {
  return { path, code: 'NOT_ALLOWED', message: 'Not allowed by this link.' };
}

/**
 * Filter, sort, group and search the viewer asks for that the link's
 * settings do not allow (CONTRACTS §16A).
 */
function viewerChoices(
  settings: { readonly allow_viewer_filter_sort: boolean; readonly allow_search: boolean },
  body: {
    readonly filter?: unknown;
    readonly sort?: readonly unknown[] | null | undefined;
    readonly group?: readonly unknown[] | null | undefined;
    readonly search?: string | null | undefined;
  },
): ProblemErrorItem[] {
  const refused: ProblemErrorItem[] = [];
  if (!settings.allow_viewer_filter_sort) {
    if (body.filter !== undefined && body.filter !== null) refused.push(notAllowed('filter'));
    if (body.sort !== undefined && body.sort !== null && body.sort.length > 0) {
      refused.push(notAllowed('sort'));
    }
    if (body.group !== undefined && body.group !== null) refused.push(notAllowed('group'));
  }
  if (!settings.allow_search && body.search !== undefined && body.search !== null) {
    if (body.search !== '') refused.push(notAllowed('search'));
  }
  return refused;
}

function refuseViewerChoices(refused: readonly ProblemErrorItem[]): void {
  if (refused.length === 0) return;
  throw new AppError('PERMISSION_DENIED', {
    detail: 'This link does not let viewers filter, sort, group or search.',
    errors: [...refused],
  });
}

function locked(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', {
    detail: 'Too many wrong passwords; try again later.',
    retryAfterSeconds,
  });
}

/** Drops `undefined` keys (exactOptionalPropertyTypes). */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
