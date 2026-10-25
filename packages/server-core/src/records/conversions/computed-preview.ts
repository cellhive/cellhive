import {
  convertComputedCell,
  MAX_SELECT_OPTIONS,
  missingSelectOptionNames,
  type ComputedSource,
  type FieldConversionPlan,
  type FieldDefinitionRef,
  type SelectOptions,
} from '@cellhive/field-types';

import { sourceJsonBatch, targetReadOf, targetStorageOf } from './cells.js';
import {
  CONVERSION_PREVIEW_BATCH_SIZE,
  CONVERSION_SAMPLE_LIMIT,
  type ConversionPreviewResult,
  type ConversionSample,
  type SampleOutcome,
} from './preview.js';

import type { OrgScope } from '../../db/repository.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';
import type { RecordQueryService } from '../record-query.service.js';
import type { RecordAccessContext } from '../types.js';
import type { ConversionLocale } from './cells.js';
import type { ComputedScanRow } from './computed-source.js';
import type { Id } from '@cellhive/contracts';

/**
 * Previews of conversions from and to formula/lookup fields (CONTRACTS
 * §4.1/§4.4, BACKLOG T463), next to those of `preview.ts`: the same counts
 * and samples (every row counted, trash included; samples only from live
 * records the caller reads, problems first).
 */

interface Deps {
  readonly query: RecordQueryService;
  readonly members: MemberDirectoryRepository;
  readonly batchSize?: number;
  /** Of these records, those whose audit trail proves the field untouched since `since`. */
  readonly provablyUntouched?: (recordIds: readonly string[], since: Date) => Promise<Set<string>>;
}

export interface ComputedScanTarget {
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  readonly access: RecordAccessContext | null;
  readonly fieldId: Id<'fld'>;
  readonly timeZone: string;
  readonly locale: string;
}

class Samples {
  private readonly problems: ConversionSample[] = [];
  private readonly others: ConversionSample[] = [];

  add(sample: ConversionSample): void {
    const list = sample.outcome === 'kept' ? this.others : this.problems;
    if (list.length < CONVERSION_SAMPLE_LIMIT) list.push(sample);
  }

  list(): ConversionSample[] {
    return [...this.problems, ...this.others].slice(0, CONVERSION_SAMPLE_LIMIT);
  }
}

async function* computedBatches(deps: Deps, target: ComputedScanTarget, compareColumn?: string) {
  const limit = deps.batchSize ?? CONVERSION_PREVIEW_BATCH_SIZE;
  let after = 0n;
  for (;;) {
    const rows: ComputedScanRow[] = await deps.query.scanComputed(
      target.scope,
      target.tableId,
      target.access,
      target.fieldId,
      {
        afterAuto: after,
        limit,
        timeZone: target.timeZone,
        locale: target.locale,
        ...(compareColumn === undefined ? {} : { compareColumn }),
      },
    );
    if (rows.length > 0) yield rows;
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) return;
    after = last.auto;
  }
}

/**
 * "Convert to static values" (formula/lookup → stored type): the current
 * value of every cell converted as its result type
 * (`planComputedConversion`), without writing.
 */
export async function previewComputedSource(
  deps: Deps,
  target: ComputedScanTarget,
  source: ComputedSource,
  plan: FieldConversionPlan,
  locale: ConversionLocale,
): Promise<ConversionPreviewResult> {
  const samples = new Samples();
  let affected = 0;
  let lost = 0;
  let truncated = 0;
  const newOptions: string[] = [];
  const created = new Set<string>();
  let tooManyOptions = false;
  const selectTarget = plan.to.type === 'select';
  const existingOptions = selectTarget ? (plan.to.options as SelectOptions).options.length : 0;
  const ctx = { locale: locale.locale, timeZone: locale.timeZone };
  for await (const rows of computedBatches(deps, target)) {
    for (const row of rows) {
      const result = convertComputedCell(plan, source, row.value, ctx);
      if (result.outcome === 'empty') continue;
      affected += 1;
      let to: unknown = null;
      let outcome: SampleOutcome = 'lost';
      if (result.outcome === 'lost') {
        lost += 1;
      } else {
        if (result.outcome === 'truncated') truncated += 1;
        outcome = result.outcome;
        if (selectTarget) {
          for (const name of missingSelectOptionNames(
            plan.to.options as SelectOptions,
            result.value,
          )) {
            if (created.has(name)) continue;
            created.add(name);
            newOptions.push(name);
          }
          to = result.value;
        } else {
          const stored = targetStorageOf(plan, result.value);
          if (stored === undefined || stored === null) {
            // The target refuses it (an unknown user): the cell is lost.
            lost += 1;
            outcome = 'lost';
          } else {
            to = targetReadOf(plan, stored);
          }
        }
      }
      if (row.readable) samples.add({ record_id: row.id, from: row.value, to, outcome });
    }
    if (selectTarget && existingOptions + newOptions.length > MAX_SELECT_OPTIONS) {
      tooManyOptions = true;
      break;
    }
  }
  return {
    affected,
    lost,
    truncated,
    invalid: undefined,
    newOptions,
    tooManyOptions,
    samples: samples.list(),
  };
}

/** Current values of the field a conversion to a formula/lookup replaces. */
export interface ComputedTargetPreview {
  /** Non-empty cells (every record, trash included): all replaced by computed values. */
  readonly affected: number;
  /** Up to 20 non-empty cells of live records the caller reads, `cell_format=json`. */
  readonly samples: readonly { readonly record_id: Id<'rec'>; readonly from: unknown }[];
}

function isEmptyJson(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * A conversion to a formula/lookup (CONTRACTS §4.1 "any → formula/lookup"):
 * the non-empty cells whose values the computed ones replace (they stay in
 * the old column for 7 days). `source` is the field as it is: a stored
 * definition read from `column`, or a formula/lookup (`computed`).
 */
export async function previewComputedTarget(
  deps: Deps,
  target: {
    readonly scope: OrgScope;
    readonly tableId: Id<'tbl'>;
    readonly access: RecordAccessContext | null;
  },
  source:
    | { readonly kind: 'column'; readonly column: string; readonly definition: FieldDefinitionRef }
    | {
        readonly kind: 'computed';
        readonly fieldId: Id<'fld'>;
        readonly timeZone: string;
        readonly locale: string;
      },
): Promise<ComputedTargetPreview> {
  let affected = 0;
  const samples: { record_id: Id<'rec'>; from: unknown }[] = [];
  const take = (id: Id<'rec'>, value: unknown, readable: boolean) => {
    if (isEmptyJson(value)) return;
    affected += 1;
    if (readable && samples.length < CONVERSION_SAMPLE_LIMIT) {
      samples.push({ record_id: id, from: value });
    }
  };
  if (source.kind === 'computed') {
    for await (const rows of computedBatches(deps, { ...target, ...source })) {
      for (const row of rows) take(row.id, row.value, row.readable);
    }
    return { affected, samples };
  }
  const limit = deps.batchSize ?? CONVERSION_PREVIEW_BATCH_SIZE;
  let after = 0n;
  for (;;) {
    const rows = await deps.query.scanColumn(target.scope, target.tableId, target.access, {
      column: source.column,
      afterAuto: after,
      limit,
    });
    const values = await sourceJsonBatch(
      deps.members,
      target.scope,
      source.definition,
      rows.map((row) => row.value),
    );
    rows.forEach((row, index) => {
      take(row.id, values[index], row.readable);
    });
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) break;
    after = last.auto;
  }
  return { affected, samples };
}

/** The revert preview of "convert to static values": cells written since are replaced. */
export interface ComputedRevertPreview {
  readonly unchanged: number;
  readonly edited: number;
  readonly samples: ConversionSample[];
}

/**
 * The revert of "convert to static values" (T463): the field computes its
 * values again, so every cell written since the conversion (edited, or in a
 * record created later) loses its value — `edited` (fail safe like T403: a
 * record updated later counts as edited unless its audit trail proves the
 * field untouched). Samples: edited cells, `from` = current value, `to` =
 * `null` (computed again), `outcome: lost`.
 */
export async function previewComputedRevert(
  deps: Deps,
  target: {
    readonly scope: OrgScope;
    readonly tableId: Id<'tbl'>;
    readonly access: RecordAccessContext | null;
    /** The converted (stored) column. */
    readonly column: string;
    readonly definition: FieldDefinitionRef;
    /** When the conversion swapped in. */
    readonly finishedAt: Date;
    /** `__auto` of the last row that existed then: later rows were created after it. */
    readonly lastAuto: bigint;
  },
): Promise<ComputedRevertPreview> {
  const samples = new Samples();
  let unchanged = 0;
  let edited = 0;
  const limit = deps.batchSize ?? CONVERSION_PREVIEW_BATCH_SIZE;
  let after = 0n;
  for (;;) {
    const rows = await deps.query.scanColumn(target.scope, target.tableId, target.access, {
      column: target.column,
      afterAuto: after,
      limit,
    });
    const later = rows
      .filter((row) => row.updatedAt.getTime() > target.finishedAt.getTime())
      .map((row) => row.id);
    const proven =
      later.length === 0
        ? new Set<string>()
        : ((await deps.provablyUntouched?.(later, target.finishedAt)) ?? new Set<string>());
    const touched = new Set(
      [
        ...later.filter((id) => !proven.has(id)),
        ...rows.filter((row) => row.auto > target.lastAuto).map((row) => row.id),
      ].map(String),
    );
    const shown = rows.filter((row) => touched.has(row.id) && row.readable);
    const values = await sourceJsonBatch(
      deps.members,
      target.scope,
      target.definition,
      shown.map((row) => row.value),
    );
    const byId = new Map<string, unknown>(shown.map((row, index) => [row.id, values[index]]));
    for (const row of rows) {
      if (!touched.has(row.id)) {
        unchanged += 1;
        continue;
      }
      edited += 1;
      if (row.readable) {
        samples.add({
          record_id: row.id,
          from: byId.get(row.id) ?? null,
          to: null,
          outcome: 'lost',
        });
      }
    }
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) break;
    after = last.auto;
  }
  return { unchanged, edited, samples: samples.list() };
}
