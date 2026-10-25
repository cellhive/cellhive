import { Button, Tooltip } from '@cellhive/ui';
import { Maximize2, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { CandidateList, handleListKey } from './CandidateList';
import { CreateButton, FilterNote, KeyHints } from './parts';

import type { LinkPickerProps } from '../../../lib/links/picker';
import type { AnchorRect } from '../../../lib/records/detail';
import type { PickerState } from '../use-picker';

/** Width of the popover (board: 340 px) and its gap to the cell. */
const WIDTH = 340;
const GAP = 4;
const MARGIN = 8;
/** Height the list may take before it scrolls. */
const LIST_MAX = 264;

/** Where the popover goes: under the cell, or above it when the window has no room below. */
export function placePopover(
  anchor: AnchorRect,
  height: number,
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const left = Math.max(MARGIN, Math.min(anchor.x, viewport.width - WIDTH - MARGIN));
  const below = anchor.y + anchor.height + GAP;
  if (below + height <= viewport.height - MARGIN) return { left, top: below };
  const above = anchor.y - GAP - height;
  if (above >= MARGIN) return { left, top: above };
  return { left, top: Math.max(MARGIN, viewport.height - MARGIN - height) };
}

export interface LinkPickerPopoverProps {
  readonly props: LinkPickerProps;
  readonly state: PickerState;
  readonly anchor: AnchorRect;
  /** "Expand": the same choice in the dialog (decision #1). */
  readonly onExpand: () => void;
}

/**
 * The single-link popover (board "Ô liên kết trong grid", BACKLOG S4
 * decision #1): under the cell, a search box (combobox: the focus stays in
 * it, ↑/↓ move, Enter chooses and closes, Escape cancels), the records with
 * a check on the chosen one, "+ Create …", and "Expand" to the dialog. A
 * click outside cancels.
 */
export function LinkPickerPopover({ props, state, anchor, onExpand }: LinkPickerPopoverProps) {
  const { t } = state;
  const box = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>(() =>
    placePopover(anchor, 360, { width: window.innerWidth, height: window.innerHeight }),
  );
  const { onClose } = props;

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const update = () => {
      const next = placePopover(anchor, element.offsetHeight, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      setPlace((current) =>
        current.left === next.left && current.top === next.top ? current : next,
      );
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
    };
  }, [anchor]);

  // The search box takes the focus — and keeps it when the grid takes it back a
  // frame after the click that opened the popover (FRONTEND §1.3, T322a).
  useEffect(() => {
    const input = searchBox.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now === null || now === document.body || now.closest('.ob-grid') !== null) {
          input.focus({ preventScroll: true });
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  // A press outside cancels (the cell keeps its value).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target) === true) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    };
  }, [onClose]);

  const createLabel =
    state.search.trim() === ''
      ? t('picker.createNew', { table: state.tableName })
      : t('picker.createNamed', { table: state.tableName, name: state.search.trim() });

  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-label={t('picker.popoverLabel', { table: state.tableName })}
      data-testid="link-picker-popover"
      className="fixed z-40 flex animate-pop-in flex-col rounded-lg border border-line bg-surface text-body text-fg shadow-popover"
      style={{ left: place.left, top: place.top, width: WIDTH, maxWidth: 'calc(100vw - 1rem)' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1.5">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-accent bg-surface px-2.5 ring-2 ring-accent-soft max-lg:h-control">
          <Search aria-hidden="true" className="size-[15px] shrink-0 text-fg-muted" />
          <span className="sr-only">{t('picker.search', { table: state.tableName })}</span>
          <input
            ref={searchBox}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={state.listId}
            aria-autocomplete="list"
            aria-activedescendant={state.activeOption?.id}
            autoComplete="off"
            spellCheck={false}
            data-testid="link-search"
            placeholder={t('picker.searchPlaceholder', {
              field: state.primary?.name ?? state.tableName,
            })}
            className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
            value={state.search}
            onChange={(event) => {
              state.setSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              handleListKey(event, state, { space: false });
            }}
          />
        </label>
        <Tooltip content={t('picker.expand')}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 max-lg:size-control"
            aria-label={t('picker.expand')}
            data-testid="link-expand"
            onClick={onExpand}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {state.hasFilter ? (
        <FilterNote className="px-3 pb-1.5">
          {t('picker.filterNoteShort', { table: state.tableName })}
        </FilterNote>
      ) : null}
      <div className="flex min-h-0 flex-col" style={{ maxHeight: LIST_MAX }}>
        <CandidateList
          state={state}
          size="popover"
          label={state.tableName}
          focusable={false}
          className="px-1.5 pt-0 pb-1.5"
          emptyAction={
            state.canCreate ? (
              <Button variant="secondary" size="sm" onClick={state.create}>
                {createLabel}
              </Button>
            ) : undefined
          }
        />
      </div>
      {state.createError === null ? null : (
        <p role="alert" className="px-4 pb-2 text-label font-normal text-danger">
          {state.createError}
        </p>
      )}
      {state.canCreate && state.options.length > 0 ? (
        <CreateButton className="border-t border-line" label={createLabel} onClick={state.create} />
      ) : null}
      <KeyHints
        className="min-h-8 items-center border-t border-line px-4 py-1.5 max-lg:hidden"
        hints={[t('picker.keyMove'), t('picker.keyChoose'), t('picker.keyCancel')]}
      />
      <p className="sr-only" aria-live="polite">
        {state.announcement}
      </p>
    </div>
  );
}
