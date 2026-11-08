import {
  BASE_IMPORT_PHASES,
  BASE_IMPORT_REPORT_MAX_ITEMS,
  basePackageProgress,
  type BaseImportPhase,
  type BaseImportReport,
  type BaseImportResult,
  type Id,
  ProblemErrorItem,
} from '@cellhive/contracts';

import { AppError } from '../../errors/app-error.js';
import { PACKAGE_LOAD_BATCH_SIZE } from '../../records/record-mutation.service.js';
import { SCHEMA_ENTRIES } from '../entries.js';
import { packageLinePath, packagePath, packageProblem, invalidPackage } from '../errors.js';
import { packageLinkSchema, packageRecordSchema } from '../manifest.js';

import {
  importRecordOf,
  planBaseImport,
  type ImportPlan,
  type PlannedField,
  type PlannedTable,
  type RecordRewriteContext,
} from './plan.js';

import type { BaseImportTarget } from './target.js';
import type { PackageLoadBatch, PackageLoadRecord } from '../../records/record-mutation.service.js';
import type { ImportFieldInput, ImportTableInput } from '../../schema/schema.service.js';
import type { BasePackageReader } from '../reader.js';

/**
 * A `.chbase` import (ADR-24 amendment §4, CONTRACTS §12.2, S9 research
 * §2.4): one job, several transactions, in this order —
 *
 * 1. `check`: pass 1 (`plan.ts`) checks the whole package; nothing written;
 * 2. `schema`: the hidden base (system roles), each table with its primary
 *    and plain fields (`parent` included), then each link pair;
 * 3. `files`: the files of cells (their rows, then the objects);
 * 4. `records`: the records of each table in batches of 5 000
 *    (`RecordMutationService.loadPackageBatch`: times, creators, `__auto`
 *    and `auto_number` kept, no event);
 * 5. `links`: the junction rows (`position` kept), then `__parent_id`;
 * 6. what `extensions` add (T1019: computed fields and their backfill, AI
 *    options, shared views, dashboards, custom roles, automations, form
 *    covers, email images — `afterSchema`/`afterData`);
 * 7. `finish`: in one transaction, the base becomes visible, `base.created`
 *    and `base.imported` are recorded and the job succeeds.
 *
 * A problem the target finds while building (a name it refuses, a value
 * that does not fit, a duplicate in a unique field, a cycle of
 * sub-records…) is `INVALID_PACKAGE` with the place in the package. The
 * caller purges the hidden base on any error and never resumes.
 */

export interface ImportBasePackageOptions {
  /** `MAX_FIELDS_PER_TABLE` of the instance. */
  readonly maxFieldsPerTable: number;
  /** `ATTACHMENT_MAX_FILE_BYTES` of the instance. */
  readonly maxFileBytes: number;
  /** Rows per `loadPackageBatch` (default 5 000). */
  readonly batchSize?: number;
  /** Steps of later tasks (T1019), run in order. */
  readonly extensions?: readonly BaseImportExtension[];
}

/** What an extension of the import gets: the plan, the new base and where to write. */
export interface BaseImportContext {
  readonly plan: ImportPlan;
  readonly baseId: Id<'bse'>;
  readonly target: BaseImportTarget;
  readonly reader: BasePackageReader;
  /** The report so far; extensions fill their parts (views, automations…). */
  readonly report: BaseImportReport;
  /** Progress inside the `computed` phase (`done` of `total`). */
  readonly progress: (done: number, total: number) => Promise<void>;
}

/**
 * The seam of T1019: steps that create what this task leaves in
 * `ImportPlan.deferred`. `afterSchema` runs once the tables, plain fields
 * and links exist (before files and records); `afterData` once the records,
 * junction rows and parents are loaded (the `computed` phase: computed
 * fields then their backfill, AI options, views, dashboards, roles,
 * automations…). Both write through the target only.
 */
export interface BaseImportExtension {
  readonly afterSchema?: (context: BaseImportContext) => Promise<void>;
  readonly afterData?: (context: BaseImportContext) => Promise<void>;
}

/** Error codes of the target that mean "this object of the package is not acceptable here". */
const DEFINITION_CODES: ReadonlySet<string> = new Set([
  'VALIDATION_FAILED',
  'NAME_CONFLICT',
  'FIELD_LIMIT_EXCEEDED',
  'INVALID_FILTER',
  // Formula and lookup fields, AI prompts, automations (T1019).
  'FORMULA_SYNTAX_ERROR',
  'FORMULA_TYPE_ERROR',
  'FORMULA_CYCLE',
  'FORMULA_LIMIT_EXCEEDED',
  'AUTOMATION_INVALID',
]);

/** Error codes of a load that mean "this row of the package is not acceptable here". */
const ENTRY_CODES: ReadonlySet<string> = new Set([
  'INVALID_CELL_VALUE',
  'UNIQUE_VIOLATION',
  'SUBRECORD_CYCLE',
  'SUBRECORD_TOO_DEEP',
  'VALIDATION_FAILED',
]);

/** Progress reports of the phases, one at least every 1 %. */
class Progress {
  private last = -1;

  constructor(private readonly target: BaseImportTarget) {}

  async at(phase: BaseImportPhase, done: number, total: number): Promise<void> {
    const progress = basePackageProgress(BASE_IMPORT_PHASES, phase, done, total);
    if (progress - this.last < 0.01 && done < total) return;
    this.last = progress;
    await this.target.progress(Math.min(progress, 0.999), phase);
  }
}

/** Builds an `ImportFieldInput` of a planned field. */
function fieldInput(field: PlannedField): ImportFieldInput {
  return {
    id: field.id,
    name: field.name,
    type: field.source.type,
    options: field.options,
    description: field.source.description,
    required: field.source.required,
    uniqueValues: field.source.unique_values,
    position: field.position,
  };
}

/** The `importTable` input of a planned table: its primary and the fields created with it. */
function tableInput(table: PlannedTable): ImportTableInput {
  return {
    id: table.id,
    name: table.name,
    description: table.source.description,
    position: table.position,
    primary: fieldInput(table.primary),
    fields: table.fields
      .filter((field) => field.kind === 'table' && field !== table.primary)
      .map(fieldInput),
  };
}

/** A refusal of the target as `INVALID_PACKAGE` `INVALID_DEFINITION` at `path`. */
export async function asDefinition<T>(path: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof AppError) || !DEFINITION_CODES.has(error.code)) throw error;
    const collation = error.errors?.some((item) => item.code === 'UNKNOWN_COLLATION') === true;
    throw packageProblem(
      'INVALID_DEFINITION',
      collation ? packagePath(SCHEMA_ENTRIES.base, ['settings', 'collation']) : path,
      collation
        ? 'The collation of the base does not exist in this database.'
        : 'This instance does not accept an object of the package.',
      { code: error.code },
    );
  }
}

/**
 * A check of an object of the package (T1019: a view config, a widget, a
 * role…) as `INVALID_PACKAGE` `INVALID_DEFINITION` at `path` when it
 * refuses it — an `AppError` of {@link DEFINITION_CODES}, or a shape it
 * cannot read (a `TypeError`); its value otherwise.
 */
export function checkDefinition<T>(path: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw packageProblem('INVALID_DEFINITION', path, 'An object of the package is malformed.', {
        code: 'VALIDATION_FAILED',
      });
    }
    if (!(error instanceof AppError) || !DEFINITION_CODES.has(error.code)) throw error;
    throw packageProblem(
      'INVALID_DEFINITION',
      path,
      'This instance does not accept an object of the package.',
      { code: error.code },
    );
  }
}

/**
 * A refusal of a load as `INVALID_PACKAGE` `INVALID_ENTRY`, each problem at
 * the line (`lineOf(index)`) and field of the package it names.
 */
async function asEntry<T>(
  entry: string,
  lineOf: (index: number) => number,
  fieldOf: (id: string) => string,
  step: () => Promise<T>,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!(error instanceof AppError) || !ENTRY_CODES.has(error.code)) throw error;
    const items: ProblemErrorItem[] = (
      error.errors ?? [{ path: '', code: error.code, message: '' }]
    )
      .slice(0, 100)
      .map((item) => {
        const match = /^(?:records|rows)\.(\d+)(?:\.fields\.([^.]+))?/u.exec(item.path);
        const index = match === null ? null : Number(match[1]);
        const pointer = match?.[2] === undefined ? [] : ['fields', fieldOf(match[2])];
        return {
          path: index === null ? entry : packageLinePath(entry, lineOf(index), pointer),
          code: 'INVALID_ENTRY',
          message: 'A row of the package is not acceptable here.',
          params: { code: item.code },
        };
      });
    throw invalidPackage(items);
  }
}

/** Reads an NDJSON entry in batches of `size`, with the line of each item. */
async function* batchesOf<T>(
  lines: AsyncIterable<{ readonly line: number; readonly value: T }>,
  size: number,
): AsyncGenerator<{ readonly values: T[]; readonly lines: number[] }> {
  let values: T[] = [];
  let numbers: number[] = [];
  for await (const { line, value } of lines) {
    values.push(value);
    numbers.push(line);
    if (values.length >= size) {
      yield { values, lines: numbers };
      values = [];
      numbers = [];
    }
  }
  if (values.length > 0) yield { values, lines: numbers };
}

/**
 * Imports the package of `reader` into a new hidden base of `target`, then
 * makes it visible (see the top of this file). Returns the result the job
 * succeeded with. Throws `INVALID_PACKAGE` for a package the target cannot
 * take; the caller purges what was written.
 */
export async function importBasePackage(
  reader: BasePackageReader,
  target: BaseImportTarget,
  options: ImportBasePackageOptions,
): Promise<BaseImportResult> {
  const progress = new Progress(target);
  const size = Math.min(options.batchSize ?? PACKAGE_LOAD_BATCH_SIZE, PACKAGE_LOAD_BATCH_SIZE);

  // --- check --------------------------------------------------------------------------
  await progress.at('check', 0, 1);
  const plan = await planBaseImport(reader, {
    members: await target.members(),
    maxFieldsPerTable: options.maxFieldsPerTable,
    maxFileBytes: options.maxFileBytes,
    onProgress: (done, total) => progress.at('check', done, total),
    checkpoint: () => target.checkpoint(),
  });
  const problems = plan.rewriter.problems;
  /** The second read of an entry finds what the first did: anything new is a changed package. */
  const unchanged = () => {
    if (problems.size > 0) problems.throwIfAny();
  };

  // --- schema -------------------------------------------------------------------------
  await target.checkpoint();
  const baseId = await asDefinition(packagePath(SCHEMA_ENTRIES.base), () =>
    target.createBase(plan.base),
  );
  const steps = plan.tables.length + plan.links.length;
  let fields = 0;
  for (const [index, table] of plan.tables.entries()) {
    await target.checkpoint();
    const input = tableInput(table);
    await asDefinition(table.location.toString(), () => target.createTable(baseId, input));
    fields += 1 + input.fields.length;
    await progress.at('schema', index + 1, steps);
  }
  for (const [index, link] of plan.links.entries()) {
    await target.checkpoint();
    await asDefinition(link.field.location.toString(), () => target.createLink(baseId, link.input));
    fields += link.reverse === null ? 1 : 2;
    await progress.at('schema', plan.tables.length + index + 1, steps);
  }
  const report: BaseImportReport = {
    tables: plan.tables.length,
    fields,
    records: 0,
    links: 0,
    attachments: 0,
    views: 0,
    dashboards: 0,
    widgets: 0,
    automations: 0,
    roles: 0,
    unmatched_user_emails: [],
    unmatched_users: 0,
    automations_disabled: 0,
    secrets_to_reconnect: [],
    webhooks_to_recreate: [],
    ai_fields: [],
    skipped_personal_views: plan.manifest.skipped.personal_views,
    files_skipped: [],
  };
  const context = (phase: BaseImportPhase): BaseImportContext => ({
    plan,
    baseId,
    target,
    reader,
    report,
    progress: (done, total) => progress.at(phase, done, total),
  });
  for (const extension of options.extensions ?? []) {
    if (extension.afterSchema !== undefined) await extension.afterSchema(context('schema'));
  }

  // --- files --------------------------------------------------------------------------
  const kept = plan.files.filter((file) => file.decision?.ok === true && file.cell !== null);
  const fileBytes = Math.max(
    1,
    kept.reduce((sum, file) => sum + file.size, 0),
  );
  let stored = 0;
  for (const file of kept) {
    await target.checkpoint();
    const decision = file.decision;
    const cell = file.cell;
    if (decision?.ok !== true || cell === null) continue;
    await target.storeFile(
      baseId,
      {
        id: file.id,
        tableId: cell.tableId,
        fieldId: cell.fieldId,
        recordId: cell.recordId,
        filename: decision.filename,
        mime: decision.mime,
        size: file.size,
        sha256: file.sha256,
      },
      await reader.open(file.entry),
    );
    stored += file.size;
    report.attachments += 1;
    await progress.at('files', stored, fileBytes);
  }

  // --- records ------------------------------------------------------------------------
  const rewrite: RecordRewriteContext = plan;
  const parents = new Map<PlannedTable, { id: Id<'rec'>; parentId: Id<'rec'> }[]>();
  const recordTotal = Math.max(
    1,
    plan.tables.reduce((sum, table) => sum + table.records, 0),
  );
  for (const table of plan.tables) {
    const pending: { id: Id<'rec'>; parentId: Id<'rec'> }[] = [];
    for await (const batch of batchesOf(
      reader.readNdjson(table.entry, packageRecordSchema),
      size,
    )) {
      await target.checkpoint();
      const records: PackageLoadRecord[] = [];
      for (const [index, value] of batch.values.entries()) {
        const out = importRecordOf(rewrite, table, batch.lines[index] ?? 0, value);
        records.push(out.record);
        if (out.parent !== null && plan.records.tableOf(out.parent) === table.index) {
          pending.push({
            id: out.record.id,
            parentId: plan.records.resolve(out.parent) as Id<'rec'>,
          });
        }
      }
      unchanged();
      const load: PackageLoadBatch = { kind: 'records', tableId: table.id, records };
      report.records += await asEntry(
        table.entry,
        (index) => batch.lines[index] ?? 0,
        (id) => rewrite.fieldsByNewId.get(id)?.source.id ?? id,
        () => target.load(baseId, load),
      );
      await progress.at('records', report.records, recordTotal);
    }
    if (pending.length > 0) parents.set(table, pending);
  }

  // --- links and parents --------------------------------------------------------------
  const linkSteps = Math.max(1, plan.links.length + parents.size);
  let linkStep = 0;
  for (const link of plan.links) {
    if (link.entry !== null) {
      const entry = link.entry;
      for await (const batch of batchesOf(reader.readNdjson(entry, packageLinkSchema), size)) {
        await target.checkpoint();
        const rows = batch.values.map((row) => ({
          a: plan.records.resolve(row.a) as Id<'rec'>,
          b: plan.records.resolve(row.b) as Id<'rec'>,
          position: row.position,
        }));
        const load: PackageLoadBatch = { kind: 'links', fieldId: link.field.id, rows };
        report.links += await asEntry(
          entry,
          (index) => batch.lines[index] ?? 0,
          (id) => id,
          () => target.load(baseId, load),
        );
      }
    }
    linkStep += 1;
    await progress.at('links', linkStep, linkSteps);
  }
  for (const [table, pending] of parents) {
    for (let start = 0; start < pending.length; start += size) {
      await target.checkpoint();
      const rows = pending.slice(start, start + size);
      const load: PackageLoadBatch = { kind: 'parents', tableId: table.id, rows };
      await asEntry(
        table.entry,
        () => 0,
        (id) => id,
        () => target.load(baseId, load),
      );
    }
    linkStep += 1;
    await progress.at('links', linkStep, linkSteps);
  }

  // --- what later tasks add -----------------------------------------------------------
  for (const extension of options.extensions ?? []) {
    if (extension.afterData !== undefined) await extension.afterData(context('computed'));
  }

  // --- finish -------------------------------------------------------------------------
  await target.checkpoint();
  const unmatched = plan.users.unmatchedEmails(BASE_IMPORT_REPORT_MAX_ITEMS);
  report.unmatched_user_emails = unmatched.emails;
  report.unmatched_users = unmatched.total;
  // Cell files first, then the covers and email images later steps left out.
  report.files_skipped = [
    ...plan.files.flatMap((file) =>
      file.decision === null || file.decision.ok
        ? []
        : [{ filename: file.decision.filename, reason: file.decision.reason }],
    ),
    ...report.files_skipped,
  ].slice(0, BASE_IMPORT_REPORT_MAX_ITEMS);
  await progress.at('finish', 0, 1);
  const result: BaseImportResult = { base_id: baseId, report };
  await target.finish(baseId, result, {
    tables: report.tables,
    fields: report.fields,
    records: report.records,
    links: report.links,
    attachments: report.attachments,
  });
  return result;
}
