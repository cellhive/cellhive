import {
  Button,
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import {
  formatSummary,
  type FormattedSummary,
  type SummaryTexts,
} from '../../../lib/views/summary/format';
import { alignsRight, canSummarize, summaryMenuGroups } from '../../../lib/views/summary/functions';

/** Below this column width a cell shows the value only (M6; group headers use the same width). */
const SUMMARY_LABEL_MIN_WIDTH = 120;

import type { SummaryBarProps } from '../../../lib/views/summary/types';
import type { FieldDto, RecordSummaryDto, SummaryFunction } from '@cellhive/contracts';

/**
 * The summary bar under a grid (T472, board "S4b · Thanh thống kê"): one
 * cell per column, in line with it — frozen columns stay, the others follow
 * the grid when it scrolls sideways — and the record count in the
 * row-number gutter (shortened; the full count in its tooltip and for
 * screen readers). A cell with a summary shows "Label value"; the others
 * show "Summary ▾" on hover or focus. A click opens the menu of functions
 * the column's type takes (no preview values, S4b decision 8); below 768 px
 * a bottom sheet. While new numbers load the old ones stay, dimmed.
 */

export function useSummaryTexts(): SummaryTexts {
  const { t } = useTranslation('grid');
  return useMemo(
    () => ({
      label: (fn) => t(`summary.short.${fn}`),
      days: (days) => t('summary.days', { count: days }),
    }),
    [t],
  );
}

/** WCAG 2.5.8: a target shows at least 24 × 24 px (axe `target-size`). */
const MIN_TARGET_PX = 24;

/**
 * Cells of `row` of which less than {@link MIN_TARGET_PX} shows between
 * `left` and `right` (scrolled under the frozen columns, or under a panel
 * covering the grid such as the record detail, `data-covers-grid`) are
 * `inert` until they show again: a sliver is no usable target and must not
 * sit under the controls covering it (QA S4b, T470).
 */
export function markSlivers(row: HTMLElement | null, left: number, right: number): void {
  if (row === null) return;
  for (const cell of row.children) {
    const box = cell.getBoundingClientRect();
    const partial = box.left < left - 0.5 || box.right > right + 0.5;
    const shown = Math.min(box.right, right) - Math.max(box.left, left);
    const sliver = partial && shown < MIN_TARGET_PX;
    if (cell.hasAttribute('inert') !== sliver) cell.toggleAttribute('inert', sliver);
  }
}

/** Left edge of a panel covering `box` (the record detail beside the grid), else its right edge. */
function coveredFrom(box: DOMRect): number {
  let right = box.right;
  for (const panel of document.querySelectorAll<HTMLElement>('[data-covers-grid]')) {
    const cover = panel.getBoundingClientRect();
    const overlaps =
      cover.width > 0 && cover.top < box.bottom && cover.bottom > box.top && cover.right > box.left;
    if (overlaps && cover.left < right) right = Math.max(box.left, cover.left);
  }
  return right;
}

/**
 * The grid's horizontal scroll, applied to a track without re-rendering;
 * cells showing a sliver only become inert ({@link markSlivers}) after each
 * scroll, resize and change of the page (a panel opening over the bar).
 */
function useFollowScroll(
  scroller: () => HTMLElement | null,
  track: RefObject<HTMLDivElement | null>,
  frozen: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    let element: HTMLElement | null = null;
    let frame = 0;
    let pending = 0;
    const mark = () => {
      pending = 0;
      const frozenBox = frozen.current?.getBoundingClientRect();
      if (frozenBox !== undefined) {
        markSlivers(frozen.current, frozenBox.left, coveredFrom(frozenBox));
      }
      const rest = track.current?.parentElement?.getBoundingClientRect();
      if (rest !== undefined) markSlivers(track.current, rest.left, coveredFrom(rest));
    };
    const schedule = () => {
      if (pending === 0) pending = requestAnimationFrame(mark);
    };
    const apply = () => {
      if (track.current !== null && element !== null) {
        track.current.style.transform = `translateX(${String(-element.scrollLeft)}px)`;
      }
      schedule();
    };
    const attach = () => {
      element = scroller();
      if (element === null) {
        frame = requestAnimationFrame(attach);
        return;
      }
      element.addEventListener('scroll', apply, { passive: true });
      apply();
    };
    attach();
    // Older engines (and jsdom) have no ResizeObserver: window resizes still count.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const area = track.current?.parentElement;
    if (area !== null && area !== undefined) resized?.observe(area);
    window.addEventListener('resize', schedule);
    // A panel mounting over the bar: nodes added or removed (the `inert` toggles are attributes).
    const changed = new MutationObserver(schedule);
    changed.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pending);
      element?.removeEventListener('scroll', apply);
      resized?.disconnect();
      window.removeEventListener('resize', schedule);
      changed.disconnect();
    };
  }, [scroller, track, frozen]);
}

function isTimeout(error: unknown): boolean {
  return isApiError(error) && error.code === 'QUERY_TIMEOUT';
}

export function SummaryBar({
  layout,
  fields,
  config,
  result,
  busy,
  error,
  onRetry,
  onChange,
  locale,
  count,
  narrow = false,
}: SummaryBarProps) {
  const { t } = useTranslation('grid');
  const texts = useSummaryTexts();
  const track = useRef<HTMLDivElement>(null);
  const frozenCells = useRef<HTMLDivElement>(null);
  useFollowScroll(layout.scroller, track, frozenCells);
  const [sheet, setSheet] = useState<string | null>(null);
  const failed = error !== null && error !== undefined;
  const failure = isTimeout(error) ? t('summary.timeout') : t('summary.failed');

  const formatted = (fieldId: string): FormattedSummary | null => {
    const fn = config[fieldId];
    const field = fields.get(fieldId);
    if (fn === undefined || field === undefined) return null;
    const summary: RecordSummaryDto | undefined = result?.summaries[fieldId];
    // The last numbers stay while a new request runs; a changed function waits for its own.
    if (summary?.fn !== fn || failed) return { label: texts.label(fn), value: null };
    return formatSummary(field, summary, locale, texts);
  };

  const cell = (fieldId: string, width: number) => {
    const field = fields.get(fieldId);
    if (field === undefined) return <span key={fieldId} style={{ width }} className="shrink-0" />;
    const shown = formatted(fieldId);
    const right = alignsRight(field);
    const summarizable = canSummarize(field);
    const name = t('summary.column', { field: field.name });
    const busyCell = busy && shown !== null;
    const content =
      shown === null ? (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-transparent',
            onChange !== undefined && 'group-hover:text-fg-muted group-focus-visible:text-fg-muted',
            narrow && onChange !== undefined && 'text-fg-subtle',
          )}
        >
          {t('summary.placeholder')}
          <ChevronDown aria-hidden="true" className="size-3" />
        </span>
      ) : (
        <>
          {busyCell ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-0.5 bg-linear-to-r from-transparent via-accent to-transparent opacity-70"
            />
          ) : null}
          {/* M6: the value first — the label shrinks, and goes below ~120 px. */}
          {width < SUMMARY_LABEL_MIN_WIDTH ? null : (
            <span className="min-w-0 truncate text-fg-muted">{shown.label}</span>
          )}
          <span
            className={cn(
              'max-w-full min-w-0 shrink-0 truncate font-semibold tabular-nums',
              // A formula/lookup being recomputed (T468): its number may still move, dimmed.
              busyCell ||
                field.compute_state === 'backfilling' ||
                field.compute_state === 'recomputing'
                ? 'text-fg-muted'
                : 'text-fg',
            )}
          >
            {shown.value ?? '—'}
          </span>
        </>
      );
    const label =
      shown === null ? name : `${name}: ${shown.label} ${shown.value ?? t('summary.unavailable')}`;
    const className = cn(
      'group relative flex h-full shrink-0 items-center gap-1.5 overflow-hidden border-r border-line px-2.5 text-label font-normal whitespace-nowrap',
      right ? 'justify-end' : 'justify-start',
    );
    if (onChange === undefined || !summarizable) {
      const cellNode = (
        <span key={fieldId} style={{ width }} className={className}>
          {shown === null ? null : content}
        </span>
      );
      // Read-only (share): the full summary on hover too, focusable for the keyboard.
      const full = shown?.value == null ? null : `${shown.label} ${shown.value}`;
      return full === null ? (
        cellNode
      ) : (
        <Tooltip key={fieldId} content={full}>
          {/* Like the count in the gutter: a button that only carries the tooltip. */}
          <button
            type="button"
            aria-label={label}
            style={{ width }}
            className={cn(className, 'cursor-default focus-visible:bg-surface-sunken')}
          >
            {content}
          </button>
        </Tooltip>
      );
    }
    const trigger = (
      <button
        type="button"
        aria-label={label}
        aria-busy={busyCell || undefined}
        aria-haspopup={narrow ? 'dialog' : 'menu'}
        data-testid={`summary-cell-${fieldId}`}
        style={{ width }}
        className={cn(
          className,
          'cursor-pointer hover:bg-surface-sunken focus-visible:bg-surface-sunken data-[state=open]:bg-accent-soft',
        )}
        {...(narrow
          ? {
              onClick: () => {
                setSheet(fieldId);
              },
            }
          : {})}
      >
        {content}
      </button>
    );
    // A failed request: "—" with why on hover/focus; the menu (or sheet) offers Retry.
    // Otherwise the full summary (M6: narrow columns shorten or drop the label).
    const hint =
      shown === null
        ? null
        : failed
          ? failure
          : shown.value === null
            ? null
            : `${shown.label} ${shown.value}`;
    const tip = (node: ReactElement) =>
      hint === null ? node : <Tooltip content={hint}>{node}</Tooltip>;
    if (narrow) return <span key={fieldId}>{tip(trigger)}</span>;
    return (
      <DropdownMenu key={fieldId}>
        {tip(<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>)}
        <DropdownMenuContent align={right ? 'end' : 'start'} side="top" className="w-60">
          {!failed || shown === null ? null : (
            <>
              <DropdownMenuItem onSelect={onRetry}>{t('error.retry')}</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <SummaryMenuItems
            field={field}
            value={config[fieldId] ?? null}
            onChange={(fn) => {
              onChange(fieldId, fn);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const frozen = layout.columns.slice(0, layout.frozen);
  const rest = layout.columns.slice(layout.frozen);
  const sheetField = sheet === null ? undefined : fields.get(sheet);
  const sheetShown = sheet === null ? null : formatted(sheet);

  return (
    <footer
      aria-label={t('summary.bar')}
      className={cn(
        'relative flex shrink-0 border-t border-line bg-surface',
        narrow ? 'h-11 overflow-x-auto' : 'h-9 overflow-hidden',
      )}
      data-testid="summary-bar"
    >
      <div
        ref={frozenCells}
        className={cn(
          'z-1 flex shrink-0 bg-surface',
          narrow && 'sticky left-0',
          frozen.length > 0 &&
            'border-r border-line-strong shadow-[4px_0_6px_-4px_rgba(22,25,29,0.22)]',
        )}
      >
        <Tooltip content={count.full}>
          <button
            type="button"
            aria-label={count.full}
            data-testid="summary-count"
            style={{ width: Math.max(layout.gutter, 40) }}
            className="flex h-full shrink-0 cursor-default items-center justify-center border-r border-line text-label font-semibold text-fg-muted tabular-nums"
          >
            <span aria-hidden="true">{count.short}</span>
          </button>
        </Tooltip>
        {count.status}
        {frozen.map((column) => cell(column.fieldId, column.width))}
      </div>
      {narrow ? (
        <div className="flex">{rest.map((column) => cell(column.fieldId, column.width))}</div>
      ) : (
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div ref={track} className="flex h-full will-change-transform">
            {rest.map((column) => cell(column.fieldId, column.width))}
          </div>
        </div>
      )}
      {narrow && onChange !== undefined && sheetField !== undefined ? (
        <Dialog
          open
          layout="sheet"
          onOpenChange={(open) => {
            if (!open) setSheet(null);
          }}
          title={t('summary.column', { field: sheetField.name })}
          description={
            sheetShown === null
              ? undefined
              : t('summary.current', { summary: `${sheetShown.label} ${sheetShown.value ?? '—'}` })
          }
          closeLabel={t('summary.close')}
        >
          <SummarySheetOptions
            field={sheetField}
            value={config[sheetField.id] ?? null}
            onChange={(fn) => {
              onChange(sheetField.id, fn);
              setSheet(null);
            }}
          />
          {failed ? (
            <div className="mt-3 flex items-center gap-2 text-label font-normal text-fg-muted">
              <span>{failure}</span>
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {t('error.retry')}
              </Button>
            </div>
          ) : null}
          <p className="mt-3 text-label font-normal text-fg-muted">{t('summary.sheetHint')}</p>
        </Dialog>
      ) : null}
    </footer>
  );
}

interface MenuProps {
  readonly field: FieldDto;
  readonly value: SummaryFunction | null;
  readonly onChange: (fn: SummaryFunction | null) => void;
}

const NONE = 'none';

/** The menu of a column (desktop): None, then the groups of its type. */
function SummaryMenuItems({ field, value, onChange }: MenuProps) {
  const { t } = useTranslation('grid');
  const groups = summaryMenuGroups(field);
  return (
    <>
      <DropdownMenuLabel className="font-semibold text-fg">
        {t('summary.column', { field: field.name })}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value ?? NONE}
        onValueChange={(next) => {
          onChange(next === NONE ? null : (next as SummaryFunction));
        }}
      >
        <DropdownMenuRadioItem value={NONE}>{t('summary.none')}</DropdownMenuRadioItem>
        {groups.map((group) => (
          <div key={group.key} role="group" aria-label={t(`summary.groups.${group.key}`)}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t(`summary.groups.${group.key}`)}</DropdownMenuLabel>
            {group.functions.map((fn) => (
              <DropdownMenuRadioItem key={fn} value={fn}>
                {t(`summary.menu.${fn}`)}
              </DropdownMenuRadioItem>
            ))}
          </div>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** The same choices in the bottom sheet (< 768 px): 44 px rows. */
function SummarySheetOptions({ field, value, onChange }: MenuProps) {
  const { t } = useTranslation('grid');
  const groups = summaryMenuGroups(field);
  const option = (fn: SummaryFunction | null, text: string) => {
    const checked = value === fn;
    return (
      <button
        key={fn ?? NONE}
        type="button"
        role="radio"
        aria-checked={checked}
        className={cn(
          'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-body',
          checked ? 'bg-accent-soft font-medium text-fg' : 'hover:bg-surface-sunken',
        )}
        onClick={() => {
          onChange(fn);
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-accent">
          {checked ? <Check aria-hidden="true" className="size-4" /> : null}
        </span>
        {text}
      </button>
    );
  };
  return (
    <div role="radiogroup" aria-label={t('summary.column', { field: field.name })}>
      {option(null, t('summary.none'))}
      {groups.map((group) => (
        <div key={group.key} role="group" aria-label={t(`summary.groups.${group.key}`)}>
          <p className="mt-2 border-t border-line px-2 pt-2 pb-1 text-label font-normal text-fg-muted">
            {t(`summary.groups.${group.key}`)}
          </p>
          {group.functions.map((fn) => option(fn, t(`summary.menu.${fn}`)))}
        </div>
      ))}
    </div>
  );
}
