import {
  newId,
  type ConvertFieldPreview,
  type ConvertFieldPreviewRequest,
  type ConvertFieldRequest,
  type ConvertFieldResponse,
  type FieldConversionState,
  type FieldDependent,
  type FieldDto,
  type FieldTypeName,
  type Id,
  type ProblemErrorItem,
  type RevertConversionPreview,
  type RevertConversionRequest,
} from '@cellhive/contracts';
import {
  FIELD_TYPE_REGISTRY,
  inheritComputedStyle,
  isComputedFieldType,
  isConvertibleTarget,
  isS1FieldType,
  MAX_OPTION_COLOR,
  MAX_SELECT_OPTIONS,
  planComputedConversion,
  planFieldConversion,
  type ConversionSettings,
  type FieldConversionPlan,
  type S1FieldType,
  type SelectOptions,
} from '@cellhive/field-types';
import {
  AuditLogsRepository,
  BaseRolesRepository,
  computedDefinitionOf,
  computedSourceOf,
  ConcurrentFieldEditsError,
  conversionContextOf,
  countsOf,
  definitionTypeOf,
  edgesOf,
  FieldConversionsRepository,
  FieldDependenciesRepository,
  FieldsRepository,
  strictComputedPermissionsOf,
  TablesRepository,
  fieldConvertingError,
  fieldDependents,
  findCycle,
  formulaCycleProblem,
  GroupMembersRepository,
  isAiField,
  isComputedRow,
  loadBaseSchemaRows,
  MemberDirectoryRepository,
  prepareComputedDefinition,
  previewComputedRevert,
  previewComputedSource,
  previewComputedTarget,
  previewConversion,
  previewRevert,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  sourceColumnOf,
  storedDefinitionOf,
  ViewsRepository,
  withNewOptionIds,
  type AppConfig,
  type Db,
  type FieldConversionRow,
  type FieldRow,
  type JsonObject,
  type OrgScope,
  type PreparedComputedDefinition,
  type RecordAccessContext,
  type StartConversionInput,
} from '@cellhive/server-core';
import { AppError, zodIssuesToProblemErrors } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { permissionDenied, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { fieldDtoOf } from '../../common/schema/schema-dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import {
  computedDependentsOf,
  computedDtoPart,
  loadErrorRefs,
  type ComputedDtoPart,
  definitionVisible,
  organizationTimeZone,
  readabilityOf,
} from './computed-fields.js';
import { LinkConversionService } from './link-conversion.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

const isLocale = (locale: unknown): locale is string => typeof locale === 'string' && locale !== '';

/** `statement_timeout` of the computed samples of a conversion preview to a formula/lookup (T463). */
const CONVERT_TO_COMPUTED_PREVIEW_TIMEOUT_MS = 2000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PlannedChange {
  readonly plan: FieldConversionPlan;
  /** Target options as validated (select options with ids). */
  readonly toOptions: JsonRecord;
}

function conversionNotAllowed(detail: string, path: string, params?: JsonRecord): AppError {
  return new AppError('CONVERSION_NOT_ALLOWED', {
    detail,
    errors: [
      {
        path,
        code: 'CONVERSION_NOT_ALLOWED',
        message: detail,
        ...(params === undefined ? {} : { params }),
      },
    ],
  });
}

/**
 * A button (T517) has no value: it is never converted, nor converted to
 * (`422 CONVERSION_NOT_ALLOWED`).
 */
function assertNoButton(field: FieldRow, toType: string): void {
  if (field.type !== 'button' && toType !== 'button') return;
  throw conversionNotAllowed(
    `A field cannot be converted from ${field.type} to ${toType}.`,
    'type',
    { from: field.type, to: toType },
  );
}

function requiresConfirm(detail: string, path: string, params: JsonRecord): AppError {
  return new AppError('CONVERSION_REQUIRES_CONFIRM', {
    detail,
    errors: [{ path, code: 'CONVERSION_REQUIRES_CONFIRM', message: detail, params }],
  });
}

function tooManyOptions(): AppError {
  const message = `A select field can have at most ${String(MAX_SELECT_OPTIONS)} options`;
  return new AppError('TOO_MANY_OPTIONS', {
    detail: `${message}.`,
    errors: [
      {
        path: 'options',
        code: 'TOO_MANY_OPTIONS',
        message,
        params: { limit: MAX_SELECT_OPTIONS },
      },
    ],
  });
}

/** `conversion` of a request as the pure functions take it. */
function settingsOf(body: ConvertFieldPreviewRequest): ConversionSettings {
  const conversion = body.conversion ?? {};
  return {
    ...(conversion.match_existing_only === undefined
      ? {}
      : { match_existing_only: conversion.match_existing_only }),
    ...(conversion.truthy_values === undefined ? {} : { truthy_values: conversion.truthy_values }),
    ...(conversion.match_email === undefined ? {} : { match_email: conversion.match_email }),
  };
}

/** The first item of a list default (single-value target of §4.2). */
function firstDefault(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null;
  return value.length === 0 ? null : value.slice(0, 1);
}

/**
 * Field type conversion (SPEC §5.5, CONTRACTS §4.4, ADR-23 §3; BACKLOG T403):
 * previews, the change itself (through `SchemaService.startConversion` and
 * the `field.convert` job, or at once when no value changes), the revert
 * and its preview. Schema rights on the table are required everywhere (a
 * field the caller cannot see is `404`, AGENTS.md rule 4). Values are read
 * through `RecordQueryService` only (AGENTS.md rule 1).
 */
@Injectable()
export class FieldConversionService {
  private readonly members: MemberDirectoryRepository;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SchemaService) private readonly schema: SchemaService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(RecordMutationService) private readonly records: RecordMutationService,
    @Inject(FieldConversionsRepository) private readonly conversions: FieldConversionsRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(AuditLogsRepository) private readonly auditLogs: AuditLogsRepository,
    @Inject(BaseRolesRepository) private readonly roles: BaseRolesRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(LinkConversionService) private readonly links: LinkConversionService,
  ) {
    this.members = new MemberDirectoryRepository(db);
  }

  // --- Field DTOs ----------------------------------------------------------------

  /** Conversion state of the fields of a table (CONTRACTS §13 `conversion`). */
  async statesOf(scope: OrgScope, tableId: Id<'tbl'>): Promise<Map<string, FieldConversionState>> {
    const states = new Map<string, FieldConversionState>();
    const now = Date.now();
    for (const row of await this.conversions.listLiveByTable(scope, tableId)) {
      if (row.status === 'succeeded' && row.expires_at.getTime() <= now) continue;
      states.set(row.field_id, stateOf(row));
    }
    return states;
  }

  /** A field DTO with its conversion state (and computed part, T463: formula/lookup again). */
  async dtoOf(base: BaseAccess, field: FieldRow): Promise<FieldDto> {
    const scope = base.org.scope;
    const states = await this.statesOf(scope, field.table_id);
    let computed: ComputedDtoPart | undefined;
    if (isComputedRow(field)) {
      const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
      const inactive = await loadErrorRefs(scope, rows, [field], {
        fields: new FieldsRepository(this.db),
        tables: new TablesRepository(this.db),
      });
      computed = computedDtoPart(
        field,
        rows,
        base.access,
        strictComputedPermissionsOf(base.base.settings),
        inactive,
      );
    }
    return fieldDtoOf(field, undefined, states.get(field.id) ?? null, computed);
  }

  // --- Preview and conversion ----------------------------------------------------

  /** `POST /fields/:id/convert-preview`. */
  async preview(
    principal: Principal,
    fieldId: Id<'fld'>,
    body: ConvertFieldPreviewRequest,
  ): Promise<ConvertFieldPreview> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    assertNoButton(field, body.type);
    // T404: link fields (direction, allow_multiple; link ↔ other types refused).
    if (this.links.handles(field, body)) return this.links.preview(principal, base, field, body);
    // T463: to a formula/lookup; from one, the converter reads every source.
    if (isComputedFieldType(body.type)) return this.previewToComputed(principal, base, field, body);
    if (isComputedRow(field)) await this.assertSourcesReadable(base, field);
    const dependents = await this.dependentsOf(principal, base, field);
    const planned = this.planChange(field, body);
    const empty = { affected: 0, lost: 0, truncated: 0, new_options: [], samples: [] };
    if (planned === null) {
      return {
        allowed: false,
        reason: 'CONVERSION_NOT_ALLOWED',
        kind: 'forbidden',
        requires_confirm: false,
        requires_accept_data_loss: false,
        unique_values_reset: false,
        ...empty,
        dependents,
      };
    }
    const { plan } = planned;
    // T460: formula/lookup fields the new type would break (`INVALID_CONFIG`).
    dependents.push(
      ...(await computedDependentsOf(this.db, base, {
        kind: 'retype_field',
        fieldId: field.id,
        type: body.type,
        options: planned.toOptions as JsonObject,
      })),
    );
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const counted = await this.count(base, field, plan, access);
    const tooMany = counted.tooManyOptions;
    const requiresAcceptDataLoss = plan.kind === 'blacklist' && counted.affected > 0;
    return {
      allowed: !tooMany,
      reason: tooMany ? 'TOO_MANY_OPTIONS' : null,
      kind: plan.kind,
      requires_confirm:
        plan.kind === 'truncate' ||
        (plan.kind === 'keep' && (counted.lost > 0 || counted.truncated > 0)),
      requires_accept_data_loss: requiresAcceptDataLoss,
      // Conversions that change values start without the unique index (T403).
      unique_values_reset: field.unique_values && plan.kind !== 'none',
      affected: counted.affected,
      lost: counted.lost,
      truncated: counted.truncated,
      ...(counted.invalid === undefined ? {} : { invalid: counted.invalid }),
      new_options: counted.newOptions,
      samples: counted.samples,
      dependents,
    };
  }

  /** `PUT /fields/:id` (`202`). */
  async convert(
    principal: Principal,
    fieldId: Id<'fld'>,
    body: ConvertFieldRequest,
    meta: RequestMeta,
  ): Promise<ConvertFieldResponse> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    assertNoButton(field, body.type);
    if (this.links.handles(field, body)) {
      const converted = await this.links.convert(principal, base, field, body, meta);
      return {
        job_id: converted.jobId,
        field: await this.dtoOf(base, converted.field),
      };
    }
    const context = mutationContextOf(meta, principal.userId);
    const running = await this.conversions.runningFieldIds(base.org.scope, field.table_id);
    if (running.has(field.id)) throw fieldConvertingError(field.id);
    if (isComputedFieldType(body.type)) {
      return this.convertToComputed(principal, base, field, body, meta);
    }
    if (isComputedRow(field)) await this.assertSourcesReadable(base, field);
    const planned = this.planChange(field, body);
    if (planned === null) {
      throw conversionNotAllowed(
        `A field cannot be converted from ${field.type} to ${body.type}.`,
        'type',
        { from: field.type, to: body.type },
      );
    }
    const { plan, toOptions } = planned;
    const scope = base.org.scope;

    if (plan.kind === 'none') {
      // No value changes: applied at once, like a PATCH of the options.
      const { field: updated, removeOptionsJobId } = await this.schema.updateFieldWithJob(
        scope,
        fieldId,
        { optionsPatch: toOptions, optionsBase: field.options },
        context,
      );
      return { job_id: removeOptionsJobId, field: await this.dtoOf(base, updated) };
    }

    let finalOptions: JsonRecord = toOptions;
    let counted: StartConversionInput['counted'];
    const selectFromText = plan.to.type === 'select' && plan.from.type !== 'select';
    const needsCount =
      selectFromText ||
      (plan.kind === 'blacklist' && body.accept_data_loss !== true) ||
      (plan.kind === 'keep' && body.confirm !== true);
    if (plan.kind === 'truncate' && body.confirm !== true) {
      throw requiresConfirm(
        'This conversion keeps only the first value of each cell; confirm it.',
        'confirm',
        { kind: plan.kind },
      );
    }
    if (needsCount) {
      const access = await recordAccessContextOf(
        { groupMembers: this.groupMembers, config: this.config },
        principal.user,
        base,
      );
      // Counts the values and decides: refuses (confirm, data loss, too many
      // options) or returns the target options with the options the values create.
      const decide = async (): Promise<JsonRecord> => {
        const result = await this.count(base, field, plan, access);
        if (result.tooManyOptions) throw tooManyOptions();
        if (plan.kind === 'blacklist' && result.affected > 0 && body.accept_data_loss !== true) {
          throw conversionNotAllowed(
            'This conversion is outside the whitelist and the field has values: accept losing them all.',
            'accept_data_loss',
            { affected: result.affected },
          );
        }
        if (
          plan.kind === 'keep' &&
          (result.lost > 0 || result.truncated > 0) &&
          body.confirm !== true
        ) {
          throw requiresConfirm('This conversion loses or cuts values; confirm it.', 'confirm', {
            lost: result.lost,
            truncated: result.truncated,
          });
        }
        if (!selectFromText || result.newOptions.length === 0) return toOptions;
        const current = (plan.to.options as SelectOptions).options;
        return {
          ...toOptions,
          options: [
            ...current,
            ...result.newOptions.map((name, index) => ({
              id: newId('opt'),
              name,
              color: (current.length + index) % (MAX_OPTION_COLOR + 1),
            })),
          ],
        };
      };
      // Read before counting: any record write after it changes the version,
      // and `startConversion` then counts again under the schema lock.
      const dataVersion = await this.tableDataVersion(scope, field.table_id);
      finalOptions = await decide();
      counted = { dataVersion, recount: decide };
    }
    const { locale, timeZone } = this.conversionLocale(base);
    const started = await this.schema.startConversion(
      scope,
      fieldId,
      {
        expectedFrom: { type: field.type, options: field.options },
        toType: plan.to.type,
        toOptions: finalOptions,
        settings: plan.settings,
        locale,
        timeZone,
        ...(counted === undefined ? {} : { counted }),
      },
      context,
    );
    return { job_id: started.jobId, field: await this.dtoOf(base, started.field) };
  }

  // --- Revert ------------------------------------------------------------------------

  /** `POST /fields/:id/revert-conversion/preview`. */
  async revertPreview(principal: Principal, fieldId: Id<'fld'>): Promise<RevertConversionPreview> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    const conversion = await this.revertible(base.org.scope, field);
    if (conversion.kind !== 'column') return this.links.revertPreview(base, field, conversion);
    if (isComputedConversion(conversion)) {
      return this.computedRevertPreview(principal, base, field, conversion);
    }
    const counted = await this.countEdits(principal, base, field, conversion);
    return {
      job_id: conversion.job_id,
      from_type: definitionTypeOf(conversion.from_definition) as FieldTypeName,
      revertible_until: conversion.expires_at.toISOString(),
      unchanged: counted.unchanged,
      edited: counted.edited,
      edited_unconvertible: counted.editedUnconvertible,
      new_field_available: conversion.old_column_name !== null,
      samples: counted.samples,
    };
  }

  /**
   * `POST /fields/:id/revert-conversion` (BACKLOG S4 design decision #7):
   * `keep_later_edits` merges the edited cells (converted back) into the old
   * column, then swaps it back, re-checking under the schema lock that the
   * field was not written meanwhile (else merges again, at most 3 times,
   * then `409 SCHEMA_LOCKED`); `overwrite_later_edits` swaps at once;
   * `new_field` restores the old version as a new field.
   */
  async revert(
    principal: Principal,
    fieldId: Id<'fld'>,
    body: RevertConversionRequest,
    meta: RequestMeta,
  ): Promise<FieldDto> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    const scope = base.org.scope;
    const context = mutationContextOf(meta, principal.userId);
    const mode = body.mode ?? 'keep_later_edits';
    const conversion = await this.revertible(scope, field);
    if (conversion.kind !== 'column') {
      const reverted = await this.links.revert(principal, base, field, conversion, body, meta);
      return this.dtoOf(base, reverted);
    }
    if (mode === 'new_field') {
      const name = body.name ?? `${field.name} (old version)`;
      const created = await this.schema.restoreConversionAsNewField(scope, fieldId, name, context);
      return this.dtoOf(base, created);
    }
    if (isComputedConversion(conversion)) {
      // T463: a formula/lookup coming back replaces the values written since
      // (`confirm`); a stored type coming back had no edits to keep.
      const preview = await this.computedRevertPreview(principal, base, field, conversion);
      if (preview.edited > 0 && body.confirm !== true) {
        throw requiresConfirm(
          'Cells were written since the conversion; the formula or lookup replaces them. Confirm it.',
          'confirm',
          { edited: preview.edited, edited_unconvertible: preview.edited_unconvertible },
        );
      }
      const reverted = await this.schema.revertConversion(scope, fieldId, context, {
        mode,
        counts: {
          unchanged: preview.unchanged,
          edited: preview.edited,
          overwritten: preview.edited,
        },
      });
      return this.dtoOf(base, reverted);
    }
    if (mode === 'overwrite_later_edits') {
      const counted = await this.countEdits(principal, base, field, conversion);
      if (counted.edited > 0 && body.confirm !== true) {
        throw requiresConfirm(
          'Cells were edited since the conversion; overwriting them loses those edits. Confirm it.',
          'confirm',
          { edited: counted.edited },
        );
      }
      const reverted = await this.schema.revertConversion(scope, fieldId, context, {
        mode,
        counts: {
          unchanged: counted.unchanged,
          edited: counted.edited,
          overwritten: counted.edited,
        },
      });
      return this.dtoOf(base, reverted);
    }
    for (let attempt = 1; ; attempt += 1) {
      const since = await this.dbNow();
      const counted = await this.countEdits(principal, base, field, conversion);
      if (counted.editedUnconvertible > 0 && body.confirm !== true) {
        throw requiresConfirm(
          'Some edited cells cannot be kept in the old type; they get their old value back. Confirm it.',
          'confirm',
          { edited: counted.edited, edited_unconvertible: counted.editedUnconvertible },
        );
      }
      await this.records.mergeRevertEdits(scope, conversion.job_id, counted.keptEdits);
      try {
        const reverted = await this.schema.revertConversion(scope, fieldId, context, {
          mode,
          mergedSince: since,
          counts: {
            unchanged: counted.unchanged,
            edited: counted.edited,
            kept: counted.keptEdits.length,
            overwritten: counted.editedUnconvertible,
          },
        });
        return await this.dtoOf(base, reverted);
      } catch (error) {
        if (!(error instanceof ConcurrentFieldEditsError)) throw error;
        if (attempt >= 3) {
          throw new AppError('SCHEMA_LOCKED', {
            detail: 'The field keeps being written; try the revert again.',
            params: { field_id: fieldId },
          });
        }
      }
    }
  }

  // --- Internals ---------------------------------------------------------------------

  /**
   * The plan of a requested definition, target options validated (`422
   * VALIDATION_FAILED` with `options.…` paths); `null` for a target that
   * cannot be converted to (types not available here, no column of its own).
   */
  private planChange(field: FieldRow, body: ConvertFieldPreviewRequest): PlannedChange | null {
    if (isComputedRow(field)) return this.planFromComputed(field, body);
    if (!isS1FieldType(field.type) || !isS1FieldType(body.type)) return null;
    const fromType: S1FieldType = field.type;
    const from = FIELD_TYPE_REGISTRY[fromType];
    const fromOptions = from.optionsSchema.parse(field.options ?? {}) as JsonRecord;
    let requested: unknown = withNewOptionIds(body.type, body.options);
    if (
      body.type === fromType &&
      (fromType === 'select' || fromType === 'user') &&
      fromOptions.multiple === true &&
      isRecord(body.options) &&
      body.options.multiple === false
    ) {
      // CONTRACTS §4.2: only `multiple` changes; options stay as they are.
      requested = {
        ...fromOptions,
        multiple: false,
        default_value: firstDefault(fromOptions.default_value),
      };
    }
    const parsed = FIELD_TYPE_REGISTRY[body.type].optionsSchema.safeParse(requested ?? {});
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {
        errors: zodIssuesToProblemErrors(parsed.error.issues).map((item): ProblemErrorItem => ({
          ...item,
          path: item.path === '' ? 'options' : `options.${item.path}`,
        })),
      });
    }
    const plan = planFieldConversion(
      { type: fromType, options: fromOptions },
      { type: body.type, options: parsed.data },
      settingsOf(body),
    );
    if (plan.kind === 'forbidden') return null;
    return { plan, toOptions: parsed.data };
  }

  private async count(
    base: BaseAccess,
    field: FieldRow,
    plan: FieldConversionPlan,
    access: RecordAccessContext,
  ) {
    if (isComputedRow(field)) {
      // T463: the current computed values, converted as the result type.
      const locale = this.conversionLocale(base);
      return previewComputedSource(
        { query: this.query, members: this.members },
        {
          scope: base.org.scope,
          tableId: field.table_id,
          access,
          fieldId: field.id,
          timeZone: locale.timeZone,
          locale: locale.locale,
        },
        computedSourceOf(field),
        plan,
        locale,
      );
    }
    const column = sourceColumnOf(field.type, field.db_column_name);
    if (column === null) throw new TypeError('field conversion: no source column');
    return previewConversion(
      { query: this.query, members: this.members },
      { scope: base.org.scope, tableId: field.table_id, access, column },
      plan,
      this.conversionLocale(base),
    );
  }

  /** The latest conversion when the revert may undo it; `404` otherwise, `409` while running. */
  private async revertible(scope: OrgScope, field: FieldRow): Promise<FieldConversionRow> {
    const conversion = await this.schema.revertibleConversion(scope, field.id);
    if (conversion === undefined) throw new AppError('NOT_FOUND');
    if (conversion.status === 'running') throw fieldConvertingError(field.id);
    return conversion;
  }

  /** The revert preview of the latest conversion (edited vs unchanged cells). */
  private async countEdits(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    conversion: FieldConversionRow,
  ) {
    const from = storedDefinitionOf(conversion.from_definition);
    const to = storedDefinitionOf(conversion.to_definition);
    const context = conversionContextOf(conversion);
    const plan = planFieldConversion(
      { type: from.type, options: from.options },
      { type: to.type, options: FIELD_TYPE_REGISTRY[to.type].optionsSchema.parse(field.options) },
      context.settings,
    );
    const column = conversion.old_column_name ?? sourceColumnOf(from.type, null);
    if (column === null || field.db_column_name === null) throw new AppError('NOT_FOUND');
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const since = conversion.finished_at ?? conversion.created_at;
    return previewRevert(
      {
        query: this.query,
        members: this.members,
        provablyUntouched: (recordIds, from) =>
          this.auditLogs.recordsProvablyUntouched(base.org.scope, {
            tableId: field.table_id,
            fieldId: field.id,
            recordIds,
            since: from,
          }),
      },
      {
        scope: base.org.scope,
        tableId: field.table_id,
        access,
        column,
        currentColumn: field.db_column_name,
        writable: conversion.old_column_name !== null,
        finishedAt: since,
      },
      plan,
      { locale: context.locale, timeZone: context.timeZone },
    );
  }

  // --- Formula/lookup (T463, CONTRACTS §4.1) ------------------------------------------

  /**
   * "Convert to static values": the plan of a formula/lookup field to a type
   * that stores its values (`null`: forbidden — no column of its own, or not
   * convertible yet). Without `style` the target keeps the result's format.
   */
  private planFromComputed(
    field: FieldRow,
    body: ConvertFieldPreviewRequest,
  ): PlannedChange | null {
    if (!isS1FieldType(body.type) || !isConvertibleTarget(body.type)) return null;
    const source = computedSourceOf(field);
    const requested = inheritComputedStyle(
      source,
      body.type,
      withNewOptionIds(body.type, body.options),
    );
    const parsed = FIELD_TYPE_REGISTRY[body.type].optionsSchema.safeParse(requested);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {
        errors: zodIssuesToProblemErrors(parsed.error.issues).map((item): ProblemErrorItem => ({
          ...item,
          path: item.path === '' ? 'options' : `options.${item.path}`,
        })),
      });
    }
    const plan = planComputedConversion(
      source,
      { type: body.type, options: parsed.data },
      settingsOf(body),
    );
    if (plan.kind === 'forbidden') return null;
    return { plan, toOptions: parsed.data };
  }

  /**
   * Whoever turns a formula/lookup into static values reads every table and
   * field it is computed from (BACKLOG T463: the values are those of every
   * record, whatever the converter's record rules): else `403`.
   */
  private async assertSourcesReadable(base: BaseAccess, field: FieldRow): Promise<void> {
    const rows = await loadBaseSchemaRows(this.db, base.org.scope, base.base.id);
    if (!definitionVisible(field, rows, base.access)) {
      throw permissionDenied(
        'Converting a formula or lookup field needs read access to every table and field it reads.',
      );
    }
  }

  /**
   * The definition a conversion to a formula/lookup would save, checked like
   * a save (`422 FORMULA_*`, `FORMULA_CYCLE` through the field itself) with
   * what the caller reads; `null` when the field cannot become one (the
   * primary field, link/parent/attachment fields).
   */
  private async prepareTarget(
    base: BaseAccess,
    field: FieldRow,
    body: ConvertFieldPreviewRequest,
  ): Promise<PreparedComputedDefinition | null> {
    if (field.is_primary || !(isS1FieldType(field.type) || isComputedRow(field))) return null;
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    const readable = readabilityOf(base.access);
    const options = isRecord(body.options) ? body.options : {};
    const prepared = prepareComputedDefinition(
      {
        type: body.type as 'formula' | 'lookup',
        options,
        expressionForm: 'display',
        style: Object.hasOwn(options, 'style') ? { mode: 'given' } : { mode: 'default' },
      },
      {
        rows,
        tableId: field.table_id,
        readable,
        timeZone: organizationTimeZone(base, this.config.defaults.timezone),
      },
    );
    const edges = [
      ...(await new FieldDependenciesRepository(this.db).listByBase(scope, base.base.id)).filter(
        (edge) => edge.fieldId !== field.id,
      ),
      ...edgesOf(field.id, prepared.analysis.dependencies),
    ];
    const active = new Set<string>(
      rows.fields.filter((row) => isComputedRow(row) || isAiField(row)).map((row) => row.id),
    );
    active.add(field.id);
    const cycle = findCycle(field.id, edges, active);
    if (cycle !== null) throw formulaCycleProblem(cycle, rows, readable);
    return prepared;
  }

  /** The current values a conversion to a formula/lookup replaces (every record). */
  private async replacedValues(base: BaseAccess, field: FieldRow, access: RecordAccessContext) {
    const deps = { query: this.query, members: this.members };
    const target = { scope: base.org.scope, tableId: field.table_id, access };
    if (isComputedRow(field)) {
      const locale = this.conversionLocale(base);
      return previewComputedTarget(deps, target, {
        kind: 'computed',
        fieldId: field.id,
        timeZone: locale.timeZone,
        locale: locale.locale,
      });
    }
    const column = sourceColumnOf(field.type, field.db_column_name);
    if (column === null || !isS1FieldType(field.type)) return { affected: 0, samples: [] };
    const definition = {
      type: field.type,
      options: FIELD_TYPE_REGISTRY[field.type].optionsSchema.parse(field.options ?? {}),
    };
    return previewComputedTarget(deps, target, { kind: 'column', column, definition });
  }

  /**
   * `convert-preview` to a formula/lookup (CONTRACTS §4.1 "any →
   * formula/lookup"): every non-empty cell is replaced (`affected` =
   * `lost`, `requires_confirm` when any; the old values stay 7 days for
   * the revert); samples show the value computed for it (`to`).
   */
  private async previewToComputed(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    body: ConvertFieldPreviewRequest,
  ): Promise<ConvertFieldPreview> {
    const dependents = await this.dependentsOf(principal, base, field);
    const prepared = await this.prepareTarget(base, field, body);
    if (prepared === null) {
      return {
        allowed: false,
        reason: 'CONVERSION_NOT_ALLOWED',
        kind: 'forbidden',
        requires_confirm: false,
        requires_accept_data_loss: false,
        unique_values_reset: false,
        affected: 0,
        lost: 0,
        truncated: 0,
        new_options: [],
        samples: [],
        dependents,
      };
    }
    dependents.push(
      ...(await computedDependentsOf(this.db, base, {
        kind: 'retype_field',
        fieldId: field.id,
        type: body.type,
        options: prepared.options,
        computed: {
          resultType: prepared.resultType,
          computeMode: prepared.computeMode,
        },
      })),
    );
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const replaced = await this.replacedValues(base, field, access);
    const computed =
      replaced.samples.length === 0
        ? []
        : await this.query.previewComputed(base.org.scope, field.table_id, access, {
            analysis: prepared.analysis,
            recordIds: replaced.samples.map((sample) => sample.record_id),
            limit: replaced.samples.length,
            timeZone: organizationTimeZone(base, this.config.defaults.timezone),
            timeoutMs: CONVERT_TO_COMPUTED_PREVIEW_TIMEOUT_MS,
          });
    const values = new Map<string, unknown>(computed.map((row) => [row.id, row.value]));
    return {
      allowed: true,
      reason: null,
      kind: 'keep',
      requires_confirm: replaced.affected > 0,
      requires_accept_data_loss: false,
      unique_values_reset: field.unique_values,
      affected: replaced.affected,
      lost: replaced.affected,
      truncated: 0,
      new_options: [],
      samples: replaced.samples.map((sample) => ({
        record_id: sample.record_id,
        from: sample.from,
        to: values.get(sample.record_id) ?? null,
        outcome: 'lost' as const,
      })),
      dependents,
    };
  }

  /** `PUT /fields/:id` to a formula/lookup (`202`, job `field.convert`). */
  private async convertToComputed(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    body: ConvertFieldRequest,
    meta: RequestMeta,
  ): Promise<ConvertFieldResponse> {
    const scope = base.org.scope;
    const prepared = await this.prepareTarget(base, field, body);
    if (prepared === null) {
      throw conversionNotAllowed(
        field.is_primary
          ? 'The primary field cannot become a formula or lookup field.'
          : `A field cannot be converted from ${field.type} to ${body.type}.`,
        'type',
        { from: field.type, to: body.type },
      );
    }
    if (body.confirm !== true) {
      const access = await recordAccessContextOf(
        { groupMembers: this.groupMembers, config: this.config },
        principal.user,
        base,
      );
      const replaced = await this.replacedValues(base, field, access);
      if (replaced.affected > 0) {
        throw requiresConfirm(
          'The values of the field are replaced by computed ones (kept 7 days for a revert); confirm it.',
          'confirm',
          { lost: replaced.affected, truncated: 0 },
        );
      }
    }
    const { locale, timeZone } = this.conversionLocale(base);
    const started = await this.schema.startConversion(
      scope,
      field.id,
      {
        expectedFrom: { type: field.type, options: field.options },
        toType: body.type,
        toOptions: isRecord(body.options) ? body.options : {},
        settings: {},
        locale,
        timeZone,
        computed: {
          readable: readabilityOf(base.access),
          timeZone: organizationTimeZone(base, this.config.defaults.timezone),
        },
      },
      mutationContextOf(meta, principal.userId),
    );
    return { job_id: started.jobId, field: await this.dtoOf(base, started.field) };
  }

  /**
   * Revert preview of a conversion from or to a formula/lookup: back to a
   * stored type, every cell gets its old value (`unchanged`, nothing was
   * written since: computed cells are read-only); back to a formula/lookup,
   * the cells written since are replaced (`edited` = `edited_unconvertible`:
   * a computed field keeps no edit), `new_field` is not available (it had no
   * values of its own).
   */
  private async computedRevertPreview(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    conversion: FieldConversionRow,
  ): Promise<RevertConversionPreview> {
    const common = {
      job_id: conversion.job_id,
      from_type: definitionTypeOf(conversion.from_definition) as FieldTypeName,
      revertible_until: conversion.expires_at.toISOString(),
    };
    const fromComputed = computedDefinitionOf(conversion.from_definition) !== null;
    if (computedDefinitionOf(conversion.to_definition) !== null) {
      // Computed cells are never written: nothing was edited since.
      return {
        ...common,
        unchanged: countsOf(conversion.counts).affected,
        edited: 0,
        edited_unconvertible: 0,
        new_field_available: conversion.old_column_name !== null && !fromComputed,
        samples: [],
      };
    }
    if (field.db_column_name === null || !isS1FieldType(field.type))
      throw new AppError('NOT_FOUND');
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const counted = await previewComputedRevert(
      {
        query: this.query,
        members: this.members,
        provablyUntouched: (recordIds, from) =>
          this.auditLogs.recordsProvablyUntouched(base.org.scope, {
            tableId: field.table_id,
            fieldId: field.id,
            recordIds,
            since: from,
          }),
      },
      {
        scope: base.org.scope,
        tableId: field.table_id,
        access,
        column: field.db_column_name,
        definition: {
          type: field.type,
          options: FIELD_TYPE_REGISTRY[field.type].optionsSchema.parse(field.options ?? {}),
        },
        finishedAt: conversion.finished_at ?? conversion.created_at,
        lastAuto: conversion.cursor_auto,
      },
    );
    return {
      ...common,
      unchanged: counted.unchanged,
      edited: counted.edited,
      edited_unconvertible: counted.edited,
      new_field_available: false,
      samples: counted.samples,
    };
  }

  /** The table's `data_version` (SPEC §10.4), as text. */
  private async tableDataVersion(scope: OrgScope, tableId: Id<'tbl'>): Promise<string> {
    const table = await new TablesRepository(this.db).getById(scope, tableId);
    if (table === undefined) throw new AppError('NOT_FOUND');
    return String(table.data_version);
  }

  /** Database time (the revert re-checks writes after it). */
  private async dbNow(): Promise<string> {
    // As text: microseconds matter (a JS Date would round the time down).
    const { rows } = await sql<{ now: string }>`SELECT now()::text AS now`.execute(this.db.kysely);
    return rows[0]?.now ?? new Date().toISOString();
  }

  /** Base locale (CONTRACTS §2 typecast) and organization zone of a conversion. */
  private conversionLocale(base: BaseAccess): { locale: string; timeZone: string } {
    const settings = base.org.membership.settings;
    const locale =
      [settingOf(base.base.settings, 'locale'), settingOf(settings, 'locale')].find(isLocale) ??
      this.config.defaults.locale;
    return {
      locale,
      timeZone: firstTimeZone([settingOf(settings, 'timezone')], this.config.defaults.timezone),
    };
  }

  /**
   * `GET /fields/:id/delete-preview` (T460, CONTRACTS §13): the views and
   * roles using the field (like the conversion preview) and the
   * formula/lookup fields its deletion would put in `REF`. The caller has
   * schema rights on the table (checked by the field service).
   */
  async deleteDependentsOf(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
  ): Promise<FieldDependent[]> {
    return [
      ...(await this.dependentsOf(principal, base, field)),
      ...(await computedDependentsOf(this.db, base, {
        kind: 'delete_fields',
        fieldIds: [field.id],
      })),
    ];
  }

  /** CONTRACTS §4.4 `dependents`: views the caller sees; roles for base admins only. */
  private async dependentsOf(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
  ): Promise<FieldDependent[]> {
    const scope = base.org.scope;
    const views = await this.views.listByTable(scope, field.table_id, principal.userId);
    const roles = base.access.is_admin ? await this.roles.listByBase(scope, base.base.id) : [];
    return fieldDependents(
      field.id,
      field.table_id,
      views.map((view) => ({ id: view.id, config: view.config })),
      roles.map((role) => ({ id: role.id, config: role.config })),
    );
  }
}

/** A column conversion from or to a formula/lookup (T463). */
function isComputedConversion(row: FieldConversionRow): boolean {
  return (
    row.kind === 'column' &&
    (computedDefinitionOf(row.from_definition) !== null ||
      computedDefinitionOf(row.to_definition) !== null)
  );
}

function stateOf(row: FieldConversionRow): FieldConversionState {
  return {
    job_id: row.job_id,
    status: row.status === 'running' ? 'running' : 'succeeded',
    from_type: definitionTypeOf(row.from_definition) as FieldTypeName,
    to_type: definitionTypeOf(row.to_definition) as FieldTypeName,
    revertible_until: row.expires_at.toISOString(),
    // T404: a link conversion keeps the type.
    ...(row.kind === 'column' ? {} : { link_change: row.kind }),
  };
}
