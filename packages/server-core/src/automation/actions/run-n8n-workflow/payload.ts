import { AppError } from '../../../errors/app-error.js';
import { toEventDocument } from '../../../events/event.js';
import { EventsRepository } from '../../../events/events.repository.js';
import { AutomationStepError } from '../../engine/errors.js';
import { previousCell } from '../../values/event-data.js';

import type { RecordQueryService } from '../../../records/record-query.service.js';
import type { AutomationFieldMeta } from '../../definition/validate.js';
import type { AutomationActionContext } from '../../engine/action-registry.js';
import type { TemplateWarning } from '../../values/evaluator.js';
import type { Id, N8nWorkflowPayload, RunN8nWorkflowConfig } from '@cellhive/contracts';

/** What the payload is built from, besides the action context. */
export interface N8nPayloadDeps {
  readonly query: Pick<RecordQueryService, 'getRecords' | 'matchRecord'>;
  /** Reads the trigger event again (`changes`); default: `meta.events` through `context.db`. */
  readonly events?: Pick<EventsRepository, 'getByKey'>;
}

/**
 * What of the action context the payload reads: the run engine passes the
 * whole context, "Send a test" (T616) one built for the caller.
 */
export type N8nPayloadContext = Pick<
  AutomationActionContext,
  'db' | 'scope' | 'run' | 'access' | 'schema' | 'values' | 'now'
>;

export interface BuiltN8nPayload {
  readonly payload: N8nWorkflowPayload;
  /** `field_unavailable` for listed fields `run_as` no longer reads (ids only). */
  readonly warnings: readonly TemplateWarning[];
}

/** Field types without a stored value (per-reader UI state): never sent. */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(['button']);

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The JSON body of a `run_n8n_workflow` step (SPEC §13.3, CONTRACTS §21;
 * BACKLOG T607), built with the permissions of `run_as` **now** (ADR-25):
 *
 * - `record`: the trigger record read through `RecordQueryService` with the
 *   effective access of `run_as` — `fields` by name as `cell_format=text`,
 *   `fields_by_id` by id as `cell_format=json`; only the fields it reads
 *   (`config.fields`, or all of them when `null`; listed fields it no
 *   longer reads are left out with a `field_unavailable` warning), linked
 *   records it cannot read with `title: null` (P20). `null` without a
 *   trigger record, or when the record is gone or outside its read rule.
 *   A trigger table `run_as` no longer reads fails the step
 *   `permission_denied`, like the other record steps.
 * - `changes`: `record.updated` with `include_changes` — the trigger
 *   event's changes of the sent fields, by name, in the `[@previous]` form;
 *   otherwise `null`.
 * - Never a secret, a token, or a field `run_as` cannot read.
 */
export async function buildN8nPayload(
  deps: N8nPayloadDeps,
  context: N8nPayloadContext,
  config: RunN8nWorkflowConfig,
): Promise<BuiltN8nPayload> {
  const { run, schema } = context;
  const warnings: TemplateWarning[] = [];
  const firedAt = (await context.values.resolve({ trigger: 'fired_at' })).value;

  const tableId = run.triggerTableId;
  const tableMeta =
    tableId === null ? undefined : schema.tables.find((table) => table.id === tableId);
  const tableAccess = tableId === null ? undefined : schema.access.tables[tableId];
  if (tableId !== null && (tableAccess === undefined || tableMeta === undefined)) {
    throw new AutomationStepError('permission_denied', 'run_as cannot read the trigger table', {
      params: { scope: 'table', table_id: tableId },
    });
  }

  // The fields to send: listed ones `run_as` still reads, or every field it reads.
  const sent: AutomationFieldMeta[] = [];
  if (tableId !== null && tableAccess !== undefined) {
    const ofTable = schema.fields.filter(
      (field) => field.table_id === tableId && !SKIPPED_TYPES.has(field.type),
    );
    const readable = (field: AutomationFieldMeta) => tableAccess.fields[field.id] !== undefined;
    if (config.fields === null) {
      sent.push(...ofTable.filter(readable));
    } else {
      const byId = new Map(ofTable.map((field) => [field.id as string, field]));
      for (const fieldId of config.fields) {
        const field = byId.get(fieldId);
        if (field !== undefined && readable(field)) sent.push(field);
        else warnings.push({ code: 'field_unavailable', field_id: fieldId });
      }
    }
  }

  let record: N8nWorkflowPayload['record'] = null;
  if (tableId !== null && run.triggerRecordId !== null) {
    const fieldIds = sent.map((field) => field.id as string);
    const read = (cellFormat: 'json' | 'text') =>
      deps.query.getRecords(
        context.scope,
        tableId,
        [run.triggerRecordId as string],
        context.access.record,
        {
          field_key_type: 'id',
          cell_format: cellFormat,
          fields: fieldIds,
        },
      );
    const [json] = await read('json');
    const [text] = json === undefined ? [] : await read('text');
    if (json !== undefined && text !== undefined) {
      const fields: Record<string, unknown> = {};
      const fieldsById: Record<string, unknown> = {};
      for (const field of sent) {
        if (Object.hasOwn(json.fields, field.id)) fieldsById[field.id] = json.fields[field.id];
        if (Object.hasOwn(text.fields, field.id)) fields[field.name] = text.fields[field.id];
      }
      record = { id: json.id, fields, fields_by_id: fieldsById };
    }
  }

  // `event.entity_id` (T616): the trigger record's id, only when `run_as` reads that record —
  // live (it is `record.id`), or in the trash for `record.deleted` (its `record` is `null`).
  let entityId: string | null = record?.id ?? null;
  if (
    entityId === null &&
    tableId !== null &&
    run.triggerRecordId !== null &&
    run.triggerType === 'record.deleted' &&
    (await readsTrashed(deps, context, tableId, run.triggerRecordId))
  ) {
    entityId = run.triggerRecordId;
  }

  let changes: N8nWorkflowPayload['changes'] = null;
  if (config.include_changes && run.triggerType === 'record.updated' && tableId !== null) {
    changes = await changesOf(deps, context, sent);
  }

  return {
    payload: {
      event: {
        id: run.triggerEventId,
        type: run.triggerType,
        entity_id: entityId,
        created_at:
          run.triggerEventCreatedAt ??
          (typeof firedAt === 'string' ? firedAt : context.now().toISOString()),
      },
      automation: {
        id: run.automationId,
        name: run.automationName ?? '',
        run_id: run.id,
      },
      base: { id: run.baseId, name: run.baseName ?? '' },
      table:
        tableId === null || tableMeta === undefined
          ? null
          : { id: tableId, name: tableMeta.name ?? '' },
      record,
      changes,
    },
    warnings,
  };
}

/** Whether `run_as` reads the record in the trash (its read rule applies there too). */
async function readsTrashed(
  deps: N8nPayloadDeps,
  context: N8nPayloadContext,
  tableId: Id<'tbl'>,
  recordId: string,
): Promise<boolean> {
  try {
    return await deps.query.matchRecord(
      context.scope,
      tableId,
      recordId,
      context.access.record,
      null,
      { trashed: true },
    );
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return false;
    throw error;
  }
}

/**
 * `changes` of the trigger event limited to the sent fields, by name, in
 * the `[@previous]` form (options by name, users and records by id); `{}`
 * when none of them changed, `null` when the event is gone (dropped
 * partition) or not known.
 */
async function changesOf(
  deps: N8nPayloadDeps,
  context: N8nPayloadContext,
  sent: readonly AutomationFieldMeta[],
): Promise<N8nWorkflowPayload['changes']> {
  const { triggerEventId, triggerEventCreatedAt } = context.run;
  if (
    triggerEventId === null ||
    triggerEventCreatedAt === undefined ||
    triggerEventCreatedAt === null
  ) {
    return null;
  }
  const events = deps.events ?? new EventsRepository(context.db);
  const row = await events.getByKey(context.scope, {
    id: triggerEventId,
    createdAt: triggerEventCreatedAt,
  });
  if (row === undefined) return null;
  const stored = toEventDocument(row).changes;
  if (!isObject(stored)) return null;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of sent) {
    if (!Object.hasOwn(stored, field.id)) continue;
    const change = stored[field.id];
    out[field.name] = {
      from: previousCell(field, isObject(change) ? change['from'] : null),
      to: previousCell(field, isObject(change) ? change['to'] : null),
    };
  }
  return out;
}
