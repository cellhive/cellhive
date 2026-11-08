import {
  AiSettingsRepository,
  FIELD_RESTORE_WINDOW_MS,
  FieldsRepository,
  isComputedRow,
  requireAi,
  SchemaService,
  withNewOptionIds,
  type AppConfig,
  type ComputedFieldContext,
  type Db,
  type FieldRow,
  type LinkFieldContext,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { canManageTable, SchemaAccess } from '../../common/schema/schema-access.js';
import { pageOf } from '../../common/schema/schema-dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { organizationTimeZone, readabilityOf, requireAiFieldUnlocked } from './computed-fields.js';
import { FieldConversionService } from './field-conversion.service.js';
import { FieldDtoService, linkTableOf } from './field-dto.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
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
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AiSettingsRepository) private readonly aiSettings: AiSettingsRepository,
    @Inject(FieldDtoService) private readonly dtos: FieldDtoService,
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
    const dto = await this.dtos.serializer(base, rows);
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
    return this.dtos.one(base, field);
  }

  async get(principal: Principal, fieldId: Id<'fld'>): Promise<FieldDto> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'read');
    return this.dtos.one(base, field);
  }

  /**
   * `PATCH /fields/:id`. `keepUnlistedOptions` (only the MCP `update_field`
   * tool passes it, CONTRACTS §30.7, Quyết định S9 #36): select options of
   * `input.options` are upserted under the schema lock and every current
   * option is kept, so nothing is deleted even when an option is added
   * concurrently; the REST route never sets it.
   */
  async update(
    principal: Principal,
    fieldId: Id<'fld'>,
    input: UpdateFieldRequest,
    meta: RequestMeta,
    mode: { readonly keepUnlistedOptions?: boolean } = {},
  ): Promise<UpdateFieldResponse> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    if (input.options !== undefined && Object.hasOwn(input.options, 'ai')) {
      await requireAiFieldUnlocked(this.db, base, field);
    }
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
        ...(mode.keepUnlistedOptions === true ? { keepUnlistedOptions: true } : {}),
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
    return { ...(await this.dtos.one(base, updated)), job_id: removeOptionsJobId };
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
    return this.dtos.one(base, field);
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
