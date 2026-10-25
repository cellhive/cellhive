import {
  FieldsRepository,
  GroupMembersRepository,
  orgScope,
  RecordHistoryService,
  RecordMutationService,
  RecordQueryService,
  TablesRepository,
  type AppConfig,
  type Db,
  type OrgScope,
  type LinkCandidatesOutput,
  type RecordAccessContext,
  type RecordGroupCountsOutput,
  type RecordHistoryOutput,
  type RecordSummariesOutput,
  type RecordListOutput,
  type RecordOutput,
  type RecordTrashOutput,
  type RecordTreeOutput,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { settingOf, userTimeZone } from '../../common/access/time-zone.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  CreateRecordsRequest,
  DeleteRecordsRequest,
  DeletedRecordsResponse,
  PurgedRecordsResponse,
  PurgeRecordsRequest,
  RecordAncestorsResponse,
  RecordChildrenQuery,
  RecordTreeRequest,
  RestoreRecordsRequest,
  Id,
  LinkCandidatesRequest,
  RecordDto,
  RecordGetQuery,
  RecordGroupCountsRequest,
  RecordHistoryQuery,
  RecordKeyParams,
  RecordListQuery,
  RecordQueryRequest,
  RecordReadParams,
  RecordsResponse,
  RecordSummariesRequest,
  RecordTrashQuery,
  RecordWriteParams,
  RevertedRecordDto,
  RevertRecordRequest,
  UpdateRecordRequest,
  UpdateRecordsRequest,
  UpsertRecordsResponse,
} from '@cellhive/contracts';

/** A table the caller can reach, with everything the record services need. */
export interface ResolvedTable {
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  readonly base: BaseAccess;
  readonly access: RecordAccessContext;
}

/** Optional keys holding `undefined` removed (`exactOptionalPropertyTypes`). */
type Defined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Defined<T>;
}

/**
 * Record endpoints (SPEC §7, §13.1; CONTRACTS §1.3–1.4). Resolves the table
 * to its base and the caller's effective access there (a table the caller
 * cannot reach is `404`), and hands everything to
 * `RecordQueryService` / `RecordMutationService`, which check table, field
 * and record permissions (AGENTS.md rules 1 and 4).
 */
@Injectable()
export class RecordService {
  private readonly tables: TablesRepository;
  private readonly fields: FieldsRepository;

  constructor(
    @Inject(DB) db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly accessService: AccessService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(RecordMutationService) private readonly mutation: RecordMutationService,
    @Inject(RecordHistoryService) private readonly historyService: RecordHistoryService,
  ) {
    this.tables = new TablesRepository(db);
    this.fields = new FieldsRepository(db);
  }

  /**
   * The table in one of the caller's organizations and the caller's access
   * to its base; `404` when either is missing or not readable. (Rate limits
   * are counted by the global `RequestPoliciesInterceptor`.)
   */
  async resolve(principal: Principal, tableId: Id<'tbl'>): Promise<ResolvedTable> {
    for (const membership of await this.accessService.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      const table = await this.tables.getById(scope, tableId);
      if (table === undefined) continue;
      const base = await this.accessService.findBase(principal, table.base_id);
      if (base === undefined) throw notFound();
      return { scope, tableId, base, access: await this.accessContext(principal, base) };
    }
    throw notFound();
  }

  private async accessContext(
    principal: Principal,
    base: BaseAccess,
  ): Promise<RecordAccessContext> {
    const settings = base.org.membership.settings;
    const locales = [principal.user.locale, settingOf(settings, 'locale')];
    // CONTRACTS §2: typecast follows the base's locale, never the writer's.
    const baseLocales = [settingOf(base.base.settings, 'locale'), settingOf(settings, 'locale')];
    const isLocale = (locale: unknown): locale is string =>
      typeof locale === 'string' && locale !== '';
    return {
      baseId: base.base.id,
      resolved: base.resolved,
      userId: principal.userId,
      groupMemberUserIds: await this.groupMembers.userIdsOfGroups(base.org.scope, base.groupIds),
      timeZone: userTimeZone(principal, base, this.config.defaults.timezone),
      locale: locales.find(isLocale) ?? this.config.defaults.locale,
      typecastLocale: baseLocales.find(isLocale) ?? this.config.defaults.locale,
    };
  }

  // --- Reads ------------------------------------------------------------------------

  async queryRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordReadParams,
    body: RecordQueryRequest,
  ): Promise<RecordListOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.query(table.scope, tableId, table.access, defined({ ...body, ...params }));
  }

  /** `POST …/records/tree` (CONTRACTS §1.4, T405). */
  async tree(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordReadParams,
    body: RecordTreeRequest,
  ): Promise<RecordTreeOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.tree(table.scope, tableId, table.access, defined({ ...body, ...params }));
  }

  /** `GET …/records/:recordId/children` (SPEC §5.7). */
  async children(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    query: RecordChildrenQuery,
  ): Promise<RecordListOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.children(table.scope, tableId, recordId, table.access, defined(query));
  }

  /** `GET …/records/:recordId/ancestors` (T405). */
  async ancestors(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
  ): Promise<RecordAncestorsResponse> {
    const table = await this.resolve(principal, tableId);
    return this.query.ancestors(table.scope, tableId, recordId, table.access);
  }

  /** `POST …/records/group-counts` (CONTRACTS §1.4). */
  async groupCounts(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordReadParams,
    body: RecordGroupCountsRequest,
  ): Promise<RecordGroupCountsOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.groupCounts(
      table.scope,
      tableId,
      table.access,
      defined({ ...body, ...params }),
    );
  }

  /** `POST /tables/:tableId/records/summaries` (T472, CONTRACTS §1.4): the summary bar. */
  async summaries(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordReadParams,
    body: RecordSummariesRequest,
  ): Promise<RecordSummariesOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.summaries(
      table.scope,
      tableId,
      table.access,
      defined({ ...body, ...params }),
    );
  }

  /**
   * `POST /fields/:fieldId/link-candidates` (T402, CONTRACTS §2): the field
   * in one of the caller's organizations (else `404`), then its table as
   * for every record read; `RecordQueryService` checks the rest.
   */
  async linkCandidates(
    principal: Principal,
    fieldId: Id<'fld'>,
    body: LinkCandidatesRequest,
  ): Promise<LinkCandidatesOutput> {
    for (const membership of await this.accessService.memberships(principal)) {
      const field = await this.fields.getById(orgScope(membership.organizationId), fieldId);
      if (field === undefined) continue;
      const table = await this.resolve(principal, field.table_id);
      return this.query.linkCandidates(table.scope, fieldId, table.access, defined(body));
    }
    throw notFound();
  }

  async listRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    query: RecordListQuery,
  ): Promise<RecordListOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.query(table.scope, tableId, table.access, defined(query));
  }

  async getRecord(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    query: RecordGetQuery,
  ): Promise<RecordOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.getRecord(table.scope, tableId, recordId, table.access, defined(query));
  }

  /** `GET …/records/trash` (CONTRACTS §11.3). */
  async listTrash(
    principal: Principal,
    tableId: Id<'tbl'>,
    query: RecordTrashQuery,
  ): Promise<RecordTrashOutput> {
    const table = await this.resolve(principal, tableId);
    return this.query.listTrash(table.scope, tableId, table.access, defined(query));
  }

  /** `GET …/records/:recordId/history` (CONTRACTS §11.1). */
  async history(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    query: RecordHistoryQuery,
  ): Promise<RecordHistoryOutput> {
    const table = await this.resolve(principal, tableId);
    return this.historyService.history(
      table.scope,
      tableId,
      recordId,
      table.access,
      defined(query),
      // API tokens are named to organization owners/admins and their owner (T705).
      { userId: principal.userId, isOrgAdmin: table.base.org.isAdmin },
    );
  }

  // --- Writes -----------------------------------------------------------------------

  /**
   * `POST …/records/:recordId/revert` (CONTRACTS §11.2): the record, or
   * `undefined` (`204`) when the caller can no longer read it after the write.
   */
  async revert(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    params: RecordKeyParams,
    body: RevertRecordRequest,
    meta: RequestMeta,
  ): Promise<RevertedRecordDto | undefined> {
    const table = await this.resolve(principal, tableId);
    const { record, skipped } = await this.historyService.revert(
      table.scope,
      tableId,
      recordId,
      table.access,
      defined({ ...body, field_key_type: params.field_key_type }),
      mutationContextOf(meta, principal.userId),
    );
    // T465: linked records deleted since are left out and counted.
    if (record === undefined || skipped === 0) return record;
    return { ...record, skipped };
  }

  /**
   * `{ records }` → `{ records }`; `{ fields }` → the record, or `undefined`
   * (`204`) when the caller cannot read it after the write.
   */
  async createRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordWriteParams,
    body: CreateRecordsRequest,
    meta: RequestMeta,
  ): Promise<RecordsResponse | RecordDto | undefined> {
    const table = await this.resolve(principal, tableId);
    const records = body.records ?? [
      {
        fields: body.fields ?? {},
        ...(body.parent_id === undefined ? {} : { parent_id: body.parent_id }),
      },
    ];
    const result = await this.mutation.create(
      table.scope,
      tableId,
      table.access,
      { ...params, records },
      mutationContextOf(meta, principal.userId),
      // T543: one record created by hand → its creator follows it (CONTRACTS §22.5).
      { autoFollow: true },
    );
    return body.records !== undefined ? result : result.records[0];
  }

  /** Bulk update, or upsert with `upsert.merge_on`. */
  async updateRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    params: RecordWriteParams,
    body: UpdateRecordsRequest,
    meta: RequestMeta,
  ): Promise<RecordsResponse | UpsertRecordsResponse> {
    const table = await this.resolve(principal, tableId);
    const context = mutationContextOf(meta, principal.userId);
    if (body.upsert !== undefined) {
      return this.mutation.upsert(
        table.scope,
        tableId,
        table.access,
        {
          ...params,
          merge_on: body.upsert.merge_on,
          records: body.records.map((record) => ({ fields: record.fields })),
        },
        context,
      );
    }
    return this.mutation.update(
      table.scope,
      tableId,
      table.access,
      {
        ...params,
        records: body.records.map((record) => ({
          // Required without `upsert` (checked by the request schema).
          id: record.id ?? '',
          ...(record.version === undefined ? {} : { version: record.version }),
          fields: record.fields,
          ...(record.parent_id === undefined ? {} : { parent_id: record.parent_id }),
        })),
      },
      context,
    );
  }

  /** One record; `undefined` when the caller can no longer read it after the write. */
  async updateRecord(
    principal: Principal,
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
    params: RecordWriteParams,
    body: UpdateRecordRequest,
    meta: RequestMeta,
  ): Promise<RecordDto | undefined> {
    const table = await this.resolve(principal, tableId);
    const result = await this.mutation.update(
      table.scope,
      tableId,
      table.access,
      {
        ...params,
        records: [
          {
            id: recordId,
            ...(body.version === undefined ? {} : { version: body.version }),
            fields: body.fields,
            ...(body.parent_id === undefined ? {} : { parent_id: body.parent_id }),
          },
        ],
      },
      mutationContextOf(meta, principal.userId),
    );
    return result.records[0];
  }

  async deleteRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: DeleteRecordsRequest,
    meta: RequestMeta,
  ): Promise<DeletedRecordsResponse> {
    const table = await this.resolve(principal, tableId);
    return this.mutation.delete(
      table.scope,
      tableId,
      table.access,
      { ids: body.ids, ...(body.children === undefined ? {} : { children: body.children }) },
      mutationContextOf(meta, principal.userId),
    );
  }

  async restoreRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: RestoreRecordsRequest,
    meta: RequestMeta,
  ): Promise<RecordsResponse> {
    const table = await this.resolve(principal, tableId);
    return this.mutation.restore(
      table.scope,
      tableId,
      table.access,
      { ids: body.ids, ...(body.branch === undefined ? {} : { branch: body.branch }) },
      mutationContextOf(meta, principal.userId),
    );
  }

  /** `POST …/records/trash/purge` (T408, CONTRACTS §11.3). */
  async purgeRecords(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: PurgeRecordsRequest,
    meta: RequestMeta,
  ): Promise<PurgedRecordsResponse> {
    const table = await this.resolve(principal, tableId);
    return this.mutation.purge(
      table.scope,
      tableId,
      table.access,
      { ids: body.ids, ...(body.branch === undefined ? {} : { branch: body.branch }) },
      mutationContextOf(meta, principal.userId),
    );
  }
}
