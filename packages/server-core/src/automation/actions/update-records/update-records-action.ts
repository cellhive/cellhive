import {
  UPDATE_RECORDS_ANALYZE_AFTER,
  UPDATE_RECORDS_BATCH_SIZE,
  type Id,
  type UpdateRecordsAction,
} from '@cellhive/contracts';

import { AppError } from '../../../errors/app-error.js';
import { AutomationStepError } from '../../engine/errors.js';
import { requireTable, requireWritableFields, resolveFields } from '../record/record-actions.js';

import { filterValueSlots, withFilterValues } from './filter-values.js';
import { filterOperandOf } from './operands.js';

import type { JsonObject, JsonValue } from '../../../db/schema.js';
import type { RecordMutationService } from '../../../records/record-mutation.service.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type { SchemaService } from '../../../schema/schema.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type { TemplateWarning } from '../../values/evaluator.js';

/**
 * `update_records` (SPEC §11.5, §11.7; ADR-26 §6; BACKLOG T506): changes
 * the live records of a table that match `filter` and that `run_as` may
 * change now (read **and** edit rule), through `RecordMutationService`
 * with `actor_type = automation`, `via`, `batch_id = run_…` and the run's
 * causation — so their events are bulk (`batch.size ≥ 2`) for the
 * automations downstream, one level deeper for the loop guard.
 *
 * 1. Values of SPEC §11.4 inside `filter` and the field values are
 *    resolved once (as for `update_record`).
 * 2. First attempt: the matching records are counted (up to `limit + 1`);
 *    more than `limit` → `failed` `too_many_records`, nothing written.
 *    Matching records `run_as` reads but may not edit are counted apart
 *    (`skipped_not_editable`, shown in the run history) and left alone.
 * 3. Batches of ≤ 1 000 records in `__id` order, each in one transaction
 *    with the step's progress (`{ matched, updated, batches,
 *    last_record_id, skipped_not_editable }`); a retry (temporary error, worker killed) reads it
 *    back and goes on after `last_record_id` — committed batches are never
 *    written again. At most `limit` records are written in all.
 * 4. ≥ 10 000 records written → `ANALYZE` of the table through
 *    `SchemaService` (S4b-review §6 #5), best effort.
 */
export interface UpdateRecordsServices {
  readonly records: RecordMutationService;
  readonly query: RecordQueryService;
  /** `ANALYZE` after large writes; absent → never (tests, tools). */
  readonly schema?: Pick<SchemaService, 'analyzeComputedTable'>;
  /** Records per batch (default 1 000; tests use fewer). */
  readonly batchSize?: number;
  /** Written records from which the table is analyzed (default 10 000). */
  readonly analyzeAfter?: number;
}

/** Progress saved in the step output after each batch. */
interface Progress {
  readonly matched: number;
  readonly updated: number;
  readonly batches: number;
  readonly last_record_id: Id<'rec'> | null;
  /** Matching records `run_as` reads but may not edit: left alone (counted up to `limit + 1`). */
  readonly skipped_not_editable: number;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function progressOf(previous: JsonObject | null): Progress | null {
  if (previous === null) return null;
  const { matched, updated, batches } = previous;
  const last = previous['last_record_id'];
  const notEditable = previous['skipped_not_editable'];
  if (typeof matched !== 'number' || typeof updated !== 'number' || typeof batches !== 'number') {
    return null;
  }
  return {
    matched,
    updated,
    batches,
    last_record_id: typeof last === 'string' ? (last as Id<'rec'>) : null,
    skipped_not_editable: typeof notEditable === 'number' ? notEditable : 0,
  };
}

function withWarnings(output: JsonObject, warnings: readonly TemplateWarning[]): JsonObject {
  return warnings.length === 0 ? output : { ...output, warnings: warnings as unknown as JsonValue };
}

/** A filter `run_as` can no longer test (a field it cannot read) vs. a bad resolved value. */
function filterError(error: unknown): never {
  if (error instanceof AppError && error.code === 'INVALID_FILTER') {
    const lostField = (error.errors ?? []).some((issue) => issue.code === 'UNKNOWN_FIELD');
    if (lostField) {
      throw new AutomationStepError('permission_denied', 'run_as cannot test the filter', {
        params: { scope: 'table', error: error.code },
      });
    }
    throw new AutomationStepError('invalid_value', 'The filter is not valid with its values', {
      params: { field: 'filter', error: error.code },
    });
  }
  throw error;
}

export function createUpdateRecordsAction(
  services: UpdateRecordsServices,
): AutomationActionHandler {
  const batchSize = services.batchSize ?? UPDATE_RECORDS_BATCH_SIZE;
  const analyzeAfter = services.analyzeAfter ?? UPDATE_RECORDS_ANALYZE_AFTER;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > UPDATE_RECORDS_BATCH_SIZE) {
    throw new RangeError(`batchSize must be 1…${String(UPDATE_RECORDS_BATCH_SIZE)}`);
  }

  return {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as AutomationActionContext & { readonly action: UpdateRecordsAction };
      const { config } = context.action;
      const tableId = config.table_id;
      requireTable(context, tableId, { write: true });
      requireWritableFields(context, tableId, Object.keys(config.fields), 'edit');

      const warnings: TemplateWarning[] = [];
      const filter = await resolveFilter(context, tableId, config.filter, warnings);
      const resolved = await resolveFields(context, config.fields);
      warnings.push(...resolved.warnings);
      const access = context.access.record;

      let progress = progressOf(context.previous);
      if (progress === null) {
        const count = await services.query
          .countEditable(context.scope, tableId, access, filter, config.limit + 1)
          .catch(filterError);
        if (count.editable > config.limit) {
          throw new AutomationStepError('too_many_records', 'More records match than the limit', {
            params: { limit: config.limit },
          });
        }
        progress = {
          matched: count.editable,
          updated: 0,
          batches: 0,
          last_record_id: null,
          skipped_not_editable: count.notEditable,
        };
      }

      while (progress.updated < config.limit) {
        const ids = await services.query
          .editableIds(context.scope, tableId, access, filter, {
            afterId: progress.last_record_id,
            limit: Math.min(batchSize, config.limit - progress.updated),
          })
          .catch(filterError);
        if (ids.length === 0) break;
        const next: Progress = {
          matched: progress.matched,
          updated: progress.updated + ids.length,
          batches: progress.batches + 1,
          last_record_id: ids[ids.length - 1] ?? progress.last_record_id,
          skipped_not_editable: progress.skipped_not_editable,
        };
        await services.records.update(
          context.scope,
          tableId,
          access,
          {
            field_key_type: 'id',
            typecast: true,
            records: ids.map((id) => ({ id, fields: resolved.fields })),
          },
          context.audit,
          {
            causation: context.causation,
            readBack: false,
            // The batch and the progress commit together: a retry resumes after it.
            beforeCommit: (tx) => context.saveProgress(tx, withWarnings({ ...next }, warnings)),
          },
        );
        progress = next;
      }

      let analyzed = false;
      if (progress.updated >= analyzeAfter && services.schema !== undefined) {
        // Planner statistics after a large write; never fails the step.
        analyzed = await services.schema
          .analyzeComputedTable(context.scope, tableId)
          .then(() => true)
          .catch(() => false);
      }
      const output = withWarnings(
        { ...progress, done: true, ...(analyzed ? { analyzed } : {}) },
        warnings,
      );
      return { output, warnings };
    },
  };
}

/** The filter with its values of SPEC §11.4 resolved (filter operands). */
async function resolveFilter(
  context: AutomationActionContext,
  tableId: Id<'tbl'>,
  filter: unknown,
  warnings: TemplateWarning[],
): Promise<unknown> {
  const slots = filterValueSlots(filter);
  if (slots.length === 0) return filter;
  const values: unknown[] = [];
  for (const slot of slots) {
    const resolved = await context.values.resolve(slot.value);
    warnings.push(...resolved.warnings);
    const condition = conditionAt(filter, slot.segments);
    const fieldId = isObject(condition) ? condition['field'] : undefined;
    const field = context.schema.fields.find(
      (item) => item.id === fieldId && item.table_id === tableId,
    );
    const operand = filterOperandOf(resolved.value, field, context.access.record.timeZone);
    if (operand === undefined) {
      throw new AutomationStepError('invalid_value', 'A filter value is empty', {
        params: { field: 'filter', path: slot.path },
      });
    }
    values.push(operand);
  }
  return withFilterValues(filter, slots, values);
}

function conditionAt(filter: unknown, segments: readonly (string | number)[]): unknown {
  let node: unknown = filter;
  for (const key of segments.slice(0, -1)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}
