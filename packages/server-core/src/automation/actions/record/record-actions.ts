import {
  isId,
  type AutomationAction,
  type AutomationFieldValues,
  type AutomationValue,
  type Id,
} from '@cellhive/contracts';

import { AutomationStepError } from '../../engine/errors.js';

import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type { RecordMutationService } from '../../../records/record-mutation.service.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { TemplateWarning } from '../../values/evaluator.js';

/**
 * Record actions (SPEC §11.5, BACKLOG T505): `create_record`,
 * `update_record`, `delete_record`, `find_records`, through the single
 * read/write path (`RecordQueryService` / `RecordMutationService`, AGENTS.md
 * rule 1) with the access of `run_as` now, `actor_type = automation`,
 * `via`, `batch_id = run_…` and the run's causation (the loop guard of the
 * events they write). Writes mark their step `succeeded` in their own
 * transaction (`complete`), so a resumed run never writes twice.
 *
 * Before writing, the table/field permissions of `run_as` now are checked:
 * missing ones mean `run_as` lost access (`permission_denied`,
 * `scope: table` — T507 checks the automation); a record outside its rules
 * is refused by the record service (`scope: record`, P29 — the automation
 * stays on).
 */

export interface RecordActionServices {
  readonly records: RecordMutationService;
  readonly query: RecordQueryService;
}

type Ctx<T extends AutomationAction['type']> = AutomationActionContext & {
  readonly action: Extract<AutomationAction, { type: T }>;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `run_as` lost the table or a field the action needs: the definition is no longer valid for it. */
function lostAccess(message: string, params: Record<string, unknown>): AutomationStepError {
  return new AutomationStepError('permission_denied', message, {
    params: { scope: 'table', ...params },
  });
}

/** Table-level permission of `run_as` now (CONTRACTS §5A), as the definition check of ADR-25 §3. */
export function requireTable(
  context: AutomationActionContext,
  tableId: Id<'tbl'>,
  need: { readonly write: boolean; readonly operation?: 'add' | 'delete' },
): void {
  const table = context.schema.access.tables[tableId];
  if (table === undefined || !context.schema.tables.some((item) => item.id === tableId)) {
    throw lostAccess('run_as cannot read the table', { table_id: tableId });
  }
  if (!need.write) return;
  if (
    (table.perm !== 'edit' && table.perm !== 'manage') ||
    (need.operation !== undefined && !table.operations.includes(need.operation))
  ) {
    throw lostAccess('run_as cannot write records of the table', {
      table_id: tableId,
      ...(need.operation === undefined ? {} : { operation: need.operation }),
    });
  }
}

export function requireWritableFields(
  context: AutomationActionContext,
  tableId: Id<'tbl'>,
  fieldIds: readonly string[],
  mode: 'create' | 'edit',
): void {
  const table = context.schema.access.tables[tableId];
  for (const fieldId of fieldIds) {
    const perm = table?.fields[fieldId as Id<'fld'>];
    if (perm === 'edit' || (mode === 'create' && perm === 'create')) continue;
    throw lostAccess('run_as cannot write a field of the action', { field_id: fieldId });
  }
}

/**
 * A value as the record service takes it (typecast on): cells read in
 * `cell_format=json` keep only what a write needs — `{ id, … }` items
 * (records, users, attachments) become `{ id }` (CONTRACTS §2); everything
 * else is written as is.
 */
function writable(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as unknown[]).map((item) =>
    isObject(item) && typeof item['id'] === 'string' ? { id: item['id'] } : item,
  );
}

export async function resolveFields(
  context: AutomationActionContext,
  values: AutomationFieldValues,
): Promise<{ fields: Record<string, unknown>; warnings: TemplateWarning[] }> {
  const fields: Record<string, unknown> = {};
  const warnings: TemplateWarning[] = [];
  for (const [fieldId, value] of Object.entries(values)) {
    const resolved = await context.values.resolve(value);
    fields[fieldId] = writable(resolved.value);
    warnings.push(...resolved.warnings);
  }
  return { fields, warnings };
}

/** `{ id }`, plus the render warnings when there are any (codes only). */
function outputOf(id: string, warnings: readonly TemplateWarning[]): JsonObject {
  return {
    id,
    ...(warnings.length === 0 ? {} : { warnings: warnings as unknown as JsonValue }),
  };
}

/** A record id from a value: `rec_…`, `{ id }`, or a one-item list of those. */
async function recordIdOf(
  context: AutomationActionContext,
  value: AutomationValue,
): Promise<Id<'rec'>> {
  const resolved = (await context.values.resolve(value)).value;
  const first = Array.isArray(resolved) ? (resolved as unknown[])[0] : resolved;
  const id = isObject(first) ? first['id'] : first;
  if (typeof id === 'string' && isId('rec', id)) return id;
  throw new AutomationStepError('invalid_value', 'The record id is empty or not a record id', {
    params: { field: 'record_id' },
  });
}

function triggerRecord(context: AutomationActionContext): {
  tableId: Id<'tbl'>;
  recordId: Id<'rec'>;
} {
  const { triggerTableId, triggerRecordId } = context.run;
  if (triggerTableId === null || triggerRecordId === null) {
    throw new AutomationStepError('invalid_value', 'The trigger has no record', {
      params: { field: 'record_id' },
    });
  }
  return { tableId: triggerTableId, recordId: triggerRecordId };
}

export function createRecordActions(
  services: RecordActionServices,
): ReadonlyMap<string, AutomationActionHandler> {
  const { records, query } = services;

  const createRecord: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'create_record'>;
      const tableId = context.action.config.table_id;
      requireTable(context, tableId, { write: true, operation: 'add' });
      requireWritableFields(context, tableId, Object.keys(context.action.config.fields), 'create');
      const { fields, warnings } = await resolveFields(context, context.action.config.fields);
      let output: JsonObject = {};
      await records.create(
        context.scope,
        tableId,
        context.access.record,
        { field_key_type: 'id', typecast: true, records: [{ fields }] },
        context.audit,
        {
          causation: context.causation,
          readBack: false,
          onCreated: async (tx, ids) => {
            output = outputOf(ids[0] as string, warnings);
            await context.complete(tx, output);
          },
        },
      );
      return { output, warnings };
    },
  };

  const updateRecord: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'update_record'>;
      const { config } = context.action;
      const target =
        config.record_id === null
          ? triggerRecord(context)
          : { tableId: config.table_id, recordId: await recordIdOf(context, config.record_id) };
      requireTable(context, target.tableId, { write: true });
      requireWritableFields(context, target.tableId, Object.keys(config.fields), 'edit');
      const { fields, warnings } = await resolveFields(context, config.fields);
      const output = outputOf(target.recordId, warnings);
      await records.update(
        context.scope,
        target.tableId,
        context.access.record,
        { field_key_type: 'id', typecast: true, records: [{ id: target.recordId, fields }] },
        context.audit,
        { causation: context.causation, beforeCommit: (tx) => context.complete(tx, output) },
      );
      return { output, warnings };
    },
  };

  const deleteRecord: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'delete_record'>;
      const target = triggerRecord(context);
      requireTable(context, target.tableId, { write: true, operation: 'delete' });
      const output = outputOf(target.recordId, []);
      await records.delete(
        context.scope,
        target.tableId,
        context.access.record,
        { ids: [target.recordId] },
        context.audit,
        { causation: context.causation, beforeCommit: (tx) => context.complete(tx, output) },
      );
      return { output };
    },
  };

  const findRecords: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'find_records'>;
      const { config } = context.action;
      requireTable(context, config.table_id, { write: false });
      const fields = readableFields(context, config.table_id, config.fields);
      const result = await query.query(context.scope, config.table_id, context.access.record, {
        field_key_type: 'id',
        cell_format: 'json',
        fields,
        ...(config.filter === null ? {} : { filter: config.filter }),
        sort: config.sort,
        limit: config.limit,
        include_total: true,
      });
      const found = result.records.map((record) => ({
        id: record.id,
        fields: record.fields as JsonObject,
      }));
      const total =
        'total' in result && typeof result.total === 'number'
          ? result.total
          : 'total_estimate' in result && typeof result.total_estimate === 'number'
            ? result.total_estimate
            : found.length;
      const count = Math.max(total, found.length);
      return {
        output: { records: found, count, truncated: count > found.length },
      };
    },
  };

  return new Map([
    ['create_record', createRecord],
    ['update_record', updateRecord],
    ['delete_record', deleteRecord],
    ['find_records', findRecords],
  ]);
}

/**
 * Fields a `find_records` step returns: its `fields` (else the primary
 * field) that `run_as` reads now — never one it cannot read (BACKLOG T505).
 */
function readableFields(
  context: AutomationActionContext,
  tableId: Id<'tbl'>,
  requested: readonly string[],
): string[] {
  const access = context.schema.access.tables[tableId];
  const primary = context.schema.tables.find((table) => table.id === tableId)?.primary_field_id;
  const wanted = requested.length > 0 ? requested : primary == null ? [] : [primary];
  return wanted.filter((fieldId) => {
    const perm = access?.fields[fieldId as Id<'fld'>];
    return (
      perm !== undefined &&
      context.schema.lockedFieldIds?.has(fieldId) !== true &&
      context.schema.fields.some((field) => field.id === fieldId && field.table_id === tableId)
    );
  });
}
