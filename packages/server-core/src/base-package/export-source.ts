import { isId, type Id } from '@cellhive/contracts';
import { resolveBaseAccess } from '@cellhive/permissions';

import { AutomationsRepository } from '../automation/repository/automations.repository.js';
import { DashboardWidgetsRepository } from '../dashboards/dashboard-widgets.repository.js';
import { DashboardsRepository } from '../dashboards/dashboards.repository.js';
import { BaseRolesRepository } from '../db/repositories/base-roles.repository.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { GroupsRepository } from '../db/repositories/groups.repository.js';
import { OrgMembersRepository } from '../db/repositories/org-members.repository.js';
import { AppError } from '../errors/app-error.js';
import { loadMemberAccessBase } from '../import/member-access.js';
import { EmailIdentitiesRepository } from '../mail/identities/email-identities.repository.js';
import { EmailAssetsRepository } from '../mail/images/email-assets.repository.js';
import { AttachmentsRepository } from '../records/attachments/attachments.repository.js';
import { FieldsRepository } from '../schema/fields.repository.js';
import { TablesRepository } from '../schema/tables.repository.js';
import { SecretsRepository } from '../secrets/secrets.repository.js';
import { FormCoversRepository } from '../views/form-covers.repository.js';
import { ViewsRepository } from '../views/views.repository.js';
import { IncomingWebhooksRepository } from '../webhooks/incoming/incoming-webhooks.repository.js';

import type {
  BaseExportSchema,
  BaseExportSource,
  ExportAutomation,
  ExportCellFile,
  ExportDetachedRef,
  ExportEmailAsset,
  ExportFormCover,
  ExportRecordStream,
  ExportTable,
} from './export.js';
import type { PackageDashboard, PackageView } from './manifest.js';
import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { FieldRow, JsonValue } from '../db/schema.js';
import type { RecordQueryService } from '../records/record-query.service.js';
import type { RecordAccessContext } from '../records/types.js';
import type { StorageDriver } from '../storage/storage-driver.js';

/** Members, automations and ids read per statement. */
const PAGE = 1_000;

/** A placeholder user of the system read (never a member: no role is ever matched). */
const SYSTEM_EXPORTER: Id<'usr'> = 'usr_SystemPkgExport0';

/** A stream with no row limit (`maxRows` must be a safe integer). */
const UNLIMITED_ROWS = Number.MAX_SAFE_INTEGER - 1;

function objectOf(value: JsonValue | null | undefined): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function listOf(value: JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

export interface DbBaseExportSourceDeps {
  readonly db: Db;
  /** Reads the records (AGENTS.md rule 1); a job timeout (`JOB_STATEMENT_TIMEOUT_MS`) suits. */
  readonly records: RecordQueryService;
  readonly storage: Pick<StorageDriver, 'getStream'>;
  /** Zone of the system read context (the instance default). */
  readonly timeZone: string;
  /** Rows per statement of the record streams (default of `openStream`). */
  readonly batchSize?: number;
}

/**
 * The base of one organization as a {@link BaseExportSource}: schema and
 * metadata through the tenant repositories (every query bound to the
 * organization), records through `RecordQueryService.openStream` in storage
 * form with a **system** read context — every table and field of the base,
 * no record rule (the package holds every field, ADR-24 §3) — and files
 * from object storage. Worker code (the `base.export` job) only.
 */
export class DbBaseExportSource implements BaseExportSource {
  private access: RecordAccessContext | null = null;

  constructor(
    private readonly deps: DbBaseExportSourceDeps,
    private readonly scope: OrgScope,
    private readonly baseId: Id<'bse'>,
  ) {}

  private notFound(): AppError {
    return new AppError('NOT_FOUND', { detail: 'The base no longer exists.' });
  }

  async schema(): Promise<BaseExportSchema> {
    const { db } = this.deps;
    const scope = this.scope;
    const base = await new BasesRepository(db).getById(scope, this.baseId);
    if (base === undefined) throw this.notFound();
    const tableRows = await new TablesRepository(db).listByBase(scope, this.baseId);
    const fieldRows = await new FieldsRepository(db).listByTables(
      scope,
      tableRows.map((table) => table.id),
    );
    const fieldsByTable = new Map<string, FieldRow[]>();
    for (const field of fieldRows) {
      const list = fieldsByTable.get(field.table_id) ?? [];
      list.push(field);
      fieldsByTable.set(field.table_id, list);
    }
    const tables: ExportTable[] = [];
    for (const table of tableRows) {
      const fields = fieldsByTable.get(table.id) ?? [];
      const primary = table.primary_field_id ?? fields.find((field) => field.is_primary)?.id;
      if (primary === undefined || fields.length === 0) continue;
      tables.push({
        id: table.id,
        name: table.name,
        description: table.description,
        position: table.position,
        primary_field_id: primary,
        fields: fields.map((field) => ({
          id: field.id,
          name: field.name,
          type: field.type,
          options: objectOf(field.options),
          is_primary: field.is_primary,
          required: field.required,
          unique_values: field.unique_values,
          description: field.description,
          position: field.position,
          link_side: field.link_side,
          result_type: field.result_type,
        })),
      });
    }

    const viewsRepo = new ViewsRepository(db);
    const views: PackageView[] = [];
    let personalViews = 0;
    for (const table of tables) {
      for (const view of await viewsRepo.listByTable(scope, table.id, null)) {
        views.push({
          id: view.id,
          table_id: table.id,
          type: view.type,
          name: view.name,
          position: view.position,
          locked: view.locked,
          config: objectOf(view.config),
        });
      }
      const counts = await viewsRepo.counts(scope, table.id, null);
      personalViews += counts.total - counts.shared;
    }

    const widgetsRepo = new DashboardWidgetsRepository(db);
    const dashboards: PackageDashboard[] = [];
    for (const dashboard of await new DashboardsRepository(db).listByBase(scope, this.baseId)) {
      const widgets = await widgetsRepo.listByDashboard(scope, dashboard.id);
      dashboards.push({
        id: dashboard.id,
        name: dashboard.name,
        icon: dashboard.icon,
        description: dashboard.description,
        theme: objectOf(dashboard.theme),
        global_filters: listOf(dashboard.global_filters),
        position: dashboard.position,
        widgets: widgets.map((widget) => ({
          id: widget.id,
          type: widget.type,
          title: widget.title,
          config: objectOf(widget.config),
          layout: objectOf(widget.layout),
        })),
      });
    }

    const automationsRepo = new AutomationsRepository(db);
    const automations: ExportAutomation[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await automationsRepo.listPage(scope, this.baseId, {}, { offset, limit: PAGE });
      for (const row of page.items) {
        automations.push({
          id: row.id,
          name: row.name,
          description: row.description,
          definition: objectOf(row.definition),
        });
      }
      if (page.items.length < PAGE) break;
    }

    const roles = (await new BaseRolesRepository(db).listByBase(scope, this.baseId))
      .filter((role) => role.kind === 'custom')
      .map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        config: objectOf(role.config),
      }));

    return {
      base: {
        id: base.id,
        name: base.name,
        description: base.description,
        icon: base.icon,
        settings: objectOf(base.settings),
      },
      tables,
      views,
      personalViews,
      dashboards,
      automations,
      roles,
    };
  }

  async memberEmails(): Promise<ReadonlyMap<string, string>> {
    const members = new OrgMembersRepository(this.deps.db);
    const emails = new Map<string, string>();
    for (let offset = 0; ; offset += PAGE) {
      const page = await members.listPage(this.scope, { offset, limit: PAGE });
      for (const member of page.items) emails.set(member.user.id, member.user.email);
      if (page.items.length < PAGE) break;
    }
    return emails;
  }

  /**
   * Every table and field of the base, no record rule: what an organization
   * owner reads, without anyone's identity (no `current_user` matches).
   */
  private async systemAccess(): Promise<RecordAccessContext> {
    if (this.access !== null) return this.access;
    const base = await loadMemberAccessBase(this.deps.db, this.scope, this.baseId);
    if (base === undefined) throw this.notFound();
    const resolved = resolveBaseAccess({
      principal: {
        userId: SYSTEM_EXPORTER,
        groupIds: [],
        orgRole: 'owner',
        workspaceRole: null,
        isBaseOwner: false,
      },
      roles: [],
      assignments: [],
      schema: base.schema,
    });
    if (resolved === null) throw this.notFound();
    this.access = {
      baseId: this.baseId,
      resolved,
      userId: null,
      groupMemberUserIds: [],
      timeZone: this.deps.timeZone,
      locale: 'en',
    };
    return this.access;
  }

  async openRecords(tableId: Id<'tbl'>): Promise<ExportRecordStream> {
    const stream = await this.deps.records.openStream(
      this.scope,
      tableId,
      await this.systemAccess(),
      {},
      {
        form: 'stored',
        maxRows: UNLIMITED_ROWS,
        ...(this.deps.batchSize === undefined ? {} : { batchSize: this.deps.batchSize }),
      },
    );
    return { rowCount: stream.rowCount, records: () => stream.records() };
  }

  async cellFiles(tableId: Id<'tbl'>, ids: readonly Id<'att'>[]): Promise<ExportCellFile[]> {
    const repo = new AttachmentsRepository(this.deps.db);
    const out: ExportCellFile[] = [];
    for (const part of chunks(ids, PAGE)) {
      for (const row of await repo.getByIds(this.scope, part)) {
        if (
          row.base_id !== this.baseId ||
          row.table_id !== tableId ||
          row.record_id === null ||
          row.status !== 'ready' ||
          row.detached_at !== null ||
          row.record_purged_at !== null
        ) {
          continue;
        }
        out.push({
          id: row.id,
          filename: row.filename,
          mime: row.mime,
          object: row.object_key,
          tableId: row.table_id,
          fieldId: row.field_id,
          recordId: row.record_id,
        });
      }
    }
    return out;
  }

  async formCovers(ids: readonly Id<'att'>[]): Promise<ExportFormCover[]> {
    const repo = new FormCoversRepository(this.deps.db);
    const out: ExportFormCover[] = [];
    for (const id of new Set(ids)) {
      const row = await repo.getById(this.scope, id);
      if (row?.base_id !== this.baseId || row.status !== 'ready') continue;
      out.push({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        object: row.object_key,
        tableId: row.table_id,
        viewId: row.view_id,
      });
    }
    return out;
  }

  async emailAssets(ids: readonly Id<'att'>[]): Promise<ExportEmailAsset[]> {
    const repo = new EmailAssetsRepository(this.deps.db);
    const out: ExportEmailAsset[] = [];
    for (const part of chunks(ids, PAGE)) {
      for (const row of await repo.getReady(this.scope, part)) {
        // Signature images belong to sending identities, never to a package.
        if (row.kind !== 'automation') continue;
        out.push({
          id: row.id,
          filename: row.filename,
          mime: row.mime,
          object: row.object_key,
          width: row.width,
          height: row.height,
        });
      }
    }
    return out;
  }

  async detachedNames(refs: readonly ExportDetachedRef[]): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    const { db } = this.deps;
    const kinds = new Set(refs.map((ref) => ref.kind));
    if (kinds.has('secret')) {
      // The list never selects a secret's value.
      for (const secret of await new SecretsRepository(db).list(this.scope)) {
        names.set(secret.id, secret.name);
      }
    }
    if (kinds.has('email_identity')) {
      for (const identity of await new EmailIdentitiesRepository(db).list(this.scope)) {
        names.set(identity.id, `${identity.display_name} <${identity.email}>`);
      }
    }
    const groupIds = refs.flatMap((ref) =>
      ref.kind === 'group' && isId('grp', ref.id) ? [ref.id] : [],
    );
    for (const part of chunks([...new Set(groupIds)], PAGE)) {
      for (const group of await new GroupsRepository(db).listByIds(this.scope, part)) {
        names.set(group.id, group.name);
      }
    }
    if (kinds.has('incoming_webhook')) {
      for (const hook of await new IncomingWebhooksRepository(db).listByBase(
        this.scope,
        this.baseId,
      )) {
        names.set(hook.id, hook.name);
      }
    }
    const wanted = new Set(refs.map((ref) => ref.id));
    return new Map([...names].filter(([id]) => wanted.has(id)));
  }

  async openFile(object: string) {
    const stream = await this.deps.storage.getStream(object);
    if (stream === null) {
      throw new AppError('INTERNAL', { detail: 'A file of the base is missing from storage.' });
    }
    return stream;
  }
}
