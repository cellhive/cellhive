import {
  COMPUTED_PREVIEW_LIMIT,
  type ComputedPreview,
  type ComputedPreviewRequest,
  type Id,
} from '@cellhive/contracts';
import {
  edgesOf,
  FieldDependenciesRepository,
  findCycle,
  formulaCycleProblem,
  GroupMembersRepository,
  isComputedRow,
  loadBaseSchemaRows,
  prepareComputedDefinition,
  RecordQueryService,
  type AppConfig,
  type ComputedDefinitionInput,
  type Db,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound } from '../../common/access/access.service.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { organizationTimeZone, readabilityOf } from './computed-fields.js';

import type { Principal } from '../../common/auth/principal.js';

/** `statement_timeout` of a preview (BACKLOG T456): slower is `504 QUERY_TIMEOUT`. */
export const COMPUTED_PREVIEW_TIMEOUT_MS = 2000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `POST /tables/:tableId/computed-preview` (BACKLOG T456, SPEC §9.6,
 * CONTRACTS §13): a formula/lookup definition checked exactly like a save
 * (same `422` errors with positions; cycles through `field_id` when an
 * existing field is edited) and computed on the first 5 records the caller
 * reads, with the caller's read scope on every source table. Schema rights
 * on the table are needed (like saving): `403` when the table is visible,
 * `404` otherwise.
 */
@Injectable()
export class ComputedPreviewService {
  constructor(
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async preview(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: ComputedPreviewRequest,
  ): Promise<ComputedPreview> {
    const { base, table } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    const readable = readabilityOf(base.access);
    const timeZone = organizationTimeZone(base, this.config.defaults.timezone);
    const editing =
      body.field_id === undefined
        ? undefined
        : rows.fields.find((field) => field.id === body.field_id);
    if (
      body.field_id !== undefined &&
      (editing === undefined ||
        editing.table_id !== table.id ||
        !isComputedRow(editing) ||
        !readable.field(table.id, editing.id))
    ) {
      throw notFound();
    }
    const options = isRecord(body.options) ? body.options : {};
    const input: ComputedDefinitionInput = {
      type: body.type,
      options,
      expressionForm: 'display',
      style: Object.hasOwn(options, 'style') ? { mode: 'given' } : { mode: 'default' },
    };
    const prepared = prepareComputedDefinition(input, { rows, tableId, readable, timeZone });
    if (editing !== undefined) {
      const edges = [
        ...(await new FieldDependenciesRepository(this.db).listByBase(scope, base.base.id)).filter(
          (edge) => edge.fieldId !== editing.id,
        ),
        ...edgesOf(editing.id, prepared.analysis.dependencies),
      ];
      const active = new Set<string>(rows.fields.filter(isComputedRow).map((row) => row.id));
      const cycle = findCycle(editing.id, edges, active);
      if (cycle !== null) throw formulaCycleProblem(cycle, rows, readable);
    }
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const records = await this.records.previewComputed(scope, tableId, access, {
      analysis: prepared.analysis,
      ...(body.record_ids === undefined ? {} : { recordIds: body.record_ids }),
      limit: COMPUTED_PREVIEW_LIMIT,
      timeZone,
      timeoutMs: COMPUTED_PREVIEW_TIMEOUT_MS,
    });
    return {
      result_type: prepared.publicType,
      compute_mode: prepared.computeMode,
      style: prepared.style as Record<string, unknown> | null,
      perf_warning: prepared.perfWarning,
      records: records.map((record) => ({ id: record.id, value: record.value })),
    };
  }
}
