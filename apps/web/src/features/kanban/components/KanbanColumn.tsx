import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  Spinner,
  Tooltip,
} from '@cellhive/ui';
import { useDroppable } from '@dnd-kit/core';
import { Ellipsis, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';

import { CARD_GAP, KanbanCard, type CardCover } from './KanbanCard';

import type { GridField } from '../../../grid/types';
import type { KanbanColumnDef } from '../board';
import type { KanbanColumnState } from '../use-kanban-data';
import type { MoveBlock } from '../use-kanban-editing';
import type { LocaleContext } from '@cellhive/field-types';
import type { ReactNode } from 'react';

/** Cards rendered above and below the visible ones. */
const OVERSCAN = 3;
/** Load the next page when the last loaded card is this close to the bottom. */
const LOAD_AHEAD = 5;
/** Skeleton cards of a column whose first page is on its way. */
const SKELETON_CARDS = 3;

/** Index of the first card whose bottom is below `y` (`tops`: card tops plus the end). */
export function firstEndingAfter(tops: readonly number[], y: number): number {
  let low = 0;
  let high = tops.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tops[middle + 1] ?? 0) > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Heights of the rendered cards, measured with a `ResizeObserver` (they
 * change with the card fields and the column width). Forgotten when the
 * estimate changes (other card fields). Without `ResizeObserver` (jsdom)
 * every card keeps the estimate.
 */
function useCardHeights(estimate: number): {
  heights: ReadonlyMap<string, number>;
  observe: (element: HTMLElement | null) => (() => void) | undefined;
} {
  const [state, setState] = useState<{ estimate: number; heights: ReadonlyMap<string, number> }>(
    () => ({ estimate, heights: new Map() }),
  );
  if (state.estimate !== estimate) setState({ estimate, heights: new Map() });
  const observer = useRef<ResizeObserver | null>(null);
  // Elements attached before the observer exists (first render).
  const pending = useRef(new Set<HTMLElement>());
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const instance = new ResizeObserver((entries) => {
      setState((current) => {
        let next: Map<string, number> | null = null;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset['measureId'];
          const measuredHeight = Math.round(entry.borderBoxSize[0]?.blockSize ?? 0);
          if (id === undefined || measuredHeight === 0) continue;
          if (current.heights.get(id) === measuredHeight) continue;
          next ??= new Map(current.heights);
          next.set(id, measuredHeight);
        }
        return next === null ? current : { ...current, heights: next };
      });
    });
    observer.current = instance;
    for (const element of pending.current) instance.observe(element);
    pending.current.clear();
    return () => {
      instance.disconnect();
      observer.current = null;
    };
  }, []);
  const observe = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    if (observer.current === null) pending.current.add(element);
    else observer.current.observe(element);
    // React 19 ref cleanup: a card scrolled out of the window is no longer observed.
    return () => {
      pending.current.delete(element);
      observer.current?.unobserve(element);
    };
  }, []);
  return { heights: state.heights, observe };
}

export interface KanbanColumnProps {
  readonly column: KanbanColumnState;
  readonly columns: readonly KanbanColumnDef[];
  readonly columnName: (column: KanbanColumnDef) => string;
  readonly groupField: GridField;
  readonly primary: GridField | undefined;
  readonly cardFields: readonly GridField[];
  /** Cover image of the cards (T418). */
  readonly cover?: CardCover | null | undefined;
  readonly locale: LocaleContext;
  /** Tallest card: the height of a card until it is measured (windowing estimate). */
  readonly cardHeight: number;
  /** Cards may be dragged (and moved from their menu). */
  readonly canMove: boolean;
  /** Why cards cannot be moved (card menu), when {@link canMove} is off. */
  readonly moveBlocked?: MoveBlock | null | undefined;
  readonly canAdd: boolean;
  /** "Hide empty columns" of the board, offered in the column menu. */
  readonly hideEmpty?: boolean | undefined;
  readonly onHideEmpty?: ((hide: boolean) => void) | undefined;
  /** Width of a column (narrow screens show one at a time). */
  readonly narrow: boolean;
  readonly isMoving: (recordId: string) => boolean;
  readonly onOpen: (recordId: string) => void;
  readonly onMove: (recordId: string, to: KanbanColumnDef) => void;
  readonly onAdd: (column: KanbanColumnDef) => void;
  readonly onLoadMore: (column: string) => void;
  /** "Follow" / "Unfollow" item of a card menu (T553). */
  readonly followItem?: ((recordId: string) => ReactNode) | undefined;
}

/**
 * One column: its value and count, then its cards — windowed on measured
 * card heights (a card is as tall as its content, T322b; `cardHeight`
 * until measured), the next page loaded when scrolling near the end. The
 * column is the drop target of dragged cards.
 */
export function KanbanColumn({
  column,
  columns,
  columnName,
  groupField,
  primary,
  cardFields,
  cover,
  locale,
  cardHeight,
  canMove,
  moveBlocked = null,
  canAdd,
  hideEmpty = false,
  onHideEmpty,
  narrow,
  isMoving,
  onOpen,
  onMove,
  onAdd,
  onLoadMore,
  followItem,
}: KanbanColumnProps) {
  const { t, i18n } = useTranslation('kanban');
  const { def, cards, count } = column;
  const name = columnName(def);
  const { setNodeRef, isOver } = useDroppable({ id: def.key, disabled: !canMove });

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

  const measured = useCardHeights(cardHeight);
  // Top of each card (and the end of the list), from measured heights.
  const tops = useMemo(() => {
    const result = new Array<number>(cards.length + 1);
    result[0] = 0;
    cards.forEach((card, index) => {
      result[index + 1] =
        (result[index] ?? 0) + (measured.heights.get(card.id) ?? cardHeight) + CARD_GAP;
    });
    return result;
  }, [cards, measured.heights, cardHeight]);
  const topOf = (index: number) => tops[index] ?? 0;
  const firstVisible = firstEndingAfter(tops, scrollTop);
  const lastVisible = firstEndingAfter(tops, scrollTop + height);
  const first = Math.max(0, firstVisible - OVERSCAN);
  const last = Math.min(cards.length - 1, lastVisible + OVERSCAN);

  const { hasMore, loadingMore } = column;
  useEffect(() => {
    if (hasMore && !loadingMore && lastVisible >= cards.length - LOAD_AHEAD) onLoadMore(def.key);
  }, [hasMore, loadingMore, lastVisible, cards.length, onLoadMore, def.key]);

  /** Focus the card `step` away from `recordId` (scrolled into view first). */
  const step = (recordId: string, by: -1 | 1) => {
    const index = cards.findIndex((card) => card.id === recordId) + by;
    const target = cards[index];
    const element = scroller.current;
    if (target === undefined || element === null) return;
    const top = topOf(index);
    const bottom = topOf(index + 1);
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    // The card renders once the list follows the new scroll position.
    requestAnimationFrame(() => {
      element.querySelector<HTMLElement>(`[data-card-id="${target.id}"]`)?.focus();
    });
  };

  /**
   * "Move to…" from a card menu: the card leaves this column, so the focus
   * goes to the next card (else the previous one, else the moved card in its
   * new column) instead of being lost with the card (FRONTEND §9.2).
   */
  const moveFromMenu = (recordId: string, to: KanbanColumnDef) => {
    const index = cards.findIndex((card) => card.id === recordId);
    const neighbour = cards[index + 1] ?? cards[index - 1];
    onMove(recordId, to);
    const focus = (id: string) =>
      document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);
    requestAnimationFrame(() => {
      const target =
        (neighbour === undefined ? null : focus(neighbour.id)) ??
        focus(recordId) ??
        scroller.current?.closest('section')?.querySelector<HTMLElement>('button') ??
        null;
      target?.focus();
    });
  };

  const headerId = `kanban-column-${def.key}`;
  const countText = count === null ? '' : count.toLocaleString(i18n.language);
  const showSkeleton = column.loading && cards.length === 0;
  const rows: number[] = [];
  for (let index = first; index <= last; index += 1) rows.push(index);

  return (
    <section
      ref={setNodeRef}
      aria-labelledby={headerId}
      aria-busy={column.loading || loadingMore}
      data-testid="kanban-column"
      data-column={def.key}
      className={cn(
        'flex h-full shrink-0 flex-col rounded-lg border border-transparent bg-surface-sunken',
        narrow ? 'w-[85vw] max-w-80 snap-start' : 'w-68',
        isOver && 'border-accent bg-accent-soft',
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 pr-1 pl-3">
        <h2 id={headerId} className="flex min-w-0 flex-1 items-center gap-2 text-label">
          <span className="flex min-w-0 items-center">
            {def.kind === 'empty' ? (
              <span className="inline-flex h-[22px] max-w-full items-center truncate rounded-sm border border-line bg-surface px-2 font-medium text-fg-muted">
                {name}
              </span>
            ) : (
              <CellValue field={groupField} value={def.display} locale={locale} compact />
            )}
          </span>
          <span
            className="shrink-0 font-normal text-fg-muted tabular-nums"
            data-testid="kanban-column-count"
          >
            <span className="sr-only">{t('column.countLabel')}</span>
            {countText}
          </span>
        </h2>
        {canAdd ? (
          <Tooltip content={t('column.add', { name })}>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('column.add', { name })}
              onClick={() => {
                onAdd(def);
              }}
            >
              <Plus aria-hidden="true" />
            </Button>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <Tooltip content={t('column.menu', { name })}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('column.menu', { name })}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="max-w-72">
            <DropdownMenuItem
              disabled={!canAdd}
              onSelect={() => {
                onAdd(def);
              }}
            >
              <Plus aria-hidden="true" />
              {t('column.addCard')}
            </DropdownMenuItem>
            {onHideEmpty === undefined ? null : (
              <DropdownMenuCheckboxItem
                checked={hideEmpty}
                onCheckedChange={(checked) => {
                  onHideEmpty(checked);
                }}
              >
                {t('settings.hideEmpty')}
              </DropdownMenuCheckboxItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {showSkeleton ? (
          <div className="flex flex-col gap-2">
            <span className="sr-only">{t('column.loading')}</span>
            {Array.from({ length: SKELETON_CARDS }, (_, index) => (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
                style={{ height: cardHeight }}
              >
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-label font-normal text-fg-muted">
            {column.error === null ? t('column.noCards') : t('column.error')}
          </p>
        ) : (
          <ul
            aria-labelledby={headerId}
            className="relative"
            style={{ height: Math.max(0, topOf(cards.length) - CARD_GAP) }}
          >
            {rows.map((index) => {
              const record = cards[index];
              if (record === undefined) return null;
              return (
                <li
                  key={record.id}
                  ref={measured.observe}
                  data-measure-id={record.id}
                  aria-setsize={count ?? cards.length}
                  aria-posinset={index + 1}
                  className="absolute inset-x-0"
                  style={{ top: topOf(index) }}
                >
                  <KanbanCard
                    record={record}
                    primary={primary}
                    cardFields={cardFields}
                    cover={cover}
                    locale={locale}
                    column={def}
                    columns={columns}
                    columnName={columnName}
                    draggable={canMove}
                    moveBlocked={moveBlocked}
                    moving={isMoving(record.id)}
                    onOpen={onOpen}
                    onMove={moveFromMenu}
                    onStep={step}
                    followItem={followItem}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {loadingMore ? (
          <div className="flex justify-center py-2" aria-hidden="true">
            <Spinner />
          </div>
        ) : null}
      </div>
    </section>
  );
}
