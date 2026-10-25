import { cn, Skeleton } from '@cellhive/ui';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../../grid/display/CellValue';

import type { GridField, GridRecord } from '../../../../grid';
import type { LocaleContext } from '@cellhive/field-types';

/** A group header row of the card list. */
export interface CardGroupHeader {
  readonly label: string;
  readonly level: number;
}

/** Height of one card with its gap, px (fixed: the list is windowed). */
export const SHARE_CARD_HEIGHT = 128;
/** Cards rendered above and below the visible ones. */
const OVERSCAN = 4;
/** Fields shown under the title of a card. */
const CARD_FIELDS = 3;

export interface SharedCardListProps {
  /** Fields in display order; the first is the primary field (the card title). */
  readonly fields: readonly GridField[];
  readonly rowCount: number;
  /** A group header row, or `undefined` for a record row. */
  readonly rowHeader: (row: number) => CardGroupHeader | undefined;
  /** The record of a record row, `undefined` while it loads. */
  readonly getRecord: (row: number) => GridRecord | undefined;
  readonly dataVersion: number;
  readonly onViewportChange: (range: { firstRow: number; lastRow: number }) => void;
  readonly locale: LocaleContext;
  readonly label: string;
  /** Opens the record detail; absent when the link hides it. */
  readonly onOpen?: ((recordId: string) => void) | undefined;
  /**
   * Opens the viewer on the files of an attachment field of a card (T419):
   * without the record detail, the files are a button of their own.
   */
  readonly onViewFiles?: ((record: GridRecord, fieldId: string) => void) | undefined;
  readonly allowCopy: boolean;
  readonly scrollResetKey: string;
}

/**
 * The shared grid below 768 px (FRONTEND §9.4): a windowed list of cards
 * (primary field as title, the next fields under it) with the group headers
 * of the view, over the same rows as the grid.
 */
export function SharedCardList({
  fields,
  rowCount,
  rowHeader,
  getRecord,
  dataVersion,
  onViewportChange,
  locale,
  label,
  onOpen,
  onViewFiles,
  allowCopy,
  scrollResetKey,
}: SharedCardListProps) {
  const { t } = useTranslation('sharePage');
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
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [scrollResetKey]);

  const firstVisible = Math.floor(scrollTop / SHARE_CARD_HEIGHT);
  const lastVisible = Math.min(rowCount - 1, Math.ceil((scrollTop + height) / SHARE_CARD_HEIGHT));
  useEffect(() => {
    if (rowCount === 0) return;
    onViewportChange({ firstRow: firstVisible, lastRow: Math.max(firstVisible, lastVisible) });
  }, [firstVisible, lastVisible, rowCount, onViewportChange]);

  const first = Math.max(0, firstVisible - OVERSCAN);
  const last = Math.min(rowCount - 1, lastVisible + OVERSCAN);
  const rows: number[] = [];
  for (let row = first; row <= last; row += 1) rows.push(row);
  const [primary, ...rest] = fields;
  const details = rest.slice(0, CARD_FIELDS);

  const cardBody = (record: GridRecord): ReactNode =>
    primary === undefined ? null : (
      <>
        <span className="shrink-0 truncate text-heading">
          <CellValue
            links={onOpen === undefined}
            field={primary}
            value={record.fields[primary.field.id]}
            locale={locale}
            empty={t('cards.untitled')}
            compact
          />
        </span>
        {details.map((field) => {
          const value = record.fields[field.field.id];
          const files =
            onOpen === undefined &&
            onViewFiles !== undefined &&
            field.config?.type === 'attachment' &&
            Array.isArray(value) &&
            value.length > 0
              ? value.length
              : 0;
          return (
            <span
              key={field.field.id}
              className="flex min-h-6 min-w-0 shrink-0 items-center gap-2 text-label font-normal"
            >
              <span className="w-24 shrink-0 truncate text-fg-muted">{field.field.name}</span>
              {files > 0 ? (
                <button
                  type="button"
                  className="flex min-h-6 min-w-0 flex-1 items-center rounded-sm text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={t('cards.viewFiles', { count: files, field: field.field.name })}
                  data-testid="share-card-files"
                  onClick={() => {
                    onViewFiles?.(record, field.field.id);
                  }}
                >
                  <CellValue
                    field={field}
                    value={value}
                    locale={locale}
                    empty="—"
                    compact
                    links={false}
                  />
                </button>
              ) : (
                <CellValue
                  links={onOpen === undefined}
                  field={field}
                  value={value}
                  locale={locale}
                  empty="—"
                  compact
                  className="flex-1"
                />
              )}
            </span>
          );
        })}
      </>
    );

  const cardClass =
    'flex h-full w-full flex-col items-stretch gap-1 overflow-hidden rounded-lg border border-line bg-surface p-3 text-left';

  return (
    <div
      ref={scroller}
      className={cn('min-h-0 flex-1 overflow-y-auto bg-canvas', !allowCopy && 'select-none')}
      data-version={dataVersion}
      data-testid="share-card-list"
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <ul
        aria-label={label}
        className="relative mx-4"
        style={{ height: Math.max(rowCount, 0) * SHARE_CARD_HEIGHT + 16 }}
      >
        {rows.map((row) => {
          const top = row * SHARE_CARD_HEIGHT + 12;
          const header = rowHeader(row);
          if (header !== undefined) {
            return (
              <li
                key={`header-${String(row)}`}
                aria-setsize={rowCount}
                aria-posinset={row + 1}
                className="absolute inset-x-0 flex items-end pb-2"
                style={{ top, height: SHARE_CARD_HEIGHT - 8, paddingLeft: header.level * 12 }}
              >
                <span role="heading" aria-level={2 + header.level} className="text-heading">
                  {header.label}
                </span>
              </li>
            );
          }
          const record = getRecord(row);
          return (
            <li
              key={record?.id ?? `row-${String(row)}`}
              aria-setsize={rowCount}
              aria-posinset={row + 1}
              className="absolute inset-x-0"
              style={{ top, height: SHARE_CARD_HEIGHT - 8 }}
            >
              {record === undefined || primary === undefined ? (
                <div className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-3">
                  <span className="sr-only">{t('cards.loading')}</span>
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : onOpen === undefined ? (
                <div className={cardClass}>{cardBody(record)}</div>
              ) : (
                <button
                  type="button"
                  className={cn(cardClass, 'hover:border-line-strong')}
                  onClick={() => {
                    onOpen(record.id);
                  }}
                >
                  {cardBody(record)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
