import { computedFilterResultOf } from '../computed/read/computed-fields.js';

import type { Id } from '@cellhive/contracts';

/**
 * Date fields the time scanner reads (BACKLOG T508, SPEC §11.2: trigger
 * `record.date_reached`; S5b date reminders share it through the time scan
 * core, ADR-29 §1, ADR-34 §1).
 *
 * - `instant`: a `timestamptz` value — `datetime` with a time, `created_at`
 *   (system column `__created_at`), a stored formula/lookup of type
 *   `datetime`;
 * - `date`: a `date` value (`YYYY-MM-DD`) — `datetime` with a date-only
 *   format, a stored formula/lookup of type `date`.
 *
 * `null`: anything else — other types, virtual formulas/lookups (computed on
 * read: their value changes without any write, so no index and no event
 * can follow them), list results.
 */
export type DueValueKind = 'instant' | 'date';

const DATE_ONLY_FORMAT = /^[^H]*$/u;

/** The part of a field row (or automation field meta) the kind depends on. */
export interface DueFieldLike {
  readonly type: string;
  readonly options: unknown;
  readonly compute_mode?: string | null;
  readonly result_type?: unknown;
}

export function dueValueKindOf(field: DueFieldLike): DueValueKind | null {
  switch (field.type) {
    case 'created_at':
      return 'instant';
    case 'datetime': {
      const options = field.options as { style?: { format?: unknown } } | null;
      // The default format (`yyyy-MM-dd`) is date-only.
      const format = options?.style?.format;
      return typeof format !== 'string' || DATE_ONLY_FORMAT.test(format) ? 'date' : 'instant';
    }
    case 'formula':
    case 'lookup': {
      if (field.compute_mode !== 'stored') return null;
      const result = computedFilterResultOf(field.result_type);
      if (result.resultType !== 'datetime' || result.resultIsList === true) return null;
      const format = (result.resultOptions as { style?: { format?: string } } | undefined)?.style
        ?.format;
      return format !== undefined && DATE_ONLY_FORMAT.test(format) ? 'date' : 'instant';
    }
    default:
      return null;
  }
}

/** A bound of the scanned range: an ISO instant (`instant`) or `YYYY-MM-DD` (`date`). */
export interface DueBound {
  readonly value: string;
  readonly inclusive: boolean;
}

/** One keyset page of the records whose date lies in a range (`RecordQueryService.scanDue`). */
export interface DueScanRequest {
  readonly fieldId: Id<'fld'>;
  readonly lower: DueBound;
  /** Upper bound, inclusive. */
  readonly upper: string;
  /** Keyset position: rows strictly after `(value, id)`; `null` = from the start. */
  readonly after: { readonly value: string; readonly id: Id<'rec'> } | null;
  readonly limit: number;
  /** Extra condition (Filter DSL with field ids), e.g. the automation's `condition`. */
  readonly filter?: unknown;
  /**
   * Field ids whose JSON cells each row carries (`DueScanRow.fields`), e.g.
   * the recipient field of a date reminder (ADR-34 §1); absent: none.
   */
  readonly fields?: readonly Id<'fld'>[];
}

export interface DueScanRow {
  readonly id: Id<'rec'>;
  /** ISO instant (`…Z`) for `instant` fields, `YYYY-MM-DD` for `date` fields. */
  readonly value: string;
  /** JSON cells of `DueScanRequest.fields` (by id), only when asked. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface DueScanPage {
  readonly kind: DueValueKind;
  readonly rows: readonly DueScanRow[];
}

/** The value of a scanned row as text (driver returns `Date` for `timestamptz`). */
export function dueValueText(kind: DueValueKind, raw: unknown): string | null {
  if (kind === 'instant') {
    const date = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : null;
    return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  }
  if (typeof raw !== 'string') return null;
  const text = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : null;
}
