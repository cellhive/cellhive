import {
  FIELD_CONVERSION_SAMPLE_LIMIT,
  LINK_OVER_LIMIT_SAMPLE_LIMIT,
  type ConvertFieldPreview,
  type ConvertFieldPreviewRequest,
  type ConvertFieldRequest,
  type FieldConversionSample,
  type FieldDependent,
  type Id,
  type LinkConversionChangeDto,
  type ProblemErrorItem,
  type RevertConversionPreview,
  type RevertConversionRequest,
} from '@cellhive/contracts';
import {
  classifyLinkConversion,
  LINK_MAX_PER_CELL,
  LINK_OTHER_TYPE_PLAN,
  linkOptionsSchema,
  type LinkConversionPlan,
  type LinkOptions,
} from '@cellhive/field-types';
import {
  AuditLogsRepository,
  BaseRolesRepository,
  fieldConvertingError,
  fieldDependents,
  GroupMembersRepository,
  RecordQueryService,
  SchemaService,
  ViewsRepository,
  type AppConfig,
  type Db,
  type FieldConversionRow,
  type FieldRow,
  type LinkCellCountRow,
  type LinkFieldContext,
  type OrgScope,
  type RecordAccessContext,
} from '@cellhive/server-core';
import { AppError, zodIssuesToProblemErrors } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { canManageTable } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { computedDependentsOf } from './computed-fields.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** Cells read per statement by link previews (each page its own read transaction). */
const LINK_SCAN_PAGE = 10_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A planned change of a link field. */
interface PlannedLinkChange {
  readonly plan: LinkConversionPlan;
  readonly from: LinkOptions;
  readonly to: LinkOptions;
  /** The request's options (a `none` change is applied from them, like a `PATCH`). */
  readonly requested: JsonRecord;
}

/** What a link preview counts. */
interface LinkCounts {
  readonly affected: number;
  readonly truncated: number;
  readonly overLimit: number | undefined;
  readonly overLimitSamples: { record_id: Id<'rec'>; links: number }[] | undefined;
  readonly samples: FieldConversionSample[];
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

function requiresConfirm(detail: string, params: JsonRecord): AppError {
  return new AppError('CONVERSION_REQUIRES_CONFIRM', {
    detail,
    errors: [{ path: 'confirm', code: 'CONVERSION_REQUIRES_CONFIRM', message: detail, params }],
  });
}

/**
 * Link conversions (ADR-28, CONTRACTS §4; BACKLOG T404) behind
 * `FieldConversionService`: previews, `PUT` and the revert of
 * `to_two_way`, `to_one_way` and `to_single`. Schema rights are needed on
 * the field's table (checked by the caller) and, when the other side
 * changes, on the linked table: not visible → `404`, visible without
 * rights → `403` (AGENTS.md rule 4). Cells are read through
 * `RecordQueryService` only.
 */
@Injectable()
export class LinkConversionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SchemaService) private readonly schema: SchemaService,
    @Inject(RecordQueryService) private readonly query: RecordQueryService,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(AuditLogsRepository) private readonly auditLogs: AuditLogsRepository,
    @Inject(BaseRolesRepository) private readonly roles: BaseRolesRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Whether a request converts to or from `link` (handled here). */
  handles(field: FieldRow, body: ConvertFieldPreviewRequest): boolean {
    return field.type === 'link' || body.type === 'link';
  }

  /** `POST /fields/:id/convert-preview` of a link field. */
  async preview(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    body: ConvertFieldPreviewRequest,
  ): Promise<ConvertFieldPreview> {
    const planned = this.planChange(field, body);
    const empty = {
      requires_accept_data_loss: false,
      unique_values_reset: false,
      affected: 0,
      lost: 0,
      truncated: 0,
      new_options: [],
      samples: [],
    };
    if (planned.plan.kind === 'forbidden') {
      return {
        allowed: false,
        reason: 'CONVERSION_NOT_ALLOWED',
        kind: 'forbidden',
        requires_confirm: false,
        ...empty,
        dependents: await this.dependentsOf(principal, base, field.id, field.table_id),
      };
    }
    const change = planned.plan.change;
    if (change === null) {
      return {
        allowed: true,
        reason: null,
        kind: 'none',
        requires_confirm: false,
        ...empty,
        dependents: [],
      };
    }
    this.assertLinkedTableRights(base, planned.from, change);
    const partner = this.partnerOf(planned.from, change);
    const dependents =
      change === 'to_one_way'
        ? partner.partner_field_id === null
          ? []
          : await this.dependentsOf(
              principal,
              base,
              partner.partner_field_id,
              partner.partner_table_id,
              true,
            )
        : change === 'to_single'
          ? await this.dependentsOf(principal, base, field.id, field.table_id)
          : [];
    const access = await this.accessOf(principal, base);
    const counts = await this.count(base.org.scope, field, change, access);
    return {
      allowed: true,
      reason: null,
      kind: planned.plan.kind,
      requires_confirm:
        change === 'to_single' || (change === 'to_one_way' && dependents.length > 0),
      ...empty,
      affected: counts.affected,
      truncated: counts.truncated,
      samples: counts.samples,
      dependents,
      link_change: partner,
      ...(counts.overLimit === undefined ? {} : { over_limit: counts.overLimit }),
      ...(counts.overLimitSamples === undefined
        ? {}
        : { over_limit_samples: counts.overLimitSamples }),
    };
  }

  /**
   * `PUT /fields/:id` of a link field: a `none` change is applied at once
   * like a `PATCH` (`jobId` `null`); a direction change or `to_single` goes
   * through `SchemaService.startLinkConversion` and the `field.convert` job.
   */
  async convert(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    body: ConvertFieldRequest,
    meta: RequestMeta,
  ): Promise<{ readonly field: FieldRow; readonly jobId: Id<'job'> | null }> {
    const scope = base.org.scope;
    const context = mutationContextOf(meta, principal.userId);
    const running = await this.schema.revertibleConversion(scope, field.id);
    if (running?.status === 'running') throw fieldConvertingError(field.id);
    const planned = this.planChange(field, body);
    const { plan } = planned;
    if (plan.kind === 'forbidden') {
      if (plan.refusal === 'other_type') {
        throw conversionNotAllowed(
          `A field cannot be converted from ${field.type} to ${body.type}.`,
          'type',
          { from: field.type, to: body.type },
        );
      }
      throw conversionNotAllowed(
        plan.refusal === 'link_table'
          ? 'The linked table of a link field cannot be changed.'
          : 'Change the direction and allow_multiple of a link in separate conversions.',
        plan.refusal === 'link_table' ? 'options.link_table' : 'options',
      );
    }
    const change = plan.change;
    if (change === null) {
      const { field: updated } = await this.schema.updateFieldWithJob(
        scope,
        field.id,
        {
          optionsPatch: planned.requested,
          optionsBase: field.options,
          link: this.linkContextOf(base, planned.from.link_table),
        },
        context,
      );
      return { field: updated, jobId: null };
    }
    this.assertLinkedTableRights(base, planned.from, change);
    let counts: { total: number; affected: number } | undefined;
    if (change === 'to_two_way') {
      const name = isRecord(body.options) ? body.options.bidirectional_link_field_name : undefined;
      if (typeof name !== 'string' || name.trim() === '') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Name the reverse field of the two-way link.',
          errors: [
            {
              path: 'options.bidirectional_link_field_name',
              code: 'REQUIRED',
              message: 'Required to turn a link two-way',
            },
          ],
        });
      }
    } else if (change === 'to_one_way') {
      const partner = this.partnerOf(planned.from, change);
      const dependents =
        partner.partner_field_id === null
          ? []
          : await this.dependentsOf(
              principal,
              base,
              partner.partner_field_id,
              partner.partner_table_id,
              true,
            );
      if (dependents.length > 0 && body.confirm !== true) {
        throw requiresConfirm(
          'The other side of the link is used elsewhere and goes to the trash; confirm it.',
          { dependents: dependents.length },
        );
      }
    } else {
      if (body.confirm !== true) {
        throw requiresConfirm('Each cell keeps only its first link; confirm it.', {
          kind: plan.kind,
        });
      }
      const access = await this.accessOf(principal, base);
      const counted = await this.count(scope, field, change, access);
      counts = { total: counted.truncated, affected: counted.affected };
    }
    const started = await this.schema.startLinkConversion(
      scope,
      field.id,
      {
        expectedOptions: field.options,
        change,
        reverseName:
          change === 'to_two_way' ? (planned.to.bidirectional_link_field_name ?? null) : null,
        ...(counts === undefined ? {} : { counts }),
      },
      context,
    );
    return { field: started.field, jobId: started.jobId };
  }

  /** `POST /fields/:id/revert-conversion/preview` of a link conversion. */
  async revertPreview(
    base: BaseAccess,
    field: FieldRow,
    conversion: FieldConversionRow,
  ): Promise<RevertConversionPreview> {
    const change = this.assertRevertRights(base, field, conversion);
    let unchanged = 0;
    let edited = 0;
    if (change.change === 'to_single') {
      const counted = await this.cutCells(base.org.scope, field, conversion);
      unchanged = counted.cut.length - counted.edited.size;
      edited = counted.edited.size;
    }
    return {
      job_id: conversion.job_id,
      from_type: 'link',
      revertible_until: conversion.expires_at.toISOString(),
      unchanged,
      edited,
      edited_unconvertible: 0,
      new_field_available: false,
      samples: [],
      link_change: change,
    };
  }

  /** `POST /fields/:id/revert-conversion` of a link conversion. */
  async revert(
    principal: Principal,
    base: BaseAccess,
    field: FieldRow,
    conversion: FieldConversionRow,
    body: RevertConversionRequest,
    meta: RequestMeta,
  ): Promise<FieldRow> {
    const change = this.assertRevertRights(base, field, conversion);
    const mode = body.mode ?? 'keep_later_edits';
    if (mode === 'new_field') {
      throw conversionNotAllowed(
        'A link conversion has no old version to restore as a new field.',
        'mode',
      );
    }
    if (mode === 'overwrite_later_edits' && change.change === 'to_single') {
      const counted = await this.cutCells(base.org.scope, field, conversion);
      if (counted.edited.size > 0 && body.confirm !== true) {
        throw requiresConfirm(
          'Cells were edited since the conversion; overwriting them loses those edits. Confirm it.',
          { edited: counted.edited.size },
        );
      }
    }
    return this.schema.revertLinkConversion(
      base.org.scope,
      field.id,
      mutationContextOf(meta, principal.userId),
      mode,
    );
  }

  // --- Internals ---------------------------------------------------------------------

  /**
   * The plan of a request: `link` ↔ another type is forbidden; for a link
   * the requested options are merged over the current ones (keys left out
   * stay) and validated (`422 VALIDATION_FAILED`, paths under `options.`).
   */
  private planChange(field: FieldRow, body: ConvertFieldPreviewRequest): PlannedLinkChange {
    const from = linkOptionsSchema.safeParse(field.options);
    const requested = isRecord(body.options) ? body.options : {};
    if (field.type !== 'link' || body.type !== 'link' || !from.success) {
      const current = from.success ? from.data : ({} as LinkOptions);
      return { plan: LINK_OTHER_TYPE_PLAN, from: current, to: current, requested };
    }
    const parsed = linkOptionsSchema.safeParse({
      ...from.data,
      ...requested,
      // Read-only (CONTRACTS §13): never taken from the request.
      symmetric_field_id: from.data.symmetric_field_id,
    });
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {
        errors: zodIssuesToProblemErrors(parsed.error.issues).map((item): ProblemErrorItem => ({
          ...item,
          path: item.path === '' ? 'options' : `options.${item.path}`,
        })),
      });
    }
    return {
      plan: classifyLinkConversion(from.data, parsed.data),
      from: from.data,
      to: parsed.data,
      requested,
    };
  }

  /**
   * ADR-28: turning a link two-way or one-way changes the linked table, so
   * it needs schema rights there too (`404` when the caller does not see
   * it, `403` when it does); so does cutting a two-way link (its reverse
   * cells change).
   */
  private assertLinkedTableRights(
    base: BaseAccess,
    from: LinkOptions,
    change: LinkConversionChangeDto['change'],
  ): void {
    if (change === 'to_single' && !from.bidirectional) return;
    assertTableRights(base, from.link_table);
  }

  /** `link_change` of a preview. */
  private partnerOf(
    from: LinkOptions,
    change: LinkConversionChangeDto['change'],
  ): LinkConversionChangeDto {
    return {
      change,
      partner_table_id: from.link_table,
      partner_field_id: change === 'to_two_way' ? null : from.symmetric_field_id,
    };
  }

  /** The conversion's `link_change`, with schema rights on both tables when the other side changes. */
  private assertRevertRights(
    base: BaseAccess,
    field: FieldRow,
    conversion: FieldConversionRow,
  ): LinkConversionChangeDto {
    const change = conversion.kind as LinkConversionChangeDto['change'];
    const from = linkOptionsSchema.parse(field.options);
    if (change !== 'to_single' || conversion.partner_table_id !== null) {
      assertTableRights(base, conversion.partner_table_id ?? from.link_table);
    }
    return {
      change,
      partner_table_id: conversion.partner_table_id ?? from.link_table,
      partner_field_id: conversion.partner_field_id,
    };
  }

  /** Cut cells of a `to_single` conversion and those written since (kept by the default revert). */
  private async cutCells(scope: OrgScope, field: FieldRow, conversion: FieldConversionRow) {
    const cut = await this.query.linkConversionCutCells(scope, conversion);
    const edited = await this.auditLogs.recordsWithFieldChangesSince(scope, {
      tableId: field.table_id,
      fieldId: field.id,
      recordIds: cut,
      since: conversion.finished_at ?? conversion.created_at,
    });
    return { cut, edited };
  }

  private async accessOf(principal: Principal, base: BaseAccess): Promise<RecordAccessContext> {
    return recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
  }

  /**
   * Counts of a link preview, over every cell (records in the trash too):
   * `affected` = non-empty cells of the field; `to_single`: `truncated` =
   * cells holding more than one link (samples: the caller's readable ones,
   * `from` = the cell, `to` = its first link); `to_two_way`: `over_limit` =
   * reverse cells that would hold more than 500 links to live records.
   */
  private async count(
    scope: OrgScope,
    field: FieldRow,
    change: LinkConversionChangeDto['change'],
    access: RecordAccessContext,
  ): Promise<LinkCounts> {
    let affected = 0;
    let truncated = 0;
    const cutIds: Id<'rec'>[] = [];
    await this.scan(scope, field.id, access, 'own', (row) => {
      affected += 1;
      if (row.links > 1) {
        truncated += 1;
        if (row.readable && cutIds.length < FIELD_CONVERSION_SAMPLE_LIMIT) cutIds.push(row.id);
      }
    });
    if (change === 'to_two_way') {
      let overLimit = 0;
      const samples: { record_id: Id<'rec'>; links: number }[] = [];
      await this.scan(scope, field.id, access, 'reverse', (row) => {
        if (row.links <= LINK_MAX_PER_CELL) return;
        overLimit += 1;
        if (row.readable && samples.length < LINK_OVER_LIMIT_SAMPLE_LIMIT) {
          samples.push({ record_id: row.id, links: row.links });
        }
      });
      return { affected, truncated: 0, overLimit, overLimitSamples: samples, samples: [] };
    }
    if (change !== 'to_single') {
      return {
        affected,
        truncated: 0,
        overLimit: undefined,
        overLimitSamples: undefined,
        samples: [],
      };
    }
    const records = await this.query.getRecords(scope, field.table_id, cutIds, access, {
      fields: [field.id],
      field_key_type: 'id',
    });
    const samples = records.flatMap((record): FieldConversionSample[] => {
      const value = record.fields[field.id];
      if (!Array.isArray(value)) return [];
      return [
        {
          record_id: record.id,
          from: value,
          to: value.slice(0, 1),
          outcome: 'truncated',
        },
      ];
    });
    return { affected, truncated, overLimit: undefined, overLimitSamples: undefined, samples };
  }

  private async scan(
    scope: OrgScope,
    fieldId: Id<'fld'>,
    access: RecordAccessContext,
    side: 'own' | 'reverse',
    visit: (row: LinkCellCountRow) => void,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const rows = await this.query.scanLinkCells(scope, fieldId, access, {
        side,
        after,
        limit: LINK_SCAN_PAGE,
      });
      rows.forEach(visit);
      const last = rows.at(-1);
      if (rows.length < LINK_SCAN_PAGE || last === undefined) return;
      after = last.id;
    }
  }

  /**
   * CONTRACTS §4.4 `dependents` of a field: views the caller sees; roles for
   * base admins only; with `deleted` (the other side of a `to_one_way`), the
   * formula/lookup fields its deletion puts in `REF` (T460, ADR-28 §2).
   */
  private async dependentsOf(
    principal: Principal,
    base: BaseAccess,
    fieldId: Id<'fld'>,
    tableId: Id<'tbl'>,
    deleted = false,
  ): Promise<FieldDependent[]> {
    const scope = base.org.scope;
    const views = await this.views.listByTable(scope, tableId, principal.userId);
    const roles = base.access.is_admin ? await this.roles.listByBase(scope, base.base.id) : [];
    return [
      ...fieldDependents(
        fieldId,
        tableId,
        views.map((view) => ({ id: view.id, config: view.config })),
        roles.map((role) => ({ id: role.id, config: role.config })),
      ),
      ...(deleted
        ? await computedDependentsOf(this.db, base, { kind: 'delete_fields', fieldIds: [fieldId] })
        : []),
    ];
  }

  /** Fields of the linked table the caller reads (`record_filter` of a `none` change). */
  private linkContextOf(base: BaseAccess, target: Id<'tbl'>): LinkFieldContext {
    const fields = base.access.tables[target]?.fields;
    return {
      readableTargetFieldIds: new Set(
        Object.entries(fields ?? {})
          .filter(([, perm]) => (perm as string) !== 'no_perm')
          .map(([id]) => id),
      ),
    };
  }
}

/** Schema rights on the other table of a link: `404` when not visible, `403` without rights. */
function assertTableRights(base: BaseAccess, tableId: Id<'tbl'>): void {
  if (base.access.tables[tableId] === undefined) throw notFound();
  if (!canManageTable(base.access, tableId)) {
    throw permissionDenied('Changing a two-way link needs schema rights on both tables.');
  }
}
