/*! Lucian UX/UI Prompt #178 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#178 */
import '../../../styles/lucian.css';
import './SelectionDock.css';

import { Button, Tooltip } from '@cellhive/ui';
import { Trash2, Undo2, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { DeleteCommand } from '../../../lib/records/commands';

/**
 * Lucian UX/UI #178 "Bulk selection dock" (element d65e7c7e70, catalog
 * 34c4b3e61d) under the rows of the grid (FRONTEND §6.10, §7, §9.3 "Lucian
 * UX/UI", BACKLOG S9 decision #7): while whole rows are selected it says
 * how many ("N records selected", a polite live region) and offers what the
 * user may do with them — "Delete" only with the `delete` operation, and
 * "Clear selection" (Escape too). Copying keeps its shortcut (Ctrl/⌘+C on
 * the grid). Deleting moves the records to the trash at once, without a
 * confirmation: the same dock then says so with "Undo" for 8 s (the delete
 * command of the table's undo stack, a `restore`). A tree asks about the
 * sub-records first (its own dialog, `onDelete` resolves `null`). The
 * pattern's script — show the dock while something is selected, count, act,
 * offer the undo right after — runs here as React state.
 */

/** Announced for the close button (FRONTEND §6.2). */
const ESCAPE_KEYS = 'Escape';

/** How long "Undo" stays offered after a deletion (BACKLOG S9 decision #7). */
export const UNDO_OFFER_MS = 8_000;

export type UndoOutcome = 'done' | 'gone' | 'failed';

export interface SelectionDockHandle {
  /** Moves the focus to the dock's first action (Tab from the selected rows); `false` when hidden. */
  readonly focus: () => boolean;
}

export interface SelectionDockProps {
  /** How many whole rows are selected (the gutter's check boxes, Shift+Space). */
  readonly selected: number;
  /**
   * Moves the records of the selected rows to the trash; resolves with the
   * deletion to offer "Undo" for, or `null` (failed or refused — the reason
   * was shown — or asked in a dialog of its own). `undefined`: no "Delete"
   * (FRONTEND §7).
   */
  readonly onDelete?: (() => Promise<DeleteCommand | null>) | undefined;
  /** Drops the selected rows ("Clear selection", Escape). */
  readonly onClear: () => void;
  /** Undoes the deletion (restores the records). */
  readonly onUndo: (command: DeleteCommand) => Promise<UndoOutcome>;
  /** Whether that deletion can still be undone (Ctrl/⌘+Z may have done it already). */
  readonly canUndo: (command: DeleteCommand) => boolean;
  /** Gives the keyboard back to the grid when the dock goes away under the focus. */
  readonly onLeave: () => void;
  readonly ref?: Ref<SelectionDockHandle> | undefined;
}

type Shown =
  | { readonly kind: 'selection'; readonly count: number }
  | { readonly kind: 'deleted'; readonly count: number };

export function SelectionDock({
  selected,
  onDelete,
  onClear,
  onUndo,
  canUndo,
  onLeave,
  ref,
}: SelectionDockProps) {
  const { t } = useTranslation(['grid', 'common']);
  const statusId = useId();
  const dock = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<'delete' | 'undo' | null>(null);
  /** The count while the deletion runs (the rows go before it answers). */
  const [deleting, setDeleting] = useState(0);
  const [offer, setOffer] = useState<DeleteCommand | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const target = dock.current?.querySelector<HTMLButtonElement>('button:enabled');
        if (dock.current?.hidden !== false || target === null || target === undefined) return false;
        target.focus();
        return true;
      },
    }),
    [],
  );

  const offered = offer !== null && canUndo(offer) ? offer : null;
  const current: Shown | null =
    busy === 'delete'
      ? { kind: 'selection', count: deleting }
      : selected > 0
        ? { kind: 'selection', count: selected }
        : offered === null
          ? null
          : { kind: 'deleted', count: offered.recordIds.length };
  // While the dock fades out it keeps what it last said (not "0 selected").
  const [last, setLast] = useState<Shown | null>(current);
  if (current !== null && (last?.kind !== current.kind || last.count !== current.count)) {
    setLast(current);
  }
  const shown = current ?? last;

  // Rows selected again: the dock is about them now (the deletion stays on Ctrl/⌘+Z).
  if (selected > 0 && busy === null && offer !== null) setOffer(null);

  // "Undo" for 8 s, paused while the pointer or the focus is on the dock (WCAG 2.2.1).
  const remaining = useRef<{ offer: DeleteCommand | null; ms: number }>({
    offer: null,
    ms: UNDO_OFFER_MS,
  });
  const paused = hovered || focused || busy !== null;
  useEffect(() => {
    if (offered === null || paused) return undefined;
    if (remaining.current.offer !== offered)
      remaining.current = { offer: offered, ms: UNDO_OFFER_MS };
    const started = performance.now();
    const timer = window.setTimeout(() => {
      setOffer(null);
    }, remaining.current.ms);
    return () => {
      window.clearTimeout(timer);
      if (remaining.current.offer === offered) {
        remaining.current.ms = Math.max(0, remaining.current.ms - (performance.now() - started));
      }
    };
  }, [offered, paused]);

  // The focus was on "Delete" (gone now): it moves to "Undo", the action in its place.
  const focusUndo = useRef(false);
  useLayoutEffect(() => {
    if (!focusUndo.current || current?.kind !== 'deleted') return;
    focusUndo.current = false;
    undoButton.current?.focus();
  });

  // The dock goes away under the focus: the grid takes the keyboard back.
  const open = current !== null;
  useLayoutEffect(() => {
    if (!open && dock.current?.contains(document.activeElement) === true) onLeave();
  }, [open, onLeave]);

  const remove = async () => {
    if (onDelete === undefined || busy !== null || selected === 0) return;
    const hadFocus = dock.current?.contains(document.activeElement) === true;
    setDeleting(selected);
    setBusy('delete');
    let command: DeleteCommand | null;
    try {
      command = await onDelete();
    } finally {
      setBusy(null);
    }
    if (command !== null && command.recordIds.length > 0) {
      focusUndo.current = hadFocus;
      setOffer(command);
    }
  };

  const undo = async () => {
    if (offered === null || busy !== null) return;
    setBusy('undo');
    let outcome: UndoOutcome;
    try {
      outcome = await onUndo(offered);
    } finally {
      setBusy(null);
    }
    // Failed for now (offline): the offer stays to try again.
    if (outcome !== 'failed') setOffer(null);
  };

  const dismiss = () => {
    if (selected > 0) onClear();
    else setOffer(null);
  };

  // Escape anywhere in the dock — also when it just closed the tooltip of "×".
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    onLeave();
  };

  const onBlur = (event: FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  const count = shown?.count ?? 0;
  return (
    <div className="ux u178" data-state={current?.kind ?? 'idle'}>
      <div
        ref={dock}
        className="dock"
        role="region"
        aria-labelledby={statusId}
        hidden={!open}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={onBlur}
        onPointerEnter={() => {
          setHovered(true);
        }}
        onPointerLeave={() => {
          setHovered(false);
        }}
      >
        <span id={statusId} className="count" role="status" aria-live="polite">
          {shown === null
            ? null
            : shown.kind === 'selection'
              ? t('grid:dock.selected', { count })
              : t('grid:edit.deleted', { count })}
        </span>
        {shown?.kind === 'deleted' ? (
          <Button
            key="undo"
            ref={undoButton}
            variant="secondary"
            className="act"
            disabled={busy !== null}
            onClick={() => {
              void undo();
            }}
          >
            <Undo2 aria-hidden="true" />
            {t('grid:undo.undo')}
          </Button>
        ) : onDelete === undefined ? null : (
          <Button
            key="delete"
            variant="secondary"
            className="act text-danger"
            aria-label={t('grid:actions.deleteCount', { count })}
            disabled={busy !== null}
            onClick={() => {
              void remove();
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('grid:actions.delete')}
          </Button>
        )}
        <Tooltip
          content={
            shown?.kind === 'deleted' ? t('common:actions.close') : t('grid:dock.clearSelection')
          }
          shortcut={t('grid:shortcuts.keys.esc')}
        >
          <Button
            variant="ghost"
            size="icon"
            className="close"
            aria-label={
              shown?.kind === 'deleted' ? t('common:actions.close') : t('grid:dock.clearSelection')
            }
            aria-keyshortcuts={ESCAPE_KEYS}
            disabled={busy === 'delete'}
            onClick={() => {
              dismiss();
              onLeave();
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
