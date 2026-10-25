import {
  FIELD_TYPE_REGISTRY,
  isInvalidForTextStyle,
  MAX_SELECT_OPTIONS,
  missingSelectOptionNames,
  planFieldConversion,
  type CellConversion,
  type FieldConversionPlan,
  type SelectOptions,
  type TextOptions,
} from '@cellhive/field-types';

import { storedValueToJson } from '../storage-values.js';

import { convertBatch, targetReadOf, targetStorageOf, type ConversionLocale } from './cells.js';

import type { OrgScope } from '../../db/repository.js';
import type { JsonValue } from '../../db/schema.js';
import type { MemberDirectoryRepository } from '../member-directory.repository.js';
import type { RecordQueryService } from '../record-query.service.js';
import type { RecordAccessContext } from '../types.js';
import type { ColumnScanRow } from './column-scan.js';
import type { Id } from '@cellhive/contracts';

/** Rows read per statement by previews (each batch its own read transaction). */
export const CONVERSION_PREVIEW_BATCH_SIZE = 25_000;
/** Examples a preview returns (SPEC §5.5 item 4). */
export const CONVERSION_SAMPLE_LIMIT = 20;

export type SampleOutcome = 'kept' | 'truncated' | 'lost' | 'invalid';

export interface ConversionSample {
  readonly record_id: Id<'rec'>;
  readonly from: unknown;
  readonly to: unknown;
  readonly outcome: SampleOutcome;
}

export interface ConversionCounts {
  readonly affected: number;
  readonly lost: number;
  readonly truncated: number;
}

export interface ConversionPreviewResult extends ConversionCounts {
  /** Cells not matching a text `email`/`phone` style (only when the target has one). */
  readonly invalid: number | undefined;
  /** select ← text/number: names of the options the conversion creates, first seen first. */
  readonly newOptions: string[];
  /** More than 1 000 options would be needed (`TOO_MANY_OPTIONS`); counting stopped. */
  readonly tooManyOptions: boolean;
  readonly samples: ConversionSample[];
}

export interface ScanTarget {
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  /** The caller (samples from records they can read); `null`: every record. */
  readonly access: RecordAccessContext | null;
  /** Physical column of the values (field column or system column). */
  readonly column: string;
}

interface Deps {
  readonly query: RecordQueryService;
  readonly members: MemberDirectoryRepository;
  readonly batchSize?: number;
  /**
   * Revert fail-safe: of these records, those whose audit trail proves
   * the field untouched since `since` (missing or redacted trail: not proven).
   */
  readonly provablyUntouched?: (recordIds: readonly string[], since: Date) => Promise<Set<string>>;
}

/** Keeps the first samples of each kind, problems first. */
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

async function* batches(deps: Deps, target: ScanTarget, compareColumn?: string) {
  const limit = deps.batchSize ?? CONVERSION_PREVIEW_BATCH_SIZE;
  let after = 0n;
  for (;;) {
    const rows: ColumnScanRow[] = await deps.query.scanColumn(
      target.scope,
      target.tableId,
      target.access,
      {
        column: target.column,
        afterAuto: after,
        limit,
        ...(compareColumn === undefined ? {} : { compareColumn }),
      },
    );
    if (rows.length > 0) yield rows;
    const last = rows.at(-1);
    if (rows.length < limit || last === undefined) return;
    after = last.auto;
  }
}

/** The text style checked by a preview (`email`/`phone` of a text target), if any. */
function checkedStyle(plan: FieldConversionPlan): 'email' | 'phone' | null {
  if (plan.to.type !== 'text') return null;
  const style = (plan.to.options as TextOptions).style.type;
  return style === 'email' || style === 'phone' ? style : null;
}

/**
 * `convert-preview` (CONTRACTS §4.4): runs the conversion over every row of
 * the column in batches, without writing. Kind `none` counts nothing but
 * `invalid` (text styles `email`/`phone`: values stay as they are). Samples
 * only come from live records the caller can read.
 */
export async function previewConversion(
  deps: Deps,
  target: ScanTarget,
  plan: FieldConversionPlan,
  locale: ConversionLocale,
): Promise<ConversionPreviewResult> {
  const style = checkedStyle(plan);
  const samples = new Samples();
  let affected = 0;
  let lost = 0;
  let truncated = 0;
  let invalid = 0;
  const newOptions: string[] = [];
  const created = new Set<string>();
  let tooManyOptions = false;
  const selectTarget = plan.to.type === 'select' && plan.from.type !== 'select';
  const existingOptions = selectTarget ? (plan.to.options as SelectOptions).options.length : 0;
  const scan = plan.kind === 'none' ? style !== null : plan.kind !== 'forbidden';

  if (scan) {
    for await (const rows of batches(deps, target)) {
      if (plan.kind === 'none') {
        for (const row of rows) {
          const text = typeof row.value === 'string' ? row.value : null;
          if (style !== null && isInvalidForTextStyle(text, style)) {
            invalid += 1;
            if (row.readable) {
              samples.add({ record_id: row.id, from: text, to: text, outcome: 'invalid' });
            }
          }
        }
        continue;
      }
      const converted = await convertBatch(
        deps.members,
        target.scope,
        plan,
        locale,
        rows.map((row) => row.value),
      );
      converted.forEach(({ source, result }, index) => {
        const row = rows[index] as ColumnScanRow;
        if (result.outcome === 'empty') return;
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
            to = stored === undefined ? result.value : targetReadOf(plan, stored);
          }
          if (style !== null && isInvalidForTextStyle(to as string | null, style)) {
            invalid += 1;
          }
        }
        if (row.readable) samples.add({ record_id: row.id, from: source, to, outcome });
      });
      if (selectTarget && existingOptions + newOptions.length > MAX_SELECT_OPTIONS) {
        tooManyOptions = true;
        break;
      }
    }
  }
  return {
    affected,
    lost,
    truncated,
    invalid: style === null ? undefined : invalid,
    newOptions,
    tooManyOptions,
    samples: samples.list(),
  };
}

export interface RevertPreviewResult {
  /** Cells not written since the conversion: they get their old value back. */
  readonly unchanged: number;
  /** Cells written since the conversion (edited, or in a record created later). */
  readonly edited: number;
  /** Edited cells whose value cannot be expressed in the old type (the old value returns). */
  readonly editedUnconvertible: number;
  /**
   * Edited cells that keep their value (converted back to the old type), as
   * storage values of the old column: what a revert keeping later edits
   * writes into the old column before swapping it back.
   */
  readonly keptEdits: { readonly id: Id<'rec'>; readonly value: JsonValue }[];
  /** Edited cells first: `from` = current value, `to` = value after a revert keeping edits. */
  readonly samples: ConversionSample[];
}

/**
 * The revert preview (ADR-23 §3, BACKLOG S4 design decision #7): converts
 * the old column (or the system column a computed source reads) again and
 * compares with the current column. A cell that matches was not written
 * since the conversion and gets its old value back. A cell that differs was
 * edited (or belongs to a record created later): a revert keeping later
 * edits converts its current value back to the old type (`keptEdits`;
 * `outcome: kept`), or, when the old type cannot hold it, restores the old
 * value (`editedUnconvertible`; `outcome: lost`); a revert overwriting later
 * edits restores the old value of every cell.
 */
export async function previewRevert(
  deps: Deps,
  target: ScanTarget & {
    /** The converted column (compared). */
    readonly currentColumn: string;
    /** The old column is the field's own (not a system column): edits can be written back. */
    readonly writable: boolean;
    /**
     * When the conversion swapped in (`finished_at`): a record updated
     * later whose value looks untouched still counts as edited unless its
     * audit trail proves the field was not written (fail safe: keep it).
     */
    readonly finishedAt?: Date;
  },
  plan: FieldConversionPlan,
  locale: ConversionLocale,
): Promise<RevertPreviewResult> {
  const samples = new Samples();
  let unchanged = 0;
  let edited = 0;
  let editedUnconvertible = 0;
  const keptEdits: { id: Id<'rec'>; value: JsonValue }[] = [];
  const toDefinition = FIELD_TYPE_REGISTRY[plan.to.type];
  const back = reversePlan(plan);
  for await (const rows of batches(deps, target, target.currentColumn)) {
    const converted = await convertBatch(
      deps.members,
      target.scope,
      plan,
      locale,
      rows.map((row) => row.value),
    );
    const currentValues = rows.map((row) => storedValueToJson(plan.to.type, row.compare));
    const reversed =
      back.kind === 'none' || back.kind === 'forbidden' || back.kind === 'blacklist'
        ? null
        : await convertBatch(deps.members, target.scope, back, locale, currentValues);
    // Fail safe (design decision #7): records written after the swap whose
    // audit trail cannot prove the field untouched count as edited.
    const finishedAt = target.finishedAt;
    const updatedLater =
      finishedAt === undefined
        ? []
        : rows.filter((row) => row.updatedAt.getTime() > finishedAt.getTime()).map((row) => row.id);
    const proven =
      updatedLater.length === 0 || finishedAt === undefined
        ? new Set<string>()
        : ((await deps.provablyUntouched?.(updatedLater, finishedAt)) ?? new Set<string>());
    const uncertain = new Set(updatedLater.filter((id) => !proven.has(id)));
    converted.forEach(({ source, result }, index) => {
      const row = rows[index] as ColumnScanRow;
      const current = currentValues[index] ?? null;
      const expected =
        result.outcome === 'kept' || result.outcome === 'truncated'
          ? (targetStorageOf(plan, result.value) ?? emptyStorage(plan.to.type))
          : emptyStorage(plan.to.type);
      if (sameJson(current, expected) && !uncertain.has(row.id)) {
        unchanged += 1;
        return;
      }
      edited += 1;
      let kept: JsonValue | undefined;
      if (target.writable) kept = keptValueOf(back, current, reversed?.[index]?.result);
      if (kept === undefined) {
        editedUnconvertible += 1;
      } else {
        keptEdits.push({ id: row.id, value: kept });
      }
      if (row.readable) {
        samples.add({
          record_id: row.id,
          from: toDefinition.fromStorage(current, plan.to.options as never, {}),
          to:
            kept === undefined
              ? source
              : FIELD_TYPE_REGISTRY[back.to.type].fromStorage(kept, back.to.options as never, {}),
          outcome: kept === undefined ? 'lost' : 'kept',
        });
      }
    });
  }
  return { unchanged, edited, editedUnconvertible, keptEdits, samples: samples.list() };
}

/** The conversion from the new definition back to the old one. */
function reversePlan(plan: FieldConversionPlan): FieldConversionPlan {
  return planFieldConversion(plan.to, plan.from);
}

/**
 * Storage value of an edited cell in the old column, or `undefined` when
 * the old type cannot hold it. A same-kind reverse (`none`, e.g. single →
 * multiple select) keeps the storage value as it is.
 */
function keptValueOf(
  back: FieldConversionPlan,
  current: JsonValue,
  reversed: CellConversion | undefined,
): JsonValue | undefined {
  if (back.kind === 'none') return current;
  if (reversed === undefined) return undefined;
  if (reversed.outcome === 'empty') return emptyStorage(back.to.type);
  if (reversed.outcome === 'lost') return undefined;
  return targetStorageOf(back, reversed.value);
}

function emptyStorage(type: string): JsonValue {
  return type === 'checkbox' ? false : null;
}

function sameJson(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
