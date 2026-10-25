import type { Tx } from '../../src/db/create-db.js';
import type { OrgScope } from '../../src/db/repository.js';
import type { DueScanPage, DueScanRequest, DueValueKind } from '../../src/records/index.js';
import type { DueScanner, TimeScanCursor, TimeScanCursorStore } from '../../src/time-scan/index.js';

/** A cursor table in memory (BACKLOG T546: unit tests of the core). */
export class MemoryCursorStore implements TimeScanCursorStore<string> {
  readonly cursors = new Map<string, Date>();
  readonly armed = new Map<string, Date | null>();
  locks = 0;

  arm(key: string, at: Date | null): void {
    this.armed.set(key, at);
  }

  async lock(_scope: OrgScope, key: string, now: Date): Promise<TimeScanCursor> {
    this.locks += 1;
    const armedAt = this.armed.get(key) ?? null;
    let scannedUntil = this.cursors.get(key);
    if (scannedUntil === undefined) {
      scannedUntil = armedAt ?? now;
      this.cursors.set(key, scannedUntil);
    }
    return Promise.resolve({ scannedUntil, armedAt });
  }

  async advance(_scope: OrgScope, key: string, until: Date): Promise<void> {
    const current = this.cursors.get(key);
    if (current === undefined || until.getTime() > current.getTime()) this.cursors.set(key, until);
    return Promise.resolve();
  }
}

export interface MemoryRecord {
  readonly id: string;
  /** Stored form: ISO instant (`instant`) or `YYYY-MM-DD` (`date`). */
  readonly value: string;
  /** Other cells, returned for `fields` asked. */
  readonly cells?: Readonly<Record<string, unknown>>;
}

/**
 * `RecordQueryService.scanDue` over records in memory: range on the value
 * (lower exclusive unless asked), keyset on `(value, id)`, `limit`. Records
 * every request; `fail` throws instead of reading (from the n-th call).
 */
export class MemoryScanner implements DueScanner {
  readonly requests: { access: unknown; request: DueScanRequest }[] = [];
  fail: { error: Error; fromCall: number } | null = null;

  constructor(
    private readonly kind: DueValueKind,
    private readonly records: readonly MemoryRecord[],
  ) {}

  async scanDue(
    _scope: OrgScope,
    _tableId: string,
    access: unknown,
    request: DueScanRequest,
  ): Promise<DueScanPage> {
    this.requests.push({ access, request });
    if (this.fail !== null && this.requests.length >= this.fail.fromCall) {
      return Promise.reject(this.fail.error);
    }
    const key = (value: string) => (this.kind === 'instant' ? Date.parse(value) : value);
    const lower = key(request.lower.value);
    const upper = key(request.upper);
    const rows = this.records
      .filter((record) => {
        const value = key(record.value);
        return (request.lower.inclusive ? value >= lower : value > lower) && value <= upper;
      })
      .sort((a, b) => compare(key(a.value), key(b.value)) || compare(a.id, b.id))
      .filter((record) => {
        const after = request.after;
        if (after === null) return true;
        const order = compare(key(record.value), key(after.value));
        return order > 0 || (order === 0 && record.id > after.id);
      })
      .slice(0, request.limit)
      .map((record) => ({
        id: record.id as `rec_${string}`,
        value: record.value,
        ...(request.fields === undefined
          ? {}
          : {
              fields: Object.fromEntries(
                request.fields.flatMap((id) =>
                  record.cells !== undefined && id in record.cells ? [[id, record.cells[id]]] : [],
                ),
              ),
            }),
      }));
    return Promise.resolve({ kind: this.kind, rows } as DueScanPage);
  }
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The consumer transaction handed through to `onDue` (never used by the core). */
export const FAKE_TX = { fake: 'tx' } as unknown as Tx;
