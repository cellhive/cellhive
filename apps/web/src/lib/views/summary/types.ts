import type { FieldDto, RecordSummariesResponse, SummaryFunction } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';
import type { ReactNode } from 'react';

/**
 * The summary bar under a grid (T472): its component lives in
 * `features/view/summary` and reaches the grid page through the view's
 * components (`ViewToolbarComponents.SummaryBar`, features do not import
 * each other, FRONTEND §1.2).
 */

/** Where the grid draws its columns (`GridView` `onColumnLayout`). */
export interface SummaryBarLayout {
  /** Width of the row-number gutter, px. */
  readonly gutter: number;
  /** Columns in display order with their widths, px. */
  readonly columns: readonly { readonly fieldId: string; readonly width: number }[];
  /** Columns that stay in place when the grid scrolls sideways. */
  readonly frozen: number;
  /** The grid's scrolling element (its `scrollLeft` moves the other columns). */
  readonly scroller: () => HTMLElement | null;
}

export interface SummaryBarProps {
  readonly layout: SummaryBarLayout;
  /** Fields the user reads, by id. */
  readonly fields: ReadonlyMap<string, FieldDto>;
  /** Summaries applied (saved ⊕ temporary, still valid), field id → function. */
  readonly config: Readonly<Record<string, SummaryFunction>>;
  readonly result: RecordSummariesResponse | undefined;
  /** New numbers are on their way (the old ones stay, dimmed). */
  readonly busy: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  /** Absent: read-only. `null` removes the column's summary. */
  readonly onChange?: ((fieldId: string, fn: SummaryFunction | null) => void) | undefined;
  readonly locale: LocaleContext;
  /** The gutter: the short count, the full text (tooltip, name), what screen readers hear. */
  readonly count: {
    readonly short: string;
    readonly full: string;
    readonly status: ReactNode;
  };
  /** Below 768 px: the bar scrolls on its own and the menu is a bottom sheet. */
  readonly narrow?: boolean;
}
