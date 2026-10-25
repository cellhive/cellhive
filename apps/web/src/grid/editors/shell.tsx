import { cn } from '@cellhive/ui';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { translateDetail } from '../../lib/errors/translate';

import { MOVE_DOWN, MOVE_LEFT, MOVE_RIGHT, type EditorIssue, type EditorMove } from './types';

import type { KeyboardEvent, ReactNode } from 'react';

export interface EditorKeyHandlers {
  /** Enter (move down) or Tab / Shift+Tab (move right / left). */
  readonly commit: (move: EditorMove) => void;
  readonly cancel: () => void;
  /** Enter adds a line instead (Shift+Enter in multi-line text). */
  readonly newlineOnShiftEnter?: boolean;
}

/**
 * Keyboard of every overlay editor (FRONTEND §6.2): Enter commits and moves
 * down, Tab / Shift+Tab commit and move right / left, Escape cancels. The
 * editor handles these keys itself (and stops them), so an invalid value
 * keeps the editor open with its error instead of closing it.
 */
export function handleEditorKey(event: KeyboardEvent, handlers: EditorKeyHandlers): boolean {
  if (event.nativeEvent.isComposing) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    handlers.cancel();
    return true;
  }
  if (event.key === 'Enter') {
    if (handlers.newlineOnShiftEnter === true && (event.shiftKey || event.altKey)) {
      // Leave the new line to the text area; glide must not see the key either.
      event.stopPropagation();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    handlers.commit(MOVE_DOWN);
    return true;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    event.stopPropagation();
    handlers.commit(event.shiftKey ? MOVE_LEFT : MOVE_RIGHT);
    return true;
  }
  return false;
}

/** The translated reason a value cannot be written (`errors:detail.<code>`). */
export function useIssueMessage(issue: EditorIssue | null): string | null {
  const { i18n } = useTranslation('grid');
  if (issue === null) return null;
  return translateDetail(i18n, {
    code: issue.code,
    ...(issue.params === undefined ? {} : { params: issue.params }),
    ...(issue.message === undefined ? {} : { message: issue.message }),
  });
}

export interface EditorFrameProps {
  readonly cellWidth: number;
  /** Height of the edited cell: the input stays over it when the popover opens upwards. */
  readonly cellHeight: number;
  /** Error under the input (FRONTEND §4.1 step 1): the editor stays open. */
  readonly error: string | null;
  readonly errorId: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Space kept between an editor popover and the edge of the window, px. */
export const VIEWPORT_MARGIN = 8;

export interface EditorPlacement {
  /** The list / calendar opens above the cell (the input stays over the cell). */
  readonly above: boolean;
  /** Height the popover may take; `undefined` when it fits. */
  readonly maxHeight: number | undefined;
}

/**
 * Where an editor popover goes (S2 QA: near the bottom of the window the
 * calendar and lists overflowed and the input was squeezed): below the
 * cell when it fits, else on the side with more room, shrunk to it.
 * `cellTop` is the top of the edited cell in the window.
 */
export function placeEditor(
  cellTop: number,
  cellHeight: number,
  height: number,
  viewportHeight: number,
): EditorPlacement {
  const below = viewportHeight - cellTop - VIEWPORT_MARGIN;
  if (height <= below) return { above: false, maxHeight: undefined };
  const above = cellTop + cellHeight - VIEWPORT_MARGIN;
  if (height <= above) return { above: true, maxHeight: undefined };
  return above > below
    ? { above: true, maxHeight: Math.max(cellHeight, above) }
    : { above: false, maxHeight: Math.max(cellHeight, below) };
}

interface FramePlacement extends EditorPlacement {
  /** Upward shift that keeps the input (last, `flex-col-reverse`) over the cell. */
  readonly shift: number;
}

const FITS: FramePlacement = { above: false, maxHeight: undefined, shift: 0 };

/** Height of an element's content, even when a flex parent shrank it (scrolling lists). */
function naturalHeight(element: Element): number {
  if (!(element instanceof HTMLElement)) return 0;
  // Out of the flow (screen-reader text): takes no room, however long its text.
  const style = getComputedStyle(element);
  if (style.position === 'absolute' || style.position === 'fixed') return 0;
  const borders = element.offsetHeight - element.clientHeight;
  // A list scrolls past its own `max-height` anyway.
  const cap = Number.parseFloat(style.maxHeight);
  const natural = Math.max(element.offsetHeight, element.scrollHeight + borders);
  return Number.isFinite(cap) ? Math.min(natural, cap) : natural;
}

/** Keeps a popover anchored on a cell inside the window, as its content changes. */
function useEditorPlacement(cellHeight: number) {
  const frame = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FramePlacement>(FITS);
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    // Glide positions its overlay container at the cell (it only moves it sideways).
    const anchor = element.parentElement?.parentElement ?? element;
    const update = () => {
      const borders = element.offsetHeight - element.clientHeight;
      const natural =
        Array.from(element.children).reduce((sum, child) => sum + naturalHeight(child), 0) +
        borders;
      const next = placeEditor(
        anchor.getBoundingClientRect().top,
        cellHeight,
        natural,
        window.innerHeight,
      );
      const rendered = next.maxHeight === undefined ? natural : Math.min(natural, next.maxHeight);
      const shift = next.above ? cellHeight - rendered : 0;
      setPlacement((current) =>
        current.above === next.above &&
        current.maxHeight === next.maxHeight &&
        current.shift === shift
          ? current
          : { ...next, shift },
      );
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [cellHeight]);
  return { frame, placement };
}

/**
 * Popover of an overlay editor: it covers the cell (the input keeps the
 * accent inset border of the editing cell) and grows below it for lists,
 * pickers and the error line — or above it when the window has no room
 * below (the input then stays over the cell, at the bottom of the popover).
 */
export function EditorFrame({
  cellWidth,
  cellHeight,
  error,
  errorId,
  className,
  children,
}: EditorFrameProps) {
  const { frame, placement } = useEditorPlacement(cellHeight);
  return (
    <div
      ref={frame}
      data-placement={placement.above ? 'above' : 'below'}
      className={cn(
        'flex overflow-hidden rounded-md border border-line bg-surface text-body text-fg shadow-popover',
        placement.above ? 'flex-col-reverse' : 'flex-col',
        className,
      )}
      style={{
        minWidth: cellWidth,
        ...(placement.maxHeight === undefined ? {} : { maxHeight: placement.maxHeight }),
        ...(placement.shift === 0 ? {} : { transform: `translateY(${String(placement.shift)}px)` }),
      }}
    >
      {children}
      {error === null ? null : (
        <p
          id={errorId}
          role="alert"
          className={cn(
            'shrink-0 border-line bg-surface px-2 py-1 text-label font-normal text-danger',
            placement.above ? 'border-b' : 'border-t',
          )}
        >
          {error}
        </p>
      )}
    </div>
  );
}

/** Class of the input that covers the cell: accent inset border, cell padding. */
export const CELL_INPUT_CLASS =
  'w-full min-w-0 shrink-0 bg-surface px-2 text-body text-fg outline-none ring-2 ring-accent ring-inset rounded-md placeholder:text-fg-subtle';
