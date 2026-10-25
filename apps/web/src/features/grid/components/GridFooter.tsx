import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';

import type { BlockSnapshot } from '../blocks/block-loader';

export interface GridFooterProps {
  readonly snapshot: BlockSnapshot;
  /**
   * (T320b) Why rows may be missing: a filter (saved or temporary) or a
   * search is active. With {@link total}, the count reads "N / M records
   * match the filter" (design "Grid - Tickets").
   */
  readonly narrowedBy?: 'filter' | 'search' | null;
  /** (T320b) Records of the table the user reads, without view or filter (`tableRecordCountQuery`). */
  readonly total?: { readonly count: number; readonly estimated: boolean } | undefined;
  /** (T320b) Selected rows, shown after the count. */
  readonly selected?: number;
  /** Top-level groups of a grouped grid (T320a): "N records · M groups". */
  readonly groups?: number;
  /**
   * (T421b) A sub-record tree: the rows are the records shown (roots and
   * open branches). Unless narrowed, the count is every record ({@link total})
   * followed by "N shown".
   */
  readonly tree?: boolean;
}

/** The texts of the record count (T320b, T421b), shared by the footer and the summary bar's gutter. */
export interface GridFooterTexts {
  /** "318 records" (the live status; "About N" while estimated). */
  readonly status: string;
  /** "/ 2,000 · match the filter". */
  readonly of: string | null;
  /** "5 shown" (a tree). */
  readonly shown: string | null;
  /** "1 row selected". */
  readonly selected: string | null;
}

/**
 * Record count under the grid (FRONTEND §3.3): the exact `total`, or
 * "About N" while only `total_estimate` is known (above 100 000 rows,
 * CONTRACTS §1.1) — it becomes exact once the end of the table is loaded.
 * T320b: "318 records / 2,000 · match the filter" while a filter or search
 * narrows the rows (the status keeps "318 records"), and "1 row selected".
 * A grouped grid (T320a) adds its number of top-level groups to the status.
 * T472: the summary bar shows it in the row-number gutter (shortened, full
 * texts in the tooltip and for screen readers).
 */
export function useGridFooterTexts({
  snapshot,
  narrowedBy = null,
  total,
  selected = 0,
  groups,
  tree = false,
}: GridFooterProps): GridFooterTexts {
  const { t } = useTranslation('grid');
  const format = useFormatters();
  const formatted = format.number(snapshot.rowCount);
  // A whole tree: every record, then how many rows the open branches show.
  const whole =
    tree && narrowedBy === null && total !== undefined && snapshot.status === 'ready'
      ? total
      : null;
  let text: string;
  if (snapshot.status !== 'ready') text = t('footer.loading');
  else if (whole !== null) {
    const all = format.number(whole.count);
    text = whole.estimated
      ? t('footer.estimated', { formatted: all })
      : t('footer.records', { count: whole.count, formatted: all });
  } else if (snapshot.estimated) text = t('footer.estimated', { formatted });
  else text = t('footer.records', { count: snapshot.rowCount, formatted });
  const shown =
    whole !== null && whole.count !== snapshot.rowCount
      ? t('footer.shown', { count: snapshot.rowCount, formatted })
      : null;
  if (groups !== undefined && snapshot.status === 'ready') {
    text = t('footer.withGroups', {
      records: text,
      groups: t('footer.groups', { count: groups, formatted: format.number(groups) }),
    });
  }
  // "318 records / 2,000 · match the filter": the live count stays "N records"
  // (announced alone); what it is out of follows it.
  const context =
    snapshot.status === 'ready' && narrowedBy !== null && total !== undefined
      ? t(narrowedBy === 'filter' ? 'footer.matchingFilter' : 'footer.matchingSearch', {
          total: `${total.estimated ? '~' : ''}${format.number(total.count)}`,
        })
      : null;
  return {
    status: text,
    of: context,
    shown,
    selected: selected > 0 ? t('footer.selected', { count: selected }) : null,
  };
}

/** The count texts as paragraphs (visually hidden in the summary bar's gutter, T472). */
export function GridFooterText({
  texts,
  hidden = false,
}: {
  readonly texts: GridFooterTexts;
  readonly hidden?: boolean;
}) {
  const className = hidden ? 'sr-only' : 'text-label font-normal text-fg-muted tabular-nums';
  return (
    <>
      <p role="status" className={className}>
        {texts.status}
      </p>
      {texts.of === null ? null : (
        <p className={hidden ? className : `-ml-2 ${className}`} data-testid="footer-of">
          {texts.of}
        </p>
      )}
      {texts.shown === null ? null : (
        <p className={className} data-testid="footer-shown">
          {texts.shown}
        </p>
      )}
      {texts.selected === null ? null : (
        <p className={className} data-testid="footer-selected">
          {texts.selected}
        </p>
      )}
    </>
  );
}

/** The count alone, under a grid without a summary bar. */
export function GridFooter(props: GridFooterProps) {
  const texts = useGridFooterTexts(props);
  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 lg:px-4">
      <GridFooterText texts={texts} />
    </footer>
  );
}
