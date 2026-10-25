import { cn, Skeleton } from '@cellhive/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';

import type { GridField, GridRecord, GridViewport } from '../../../grid';
import type { LocaleContext } from '@cellhive/field-types';

/** Height of one card with its gap, px (fixed: the list is windowed); fits the title and three rows of chips. */
export const CARD_HEIGHT = 144;
/** Cards rendered above and below the visible ones. */
const OVERSCAN = 4;
/** Fields shown under the title of a card. */
const CARD_FIELDS = 3;

export interface RecordCardListProps {
  /** Visible fields in display order; the first is the primary field (the card title). */
  readonly fields: readonly GridField[];
  readonly rowCount: number;
  readonly getRecord: (row: number) => GridRecord | undefined;
  /** Changes whenever rows arrive or change. */
  readonly dataVersion: number;
  readonly onViewportChange: (viewport: GridViewport) => void;
  readonly locale: LocaleContext;
  /** Accessible name of the list (the table name). */
  readonly label: string;
  readonly onOpen: (recordId: string) => void;
  /** A new value scrolls back to the top (the query changed). */
  readonly scrollResetKey: string;
  /**
   * A sub-record tree (T417): the parent path shown above a card's title
   * ("Parent › Child"), and whether the card is only an ancestor of a
   * filter match (dimmed).
   */
  readonly treeOf?:
    ((row: number) => { readonly path: string; readonly dimmed: boolean }) | undefined;
}

/**
 * The grid below 768 px (FRONTEND §9.4): a read-only list of cards, the
 * primary field as title and the next few visible fields under it. Rows
 * come from the same block loader as the grid (windowed: only the cards on
 * screen are rendered and only their blocks are loaded). A card opens the
 * record panel, full screen, where the record is edited.
 */
export function RecordCardList({
  fields,
  rowCount,
  getRecord,
  dataVersion,
  onViewportChange,
  locale,
  label,
  onOpen,
  scrollResetKey,
  treeOf,
}: RecordCardListProps) {
  const { t } = useTranslation('grid');
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    setHeight(element.clientHeight || 600);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setHeight(element.clientHeight || 600);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    // The scroll event brings `scrollTop` back to 0.
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [scrollResetKey]);

  const firstVisible = Math.floor(scrollTop / CARD_HEIGHT);
  const lastVisible = Math.min(rowCount - 1, Math.ceil((scrollTop + height) / CARD_HEIGHT));
  useEffect(() => {
    if (rowCount === 0) return;
    onViewportChange({
      firstRow: firstVisible,
      lastRow: Math.max(firstVisible, lastVisible),
      dragging: false,
    });
  }, [firstVisible, lastVisible, rowCount, onViewportChange]);

  const first = Math.max(0, firstVisible - OVERSCAN);
  const last = Math.min(rowCount - 1, lastVisible + OVERSCAN);
  const rows: number[] = [];
  for (let row = first; row <= last; row += 1) rows.push(row);
  const [primary, ...rest] = fields;
  const details = rest.slice(0, CARD_FIELDS);

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto bg-canvas"
      data-version={dataVersion}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <ul
        aria-label={label}
        className="relative mx-4"
        style={{ height: Math.max(rowCount, 0) * CARD_HEIGHT + 16 }}
      >
        {rows.map((row) => {
          const record = getRecord(row);
          const top = row * CARD_HEIGHT + 12;
          const tree = record === undefined ? undefined : treeOf?.(row);
          return (
            <li
              key={record?.id ?? `row-${String(row)}`}
              aria-setsize={rowCount}
              aria-posinset={row + 1}
              className="absolute inset-x-0"
              style={{ top, height: CARD_HEIGHT - 8 }}
            >
              {record === undefined || primary === undefined ? (
                <div className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-3">
                  <span className="sr-only">{t('cards.loading')}</span>
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : (
                <button
                  type="button"
                  className={cn(
                    'flex h-full w-full flex-col items-stretch gap-1 overflow-hidden rounded-lg border border-line bg-surface p-3 text-left hover:border-line-strong',
                    tree?.dimmed === true && 'opacity-60',
                  )}
                  onClick={() => {
                    onOpen(record.id);
                  }}
                >
                  {tree === undefined || tree.path === '' ? null : (
                    <span
                      className="shrink-0 truncate text-label font-normal text-fg-muted"
                      data-testid="card-parent-path"
                    >
                      {tree.path}
                    </span>
                  )}
                  <span className="shrink-0 truncate text-heading">
                    <CellValue
                      field={primary}
                      value={record.fields[primary.field.id]}
                      locale={locale}
                      empty={t('cards.untitled')}
                      compact
                      links={false}
                    />
                  </span>
                  {/* The path takes a line: one detail fewer (the card height is fixed). */}
                  {(tree === undefined || tree.path === '' ? details : details.slice(0, -1)).map(
                    (field) => (
                      <span
                        key={field.field.id}
                        className="flex min-h-6 min-w-0 shrink-0 items-center gap-2 text-label font-normal"
                      >
                        <span className="w-24 shrink-0 truncate text-fg-muted">
                          {field.field.name}
                        </span>
                        <CellValue
                          field={field}
                          value={record.fields[field.field.id]}
                          locale={locale}
                          empty="—"
                          compact
                          links={false}
                          className="flex-1"
                        />
                      </span>
                    ),
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
