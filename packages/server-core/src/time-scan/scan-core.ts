import { AppError } from '../errors/app-error.js';

import { dueAt, valueRangeOf, type DueRule } from './due.js';

import type { TimeScanWindow } from './cursor-store.js';
import type { Tx } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';
import type { DueScanRow } from '../records/due/due-scan.js';
import type { SystemScanAccess } from '../records/due/system-scan.js';
import type { RecordQueryService } from '../records/record-query.service.js';
import type { RecordAccessContext } from '../records/types.js';
import type { SchemaService } from '../schema/schema.service.js';
import type { Id } from '@cellhive/contracts';

/** The record reader of the core: `RecordQueryService.scanDue` (tests give a stand-in). */
export type DueScanner = Pick<RecordQueryService, 'scanDue'>;

/** Who reads the scanned records: a member (automation `run_as`) or the system (reminders). */
export type TimeScanAccess = RecordAccessContext | SystemScanAccess;

/**
 * Called once per record whose due moment falls in the window, in order of
 * `(value, record id)`, inside the consumer's transaction `tx`. Returns
 * whether it produced something (a run, a reminder): only those count
 * towards `maxHits` (a duplicate of an earlier scan does not).
 */
export type OnDue = (tx: Tx, record: DueScanRow, dueAt: number) => Promise<boolean>;

export interface TimeScanRequest {
  /** The consumer's transaction (cursor locked in it); handed to `onDue`. */
  readonly tx: Tx;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly rule: DueRule;
  readonly window: TimeScanWindow;
  readonly access: TimeScanAccess;
  /** Extra condition (Filter DSL with field ids), e.g. an automation `condition`. */
  readonly filter?: unknown;
  /** Field ids whose JSON cells each record carries (`DueScanRow.fields`). */
  readonly fields?: readonly Id<'fld'>[];
  /** Records read per page. */
  readonly pageSize: number;
  /** Hits per scan at most; the rest waits for the next scan. */
  readonly maxHits: number;
  /**
   * Where a capped scan of this window stopped (QA S5b M7): the due moment of
   * its last hit and that record. Every record due at that moment up to it,
   * in scan order, was handled, so the scan seeks past them (one probe row)
   * instead of reading them again — without it, a moment shared by many
   * records is read again from its start by every scan (quadratic).
   */
  readonly resumeAfter?: { readonly due: number; readonly id: Id<'rec'> };
  readonly onDue: OnDue;
}

/**
 * - `done`: the whole window was read;
 * - `capped`: `maxHits` reached, the rest is left for the next scan;
 * - `unavailable`: the table or field cannot be read any more (`404` /
 *   `422 INVALID_FILTER` from the reader) — the window counts as handled.
 */
export type TimeScanOutcome = 'done' | 'capped' | 'unavailable';

export interface TimeScanResult {
  readonly outcome: TimeScanOutcome;
  /** `onDue` calls that returned `true`. */
  readonly hits: number;
  /**
   * Where the consumer moves its cursor: the end of the window, or, when
   * capped, just before the due moment of the last hit (`due − 1 ms`, never
   * before the window's start) so records due at that same moment and not
   * yet handled are read again next scan — the consumer's own dedupe skips
   * the ones already handled.
   */
  readonly until: Date;
}

export interface TimeScanCoreOptions {
  /**
   * Creates the scan index of a date column (`SchemaService.ensureDueIndex`);
   * without it the scan reads without one (tests).
   */
  readonly schema?: Pick<SchemaService, 'ensureDueIndex'>;
  /** Called when the scan index cannot be created (the scan goes on without it). */
  readonly onIndexError?: (error: unknown, fieldId: Id<'fld'>) => void;
  /** Clock in milliseconds (tests). */
  readonly now?: () => number;
}

/**
 * How long a scan index found or created is trusted before it is checked
 * again: compaction, a type conversion or a revert can leave the column
 * without it, and `ensureDueIndex` takes the table's schema lock, so not
 * on every scan.
 */
export const DUE_INDEX_RECHECK_MS = 10 * 60 * 1000;

/**
 * The shared time scan core (ADR-34 §1, BACKLOG T546), split from the
 * `record.date_reached` scan of T508 so S5b date reminders (and later
 * consumers) reuse it without being automations.
 *
 * A consumer locks its cursor (`TimeScanCursorStore`, `openWindow`), builds
 * the rule of its date field (`dueRuleOf`), then calls {@link scan}: the
 * records are read through `RecordQueryService.scanDue` with the
 * consumer's `access` and `filter` by range on the column (`valueRangeOf`,
 * index from `ensureIndex`), keyset-paginated on `(value, __id)`; only
 * records whose `dueAt` falls in the window `(from, to]` reach `onDue`.
 * The consumer then advances its cursor to `until` in the same
 * transaction. The core never reads `data.*` itself and builds no SQL
 * (AGENTS.md rules 1–2), and never logs values.
 */
export class TimeScanCore {
  /** Date fields whose scan index existed, with when that was checked. */
  private readonly indexed = new Map<string, number>();

  constructor(
    private readonly records: DueScanner,
    private readonly options: TimeScanCoreOptions = {},
  ) {}

  /**
   * Creates the scan index of `fieldId` (outside any transaction: it takes
   * the table's schema lock), checking it again every
   * {@link DUE_INDEX_RECHECK_MS}. Fields that need none (`not_applicable`)
   * are asked again next time; errors go to `onIndexError` and never stop
   * the scan.
   */
  async ensureIndex(scope: OrgScope, fieldId: Id<'fld'>): Promise<void> {
    const schema = this.options.schema;
    if (schema === undefined) return;
    const now = this.options.now?.() ?? Date.now();
    const checkedAt = this.indexed.get(fieldId);
    if (checkedAt !== undefined && now - checkedAt < DUE_INDEX_RECHECK_MS) return;
    try {
      const outcome = await schema.ensureDueIndex(scope, fieldId);
      if (outcome === 'not_applicable') this.indexed.delete(fieldId);
      else this.indexed.set(fieldId, now);
    } catch (error) {
      this.options.onIndexError?.(error, fieldId);
    }
  }

  /**
   * Scans one window. `scope` is the organization scope **without** the
   * consumer's transaction: each page is read in its own read-only
   * transaction (statement timeout, read lock of the table). A reader error
   * other than `NOT_FOUND` / `INVALID_FILTER` (timeout, database) is
   * thrown: the consumer's transaction rolls back and the next scan handles
   * the same window again.
   */
  async scan(scope: OrgScope, request: TimeScanRequest): Promise<TimeScanResult> {
    const { window, rule } = request;
    if (!Number.isSafeInteger(request.maxHits) || request.maxHits < 1) {
      throw new RangeError('maxHits must be a positive integer');
    }
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1) {
      throw new RangeError('pageSize must be a positive integer');
    }
    const end = new Date(window.to);
    const range = valueRangeOf(rule, window.from, window.to);
    let after: { value: string; id: Id<'rec'> } | null = null;
    let hits = 0;
    let seek = request.resumeAfter ?? null;
    for (;;) {
      // Seeking: one row tells the stored value of the first moment of the window.
      const limit = seek === null ? request.pageSize : 1;
      let page;
      try {
        page = await this.records.scanDue(scope, request.tableId, request.access, {
          fieldId: request.fieldId,
          lower: range.lower,
          upper: range.upper,
          after,
          limit,
          ...(request.filter === undefined ? {} : { filter: request.filter }),
          ...(request.fields === undefined ? {} : { fields: request.fields }),
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'NOT_FOUND' || error.code === 'INVALID_FILTER')
        ) {
          return { outcome: 'unavailable', hits, until: end };
        }
        throw error;
      }
      if (seek !== null) {
        const target = seek;
        seek = null;
        const first = page.rows[0];
        if (first !== undefined && dueAt(rule, first.value) === target.due) {
          // Keyset past the records of that moment already handled.
          after = { value: first.value, id: target.id };
          continue;
        }
      }
      for (const record of page.rows) {
        const due = dueAt(rule, record.value);
        if (due === null || due <= window.from || due > window.to) continue;
        if (!(await request.onDue(request.tx, record, due))) continue;
        hits += 1;
        if (hits >= request.maxHits) {
          return { outcome: 'capped', hits, until: new Date(Math.max(window.from, due - 1)) };
        }
      }
      const last = page.rows.at(-1);
      if (last === undefined || page.rows.length < limit) break;
      after = { value: last.value, id: last.id };
    }
    return { outcome: 'done', hits, until: end };
  }
}
