import { isId } from '@cellhive/contracts';
import {
  AiGenerationQueueRepository,
  aiFieldLocked,
  aiOptionsForReader,
  aiOptionsOf,
  AiSettingsRepository,
  AutomationsRepository,
  buttonAutomationOf,
  FIELD_RESTORE_WINDOW_MS,
  FieldsRepository,
  isAiField,
  isComputedRow,
  loadBaseSchemaRows,
  requireAi,
  SchemaService,
  strictComputedPermissionsOf,
  TablesRepository,
  withNewOptionIds,
  type AppConfig,
  type BaseSchemaRows,
  type ComputedFieldContext,
  type Db,
  type FieldRow,
  type LinkFieldContext,
  type OrgScope,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { canManageTable, SchemaAccess } from '../../common/schema/schema-access.js';
import { fieldDtoOf, pageOf } from '../../common/schema/schema-dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import {
  computedDtoPart,
  loadErrorRefs,
  organizationTimeZone,
  readabilityOf,
  type ErrorRefRows,
} from './computed-fields.js';
import { FieldConversionService } from './field-conversion.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  AiFieldStateDto,
  ButtonFieldSummary,
  CreateFieldRequest,
  DeletePreview,
  FieldDto,
  FieldList,
  FieldListQuery,
  Id,
  UpdateFieldRequest,
  UpdateFieldResponse,
} from '@cellhive/contracts';

/**
 * Fields (SPEC §5.5, §13.1; BACKLOG T103). Base admins and roles with
 * `manage` on the table change the schema; everyone else who can read the
 * table sees the fields their role does not hide. Every DDL and meta change
 * goes through `SchemaService` (events, audit, `permission_version`,
 * `schema.changed`).
 */
@Injectable()
export class FieldService {
  constructor(
    @Inject(SchemaService) private readonly schema: SchemaService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(FieldConversionService) private readonly conversions: FieldConversionService,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AiSettingsRepository) private readonly aiSettings: AiSettingsRepository,
  ) {}

  /**
   * AI fields (T910): giving `options.ai` needs AI on with record data
   * allowed (`422 AI_NOT_CONFIGURED` / `AI_RECORD_DATA_DISABLED`), after the
   * `404`/`403` of the route; removing it (`null`) does not.
   */
  private async requireAiFor(base: BaseAccess, options: unknown): Promise<void> {
    if (typeof options !== 'object' || options === null || !('ai' in options)) return;
    if (options.ai === null || options.ai === undefined) return;
    requireAi(await this.aiSettings.find(base.org.scope), { recordData: true });
  }

  /** Queue counts of the AI fields among `fields` (T910). */
  private async aiStatesOf(
    base: BaseAccess,
    fields: readonly FieldRow[],
  ): Promise<Map<Id<'fld'>, AiFieldStateDto>> {
    const ids = fields.filter(isAiField).map((field) => field.id);
    return new AiGenerationQueueRepository(this.db).statesOf(base.org.scope, ids);
  }

  /**
   * What the caller may reference in a formula/lookup (SPEC §9.5: tables
   * and fields they read) and the organization zone (T456).
   */
  computedContextOf(base: BaseAccess): ComputedFieldContext {
    return {
      readable: readabilityOf(base.access),
      timeZone: organizationTimeZone(base, this.config.defaults.timezone),
    };
  }

  /**
   * Meta of the base, loaded only when some field is computed, with the
   * inactive fields/tables their errors name (T460).
   */
  private async rowsFor(
    base: BaseAccess,
    fields: readonly FieldRow[],
  ): Promise<{ rows: BaseSchemaRows; inactive: ErrorRefRows } | undefined> {
    if (!fields.some((field) => isComputedRow(field) || isAiField(field))) return undefined;
    const rows = await loadBaseSchemaRows(this.db, base.org.scope, base.base.id);
    const inactive = await loadErrorRefs(base.org.scope, rows, fields, {
      fields: this.fields,
      tables: this.tables,
    });
    return { rows, inactive };
  }

  private computedOf(
    base: BaseAccess,
    loaded: { rows: BaseSchemaRows; inactive: ErrorRefRows } | undefined,
    field: FieldRow,
    aiStates?: ReadonlyMap<Id<'fld'>, AiFieldStateDto>,
  ) {
    const ai = aiOptionsOf(field);
    if (loaded !== undefined && ai !== null) {
      // T910: the prompt in names for this reader; always strict.
      const readable = readabilityOf(base.access);
      const state = aiStates?.get(field.id);
      return {
        options: {
          ...(field.options as Record<string, unknown>),
          ai: aiOptionsForReader(ai, loaded.rows, field.table_id, readable),
        },
        locked: aiFieldLocked(field, (id) => readable.field(field.table_id, id)),
        ...(state === undefined ? {} : { ai_state: state }),
      };
    }
    return loaded === undefined
      ? undefined
      : computedDtoPart(
          field,
          loaded.rows,
          base.access,
          strictComputedPermissionsOf(base.base.settings),
          loaded.inactive,
        );
  }

  /**
   * The automation attached to each button field (T517): id, on/off and
   * `min_permission` of its `button.clicked` trigger.
   */
  private async buttonsOf(
    scope: OrgScope,
    fields: readonly FieldRow[],
  ): Promise<Map<string, ButtonFieldSummary>> {
    const buttons = fields.filter((field) => field.type === 'button');
    const out = new Map<string, ButtonFieldSummary>();
    if (buttons.length === 0) return out;
    const rows = await new AutomationsRepository(this.db).listForButtons(
      scope,
      buttons.map((field) => field.id),
    );
    for (const field of buttons) {
      let summary: ButtonFieldSummary = {
        automation_id: null,
        automation_enabled: false,
        min_permission: null,
      };
      for (const row of rows) {
        const automation = buttonAutomationOf(row, field.table_id, field.id);
        if (automation === null) continue;
        summary = {
          automation_id: row.id,
          automation_enabled: row.enabled,
          min_permission: automation.trigger.min_permission,
        };
      }
      out.set(field.id, summary);
    }
    return out;
  }

  /**
   * Fields of the table the caller can see (`no_perm` fields are left out).
   * With `include_deleted`, schema managers also get the fields of the trash
   * that `restore` would still accept (ADR-23 §3), newest deletion first.
   */
  async list(principal: Principal, tableId: Id<'tbl'>, query: FieldListQuery): Promise<FieldList> {
    const level = query.include_deleted ? 'manage' : 'read';
    const { base } = await this.schemaAccess.requireTable(principal, tableId, level);
    const visible = base.access.tables[tableId]?.fields ?? {};
    const rows = await this.fields.listByTable(base.org.scope, tableId, {
      includeDeleted: query.include_deleted,
    });
    const live = rows.filter(
      (field) => field.deleted_at === null && visible[field.id] !== undefined,
    );
    // T403: each field says whether its values are being converted / can be reverted.
    const states = await this.conversions.statesOf(base.org.scope, tableId);
    const deletedTargets = await this.deletedLinkTargets(base.org.scope, rows);
    const schemaRows = await this.rowsFor(base, rows);
    const buttons = await this.buttonsOf(base.org.scope, rows);
    const aiStates = await this.aiStatesOf(base, live);
    const dto = (field: FieldRow) =>
      fieldDtoOf(
        field,
        deletedTargets,
        states.get(field.id) ?? null,
        this.computedOf(base, schemaRows, field, aiStates),
        buttons.get(field.id),
      );
    if (!query.include_deleted) return pageOf(live, query, dto);
    const restorableSince = Date.now() - FIELD_RESTORE_WINDOW_MS;
    const trashed = rows
      .filter(
        (field): field is FieldRow & { deleted_at: Date } =>
          field.deleted_at !== null &&
          field.purged_at === null &&
          field.deleted_at.getTime() >= restorableSince,
      )
      .sort((a, b) => b.deleted_at.getTime() - a.deleted_at.getTime() || (a.id < b.id ? -1 : 1));
    return pageOf([...live, ...trashed], query, dto);
  }

  async create(
    principal: Principal,
    tableId: Id<'tbl'>,
    input: CreateFieldRequest,
    meta: RequestMeta,
  ): Promise<FieldDto> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    const link = input.type === 'link' ? this.newLinkContext(base, input.options) : undefined;
    if (input.type === 'text' || input.type === 'select')
      await this.requireAiFor(base, input.options);
    const field = await this.schema.addField(
      base.org.scope,
      tableId,
      {
        name: input.name,
        type: input.type,
        options: withNewOptionIds(input.type, input.options),
        description: input.description ?? null,
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(input.unique_values === undefined ? {} : { uniqueValues: input.unique_values }),
        ...(link === undefined ? {} : { link }),
        ...(input.type === 'formula' || input.type === 'lookup'
          ? { computed: this.computedContextOf(base) }
          : {}),
        ...(input.type === 'text' || input.type === 'select'
          ? { ai: { readable: readabilityOf(base.access) } }
          : {}),
      },
      mutationContextOf(meta, principal.userId),
    );
    return fieldDtoOf(
      field,
      undefined,
      null,
      this.computedOf(
        base,
        await this.rowsFor(base, [field]),
        field,
        await this.aiStatesOf(base, [field]),
      ),
      (await this.buttonsOf(base.org.scope, [field])).get(field.id),
    );
  }

  async get(principal: Principal, fieldId: Id<'fld'>): Promise<FieldDto> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'read');
    return this.dto(base, field);
  }

  async update(
    principal: Principal,
    fieldId: Id<'fld'>,
    input: UpdateFieldRequest,
    meta: RequestMeta,
  ): Promise<UpdateFieldResponse> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    if (field.type === 'text' || field.type === 'select')
      await this.requireAiFor(base, input.options);
    const link =
      field.type === 'link' && input.options !== undefined
        ? this.linkContextOf(base, linkTableOf(field.options))
        : undefined;
    const { field: updated, removeOptionsJobId } = await this.schema.updateFieldWithJob(
      base.org.scope,
      fieldId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        // Merged with the current options under the schema lock; `field` is
        // what this request saw (concurrently added options are kept).
        ...(input.options === undefined
          ? {}
          : { optionsPatch: input.options, optionsBase: field.options }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(input.unique_values === undefined ? {} : { uniqueValues: input.unique_values }),
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(link === undefined ? {} : { link }),
        ...(isComputedRow(field) ? { computed: this.computedContextOf(base) } : {}),
        ...(field.type === 'text' || field.type === 'select'
          ? { ai: { readable: readabilityOf(base.access) } }
          : {}),
      },
      mutationContextOf(meta, principal.userId),
    );
    return { ...(await this.dto(base, updated)), job_id: removeOptionsJobId };
  }

  /** A field DTO with its link flag (T401), conversion state (T403) and computed part (T456). */
  private async dto(base: BaseAccess, field: FieldRow): Promise<FieldDto> {
    const scope = base.org.scope;
    const states = await this.conversions.statesOf(scope, field.table_id);
    return fieldDtoOf(
      field,
      await this.deletedLinkTargets(scope, [field]),
      states.get(field.id) ?? null,
      this.computedOf(
        base,
        await this.rowsFor(base, [field]),
        field,
        await this.aiStatesOf(base, [field]),
      ),
      (await this.buttonsOf(scope, [field])).get(field.id),
    );
  }

  /**
   * `POST /fields/:id/restore` (ADR-23 §3): within 30 days, through
   * `SchemaService.restoreField` (the column is renamed back with its data).
   * Expired or purged deletions are `404`; a field that is not deleted is
   * returned unchanged.
   */
  async restore(principal: Principal, fieldId: Id<'fld'>, meta: RequestMeta): Promise<FieldDto> {
    const { base } = await this.schemaAccess.requireDeletedFieldManager(principal, fieldId);
    const field = await this.schema.restoreField(
      base.org.scope,
      fieldId,
      mutationContextOf(meta, principal.userId),
    );
    return this.dto(base, field);
  }

  /**
   * A new link field (T401): the linked table must be one the caller sees
   * in this base (else `404`); a two-way link also needs schema rights on
   * it (else `403`). `record_filter` may only name its readable fields.
   */
  private newLinkContext(base: BaseAccess, options: unknown): LinkFieldContext {
    const target = linkTableOf(options);
    // A missing or malformed id is left to the options schema (422).
    if (target === null) return {};
    if (base.access.tables[target] === undefined) throw notFound();
    const bidirectional =
      typeof options === 'object' && options !== null && 'bidirectional' in options
        ? options.bidirectional === true
        : false;
    if (bidirectional && !canManageTable(base.access, target)) {
      throw permissionDenied('A two-way link needs schema rights on both tables.');
    }
    return this.linkContextOf(base, target);
  }

  /** Fields of the linked table the caller reads (none without access to it). */
  private linkContextOf(base: BaseAccess, target: Id<'tbl'> | null): LinkFieldContext {
    const fields = target === null ? undefined : base.access.tables[target]?.fields;
    return {
      readableTargetFieldIds: new Set(
        Object.entries(fields ?? {})
          .filter(([, perm]) => (perm as string) !== 'no_perm')
          .map(([id]) => id),
      ),
    };
  }

  /** Linked tables of `rows`' link fields that are in the trash or gone (CONTRACTS §13). */
  private async deletedLinkTargets(
    scope: OrgScope,
    rows: readonly FieldRow[],
  ): Promise<Set<string>> {
    const targets = new Set(
      rows.flatMap((row) => {
        const target = row.type === 'link' ? linkTableOf(row.options) : null;
        return target === null ? [] : [target];
      }),
    );
    const deleted = new Set<string>();
    for (const target of targets) {
      if ((await this.tables.getById(scope, target)) === undefined) deleted.add(target);
    }
    return deleted;
  }

  /**
   * `GET /fields/:id/delete-preview` (T460, CONTRACTS §13): schema rights on
   * the table like the delete (`403`/`404`); changes nothing.
   */
  async deletePreview(principal: Principal, fieldId: Id<'fld'>): Promise<DeletePreview> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    return { dependents: await this.conversions.deleteDependentsOf(principal, base, field) };
  }

  async delete(principal: Principal, fieldId: Id<'fld'>, meta: RequestMeta): Promise<void> {
    const { base } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    await this.schema.deleteField(
      base.org.scope,
      fieldId,
      mutationContextOf(meta, principal.userId),
    );
  }
}

/** `options.link_table` when it is a table id, else `null`. */
function linkTableOf(options: unknown): Id<'tbl'> | null {
  if (typeof options !== 'object' || options === null || !('link_table' in options)) return null;
  return isId('tbl', options.link_table) ? options.link_table : null;
}
