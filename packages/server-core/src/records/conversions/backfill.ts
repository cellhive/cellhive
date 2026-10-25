import {
  columnTypeOf,
  convertComputedCell,
  planComputedConversion,
  planFieldConversion,
  type CellConversion,
  type ConversionSettings,
  type FieldConversionPlan,
} from '@cellhive/field-types';
import { sql, type RawBuilder } from 'kysely';

import { ComputeModel } from '../../computed/definition/compute-model.js';
import { loadBaseSchemaRows } from '../../computed/definition/schema-rows.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { publishFieldConverting } from '../../realtime/field-converting.js';
import {
  computedDefinitionOf,
  conversionAuditContext,
  definitionRefOf,
  definitionTypeOf,
  storedDefinitionOf,
  type ComputedStoredDefinition,
} from '../../schema/conversion-ddl.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { assertDataTableName, assertShadowColumnName, DATA_SCHEMA } from '../../schema/names.js';
import { schemaLockKey } from '../../schema/policy.js';
import { cutLinkCells } from '../links/link-conversion.js';
import { toLinkFieldModel } from '../links/link-model.js';

import { convertBatch, sourceColumnOf, targetStorageOf } from './cells.js';
import { assertScanColumn, scanColumnBatch } from './column-scan.js';
import { computedSourceOf, scanComputedBatch } from './computed-source.js';

import type { Db, Tx } from '../../db/create-db.js';
import type {
  FieldConversionRow,
  FieldRow,
  JsonObject,
  JsonValue,
  TableRow,
} from '../../db/schema.js';
import type { JobsRepository } from '../../jobs/jobs.repository.js';
import type { FieldConversionsRepository } from '../../schema/field-conversions.repository.js';
import type { TablesRepository } from '../../schema/tables.repository.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';
import type { Id } from '@cellhive/contracts';

/**
 * Backfill of a field type conversion (T403, SPEC §5.5 step 2): one batch of
 * rows per transaction, from the field's column (or the system column a
 * computed source reads) into the conversion's shadow column
 * (`f_x__new_<ms>`), with the same pure `convertCell` as the preview. The
 * field keeps showing its old values meanwhile (BACKLOG S4 design decision
 * #8). Unconvertible values become empty and are
 * counted. No record event, audit entry or version change per record (BACKLOG
 * S4 open question #7): the conversion is one `field.converted` at the end.
 * Reached only through `RecordMutationService.convertFieldBatch`.
 */

/** Rows converted per transaction (SPEC §5.5). */
export const CONVERSION_BACKFILL_BATCH_SIZE = 5000;

export interface ConversionCountsJson {
  total: number;
  processed: number;
  affected: number;
  lost: number;
  truncated: number;
}

export interface ConversionBatchResult {
  readonly jobId: Id<'job'>;
  /** Rows read by this batch. */
  readonly rows: number;
  /** No row left after the position (the end still re-checks under lock). */
  readonly done: boolean;
  readonly counts: ConversionCountsJson;
}

export interface BackfillDeps {
  /** For the realtime bus attached to it (`field.converting` progress). */
  readonly db: Db;
  readonly members: MemberDirectoryRepository;
  readonly conversions: FieldConversionsRepository;
  readonly jobs: JobsRepository;
  readonly tables: TablesRepository;
  /** Wait for the table's schema lock (shared) at most this long. */
  readonly lockTimeoutMs: number;
}

function objectOf(value: JsonValue): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function numberOf(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function countsOf(value: JsonValue): ConversionCountsJson {
  const counts = objectOf(value);
  return {
    total: numberOf(counts.total),
    processed: numberOf(counts.processed),
    affected: numberOf(counts.affected),
    lost: numberOf(counts.lost),
    truncated: numberOf(counts.truncated),
  };
}

/** Settings and locale stored with the conversion (`context`). */
export function conversionContextOf(conversion: FieldConversionRow): {
  readonly locale: string;
  readonly timeZone: string;
  readonly settings: ConversionSettings;
} {
  const context = objectOf(conversion.context);
  const settings = objectOf(context.settings ?? null);
  const truthy = Array.isArray(settings.truthy_values)
    ? settings.truthy_values.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    locale: typeof context.locale === 'string' ? context.locale : 'en',
    timeZone: typeof context.time_zone === 'string' ? context.time_zone : 'UTC',
    settings: {
      ...(settings.match_existing_only === true ? { match_existing_only: true } : {}),
      ...(truthy === undefined ? {} : { truthy_values: truthy }),
      ...(settings.match_email === true ? { match_email: true } : {}),
    },
  };
}

/** The plan of a stored conversion (definitions and settings as recorded). */
export function planOfConversion(conversion: FieldConversionRow) {
  const from = storedDefinitionOf(conversion.from_definition);
  const to = storedDefinitionOf(conversion.to_definition);
  const context = conversionContextOf(conversion);
  return planFieldConversion(definitionRefOf(from), definitionRefOf(to), context.settings);
}

/** SQL turning the `val jsonb` of a recordset row into a value of the target column. */
export function valueExpr(type: string, columnType: string | null): RawBuilder<unknown> {
  const text = sql`(v.val #>> '{}')`;
  switch (type) {
    case 'number':
      return sql`${text}::numeric`;
    case 'datetime':
      return columnType === 'date' ? sql`${text}::date` : sql`${text}::timestamptz`;
    case 'checkbox':
      return sql`coalesce(${text}::boolean, false)`;
    case 'select':
    case 'user':
      return sql`CASE WHEN jsonb_typeof(v.val) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v.val)) ELSE NULL END`;
    default:
      return text;
  }
}

/**
 * Converts the next batch of a running conversion, in `tx`: the table's
 * schema lock (shared, like a record write), the conversion row locked,
 * rows after `cursor_auto` (every row, the trash included), one `UPDATE …
 * FROM jsonb_to_recordset` of the non-empty results into the shadow
 * column, then the position, the counters and the job progress
 * (`job.progress` after commit). `undefined` when the conversion is not
 * running.
 */
export async function runConversionBatch(
  tx: Tx,
  scope: OrgScope,
  deps: BackfillDeps,
  jobId: Id<'job'>,
  limit: number = CONVERSION_BACKFILL_BATCH_SIZE,
): Promise<ConversionBatchResult | undefined> {
  const txScope = withTxScope(scope, tx);
  const located = await deps.conversions.getByJob(txScope, jobId);
  if (located === undefined) return undefined;
  const { rows: previous } = await sql<{ previous: string }>`
    SELECT current_setting('lock_timeout') AS previous,
           set_config('lock_timeout', ${`${String(deps.lockTimeoutMs)}ms`}, true)
  `.execute(tx);
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(located.table_id)}, 0))`.execute(
    tx,
  );
  await sql`SELECT set_config('lock_timeout', ${previous[0]?.previous ?? '0'}, true)`.execute(tx);
  const conversion = await deps.conversions.lockByJob(txScope, jobId);
  if (conversion?.status !== 'running') return undefined;
  const table = await deps.tables.getById(txScope, conversion.table_id, { includeDeleted: true });
  if (table === undefined) return undefined;
  if (conversion.kind !== 'column') {
    return runLinkConversionBatch(tx, txScope, deps, conversion, table, limit);
  }

  // T463: conversions to a formula/lookup compute the new definition.
  const toComputed = computedDefinitionOf(conversion.to_definition);
  if (toComputed !== null) {
    return runComputedTargetBatch(tx, txScope, deps, conversion, table, toComputed, limit);
  }
  const context = conversionContextOf(conversion);
  const fromComputed = computedDefinitionOf(conversion.from_definition) !== null;
  let plan: FieldConversionPlan;
  let rows: readonly { readonly id: string; readonly auto: bigint }[];
  let converted: readonly { readonly result: CellConversion }[];
  if (fromComputed) {
    // "Convert to static values": the current computed values (T463).
    const field = await new FieldsRepository(deps.db).getById(txScope, conversion.field_id, {
      includeDeleted: true,
    });
    if (field === undefined) return undefined;
    const source = computedSourceOf(field);
    plan = planComputedConversion(
      source,
      definitionRefOf(storedDefinitionOf(conversion.to_definition)),
      context.settings,
    );
    const locale = { locale: context.locale, timeZone: context.timeZone };
    const scanned = await scanComputedBatch(
      tx,
      { members: deps.members },
      txScope,
      {
        table,
        field,
        rows: await loadBaseSchemaRows(deps.db, txScope, table.base_id),
        timeZone: context.timeZone,
        locale,
      },
      { afterAuto: conversion.cursor_auto, limit },
      sql`true`,
    );
    rows = scanned;
    converted = scanned.map((row) => ({
      result: convertComputedCell(plan, source, row.value, locale),
    }));
  } else {
    plan = planOfConversion(conversion);
    // Until the swap the field reads its canonical column (or a system column).
    const source =
      conversion.old_column_name === null
        ? sourceColumnOf(plan.from.type, null)
        : conversion.new_column_name;
    if (source === null) throw new Error(`field conversion ${jobId}: no source column`);
    const scanned = await scanColumnBatch(
      tx,
      table,
      { column: source, afterAuto: conversion.cursor_auto, limit },
      sql`true`,
    );
    rows = scanned;
    converted = await convertBatch(
      deps.members,
      txScope,
      plan,
      { locale: context.locale, timeZone: context.timeZone },
      scanned.map((row) => row.value),
    );
  }
  const counts = countsOf(conversion.counts);

  const updates: { id: string; val: JsonValue }[] = [];
  converted.forEach(({ result }, index) => {
    const row = rows[index];
    if (row === undefined || result.outcome === 'empty') return;
    counts.affected += 1;
    if (result.outcome === 'lost') {
      counts.lost += 1;
      return;
    }
    const stored = targetStorageOf(plan, result.value);
    if (stored === undefined || stored === null) {
      counts.lost += 1;
      return;
    }
    if (result.outcome === 'truncated') counts.truncated += 1;
    if (stored !== false) updates.push({ id: row.id, val: stored });
  });
  if (updates.length > 0) {
    const column = sql.id(assertShadowColumnName(conversion.shadow_column_name ?? ''));
    await sql`
      UPDATE ${sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name))} AS t
         SET ${column} = ${valueExpr(plan.to.type, columnTypeOf(plan.to))}
        FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS v(id text, val jsonb)
       WHERE t.__id = v.id
    `.execute(tx);
  }

  counts.processed += rows.length;
  const cursor = rows.at(-1)?.auto ?? conversion.cursor_auto;
  const done = rows.length < limit;
  await deps.conversions.setProgress(txScope, jobId, { cursorAuto: cursor, counts: { ...counts } });
  // The last percent is the swap (`finishConversion`).
  const progress = counts.total === 0 ? 0.99 : Math.min(counts.processed / counts.total, 0.99);
  await deps.jobs.setProgress(txScope, jobId, progress);
  await publishFieldConverting(deps.db, tx, conversion, table.base_id, 'running', progress);
  return { jobId, rows: rows.length, done, counts };
}

/** Alias of the formula's row in the shadow `UPDATE` (a code constant). */
const COMPUTED_ROW_ALIAS = 'cr';

/**
 * A batch of a conversion to a formula/lookup (T463, CONTRACTS §4.1 "any →
 * formula/lookup"): the field is still its old self, so the definition is
 * computed as a field of its own (the meta row with the new definition;
 * readers of the field see it empty meanwhile, never a cycle) into the
 * shadow column — set-based like `computed.backfill`, every row (trash
 * included). `affected` counts the non-empty old values it replaces. A
 * `virtual` target stores nothing: one empty batch. A definition that no
 * longer analyses (a source deleted meanwhile) leaves the shadow empty; the
 * end marks the field in error (T460).
 */
async function runComputedTargetBatch(
  tx: Tx,
  txScope: OrgScope,
  deps: BackfillDeps,
  conversion: FieldConversionRow,
  table: TableRow,
  to: ComputedStoredDefinition,
  limit: number,
): Promise<ConversionBatchResult> {
  const jobId = conversion.job_id;
  const counts = countsOf(conversion.counts);
  const context = conversionContextOf(conversion);
  const field = await new FieldsRepository(deps.db).getById(txScope, conversion.field_id, {
    includeDeleted: true,
  });
  let written = 0;
  let cursor = conversion.cursor_auto;
  let done = true;
  if (to.compute_mode === 'stored' && field !== undefined && field.deleted_at === null) {
    const rows = await loadBaseSchemaRows(deps.db, txScope, table.base_id);
    const self: FieldRow = {
      ...field,
      type: to.type,
      options: to.options,
      result_type: to.result_type,
      compute_mode: to.compute_mode,
      // Readers of the field (other formulas) read it empty meanwhile.
      compute_state: 'error',
      compute_error: null,
      db_column_name: null,
    };
    const model = new ComputeModel(
      { ...rows, fields: rows.fields.map((row) => (row.id === self.id ? self : row)) },
      { timeZone: context.timeZone },
    );
    const value = model.storedValue(self, COMPUTED_ROW_ALIAS);
    const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
    const shadow = sql.id(assertShadowColumnName(conversion.shadow_column_name ?? ''));
    const sourceColumn =
      conversion.old_column_name === null
        ? (sourceColumnOf(definitionTypeOf(conversion.from_definition), null) ?? null)
        : conversion.new_column_name;
    const had =
      sourceColumn === null
        ? sql`false`
        : sql`coalesce(to_jsonb(${sql.id('b', assertScanColumn(sourceColumn))}) NOT IN ('null'::jsonb, 'false'::jsonb, '""'::jsonb, '[]'::jsonb), false)`;
    const { rows: result } = await sql<{ rows: number; affected: number; last: string | null }>`
      WITH batch AS (
        SELECT b.__id, b.__auto, ${had} AS had FROM ${data} AS b
         WHERE b.__auto > ${conversion.cursor_auto.toString()}::bigint
         ORDER BY b.__auto
         LIMIT ${limit}
      ), done AS (
        UPDATE ${data} AS ${sql.id(COMPUTED_ROW_ALIAS)}
           SET ${shadow} = ${value ?? sql`NULL`}
          FROM batch
         WHERE ${sql.id(COMPUTED_ROW_ALIAS, '__id')} = batch.__id
        RETURNING batch.__auto, batch.had
      )
      SELECT count(*)::int AS rows, count(*) FILTER (WHERE had)::int AS affected,
             max(__auto)::text AS last
        FROM done
    `.execute(tx);
    written = result[0]?.rows ?? 0;
    const last = result[0]?.last;
    if (last !== null && last !== undefined) cursor = BigInt(last);
    counts.affected += result[0]?.affected ?? 0;
    // The old values are replaced by computed ones (kept 7 days in the old column).
    counts.lost += result[0]?.affected ?? 0;
    done = written < limit;
  }
  counts.processed += written;
  if (done) counts.processed = Math.max(counts.processed, counts.total);
  await deps.conversions.setProgress(txScope, jobId, { cursorAuto: cursor, counts: { ...counts } });
  const progress = counts.total === 0 ? 0.99 : Math.min(counts.processed / counts.total, 0.99);
  await deps.jobs.setProgress(txScope, jobId, progress);
  await publishFieldConverting(deps.db, tx, conversion, table.base_id, 'running', progress);
  return { jobId, rows: written, done, counts };
}

/**
 * A batch of a link conversion (T404, ADR-28): a change of direction has
 * no data to convert (done at once; the end creates or deletes the other
 * side); `to_single` cuts the next cells holding more than one link
 * (`cutLinkCells`, audit per record), `limit` cells per batch.
 */
async function runLinkConversionBatch(
  tx: Tx,
  txScope: OrgScope,
  deps: BackfillDeps,
  conversion: FieldConversionRow,
  table: TableRow,
  limit: number,
): Promise<ConversionBatchResult> {
  const jobId = conversion.job_id;
  const counts = countsOf(conversion.counts);
  let rows = 0;
  if (conversion.kind === 'to_single' && conversion.backup_table_name !== null) {
    const field = await new FieldsRepository(deps.db).getById(txScope, conversion.field_id, {
      includeDeleted: true,
    });
    const model = field === undefined ? null : toLinkFieldModel(field);
    if (model === null) throw new Error(`link conversion ${jobId}: not a link field`);
    const otherTable =
      (await deps.tables.getById(txScope, model.targetTableId, { includeDeleted: true })) ?? null;
    const cut = await cutLinkCells(tx, {
      ref: {
        junction: model.junction,
        ownColumn: model.ownColumn,
        otherColumn: model.otherColumn,
        otherTable,
        side: model.side,
      },
      backupTable: conversion.backup_table_name,
      limit,
      audit: { table, fieldId: model.id, context: conversionAuditContext(conversion) },
    });
    rows = cut.cells;
    counts.truncated += cut.cells;
    counts.processed += cut.cells;
  }
  const done = conversion.kind !== 'to_single' || rows < limit;
  if (done) counts.processed = Math.max(counts.processed, counts.total);
  await deps.conversions.setProgress(txScope, jobId, {
    cursorAuto: conversion.cursor_auto,
    counts: { ...counts },
  });
  const progress =
    counts.total === 0 || done ? 0.99 : Math.min(counts.processed / counts.total, 0.99);
  await deps.jobs.setProgress(txScope, jobId, progress);
  await publishFieldConverting(deps.db, tx, conversion, table.base_id, 'running', progress);
  return { jobId, rows, done, counts };
}
