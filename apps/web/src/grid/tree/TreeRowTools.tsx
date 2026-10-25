import { cn, Tooltip } from '@cellhive/ui';
import { CornerDownRight, GripVertical } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { HEADER_HEIGHT } from '../theme';

import { placementAt, treeInset, TREE_LEFT } from './draw';

import type { DropPlacement, GridTree, MoveProblem } from './types';
import type { Rectangle } from '@glideapps/glide-data-grid';

/** Most levels (SPEC §5.7): a record at depth 9 takes no sub-record. */
const MAX_DEPTH = 9;
/** The grid scrolls while the pointer is this close to its top or bottom edge, px. */
const EDGE = 28;

/** The hovered row, in screen coordinates of its first cell. */
export interface TreeHover {
  readonly recordId: string;
  readonly row: number;
  /** Box of the first cell. */
  readonly cell: Rectangle;
}

interface DragState {
  readonly row: number;
  readonly recordId: string;
  /** The handle stays where the drag started (the grid may scroll meanwhile). */
  readonly handle: Rectangle;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly target: {
    readonly row: number;
    readonly placement: DropPlacement;
    readonly problem: MoveProblem | null;
    readonly box: Rectangle;
    readonly depth: number;
  } | null;
}

export interface TreeRowToolsProps {
  readonly tree: GridTree;
  readonly hover: TreeHover | null;
  /** Left of the expand button of the hovered row (the "+ Sub-record" button ends there). */
  readonly expandLeft: number | null;
  readonly gutter: number;
  readonly rowCount: number;
  readonly getBounds: (col: number, row: number) => Rectangle | undefined;
  /** First row on screen (the grid's visible region). */
  readonly firstVisibleRow: () => number;
  readonly scroller: () => HTMLElement | null;
  /** The pointer is on the tools: the hovered row must stay. */
  readonly onKeep: () => void;
  readonly onLeave: () => void;
}

/**
 * Pointer tools of a tree row (T417, board "Sub-records dạng cây"): the
 * "+ Sub-record" button next to the expand button of the hovered row, and
 * the ⋮⋮ drag handle in its gutter — drop onto a row to make the record its
 * sub-record, between two rows to make it their sibling. The indicator
 * says when a drop is refused (a record into its own branch, more than 10
 * levels). Pointer shortcuts (`tabIndex=-1`): the row menu, Ctrl/⌘+] / [
 * and Alt+Shift+→ / ← do the same from the keyboard.
 */
export function TreeRowTools({
  tree,
  hover,
  expandLeft,
  gutter,
  rowCount,
  getBounds,
  firstVisibleRow,
  scroller,
  onKeep,
  onLeave,
}: TreeRowToolsProps) {
  const { t } = useTranslation('tree');
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const moves = tree.hooks.moves;
  const onAddChild = tree.hooks.onAddChild;

  const setDragState = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  useEffect(
    () => () => {
      clearInterval(scrollTimer.current);
    },
    [],
  );

  // Escape cancels a drag.
  useEffect(() => {
    if (drag === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      clearInterval(scrollTimer.current);
      setDragState(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [drag]);

  /** The row under the pointer and where in it (rows all have the same height). */
  const targetAt = (clientY: number, state: DragState): DragState['target'] => {
    if (moves === undefined || rowCount === 0) return null;
    const top = firstVisibleRow();
    const first = getBounds(0, top);
    if (first === undefined) return null;
    const row = Math.min(
      rowCount - 1,
      Math.max(0, top + Math.floor((clientY - first.y) / first.height)),
    );
    const box = getBounds(0, row);
    if (box === undefined) return null;
    const placement = placementAt((clientY - box.y) / box.height);
    const node = tree.nodeAt(row);
    return {
      row,
      placement,
      problem: moves.checkDrop(state.row, row, placement),
      box,
      depth: node?.depth ?? 0,
    };
  };

  const autoScroll = (clientY: number) => {
    clearInterval(scrollTimer.current);
    const element = scroller();
    if (element === null) return;
    const area = element.getBoundingClientRect();
    const step =
      clientY < area.top + HEADER_HEIGHT + EDGE ? -12 : clientY > area.bottom - EDGE ? 12 : 0;
    if (step === 0) return;
    scrollTimer.current = setInterval(() => {
      element.scrollBy({ top: step });
      const current = dragRef.current;
      if (current !== null) setDragState({ ...current, target: targetAt(current.y, current) });
    }, 16);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (hover === null || event.button !== 0 || moves === undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const state: DragState = {
      row: hover.row,
      recordId: hover.recordId,
      handle: hover.cell,
      title: tree.titleOf(hover.recordId),
      x: event.clientX,
      y: event.clientY,
      target: null,
    };
    setDragState(state);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (current === null) return;
    const next = { ...current, x: event.clientX, y: event.clientY };
    setDragState({ ...next, target: targetAt(event.clientY, next) });
    autoScroll(event.clientY);
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>, drop: boolean) => {
    const current = dragRef.current;
    clearInterval(scrollTimer.current);
    if (current === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
    onLeave();
    const target = current.target;
    if (!drop || target === null || moves === undefined) return;
    // A refused drop goes to the page too: it explains why (toast), the row stays.
    moves.onDrop(current.row, target.row, target.placement);
  };

  const node = hover === null ? undefined : tree.nodeAt(hover.row);
  const canAddChild =
    onAddChild !== undefined && hover !== null && node !== undefined && node.depth < MAX_DEPTH;
  const target = drag?.target ?? null;
  const handleCell = drag?.handle ?? hover?.cell;
  const refused = target !== null && target.problem !== null && target.problem !== 'same';

  return (
    <>
      {handleCell === undefined || moves === undefined ? null : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('dragHandle')}
          data-testid="tree-drag-handle"
          className={cn(
            'fixed z-20 flex touch-none items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken hover:text-fg',
            drag === null ? 'cursor-grab' : 'cursor-grabbing',
          )}
          style={{
            left: handleCell.x - gutter + 2,
            top: handleCell.y + (handleCell.height - 24) / 2,
            width: 16,
            height: 24,
          }}
          onPointerEnter={onKeep}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => {
            finish(event, true);
          }}
          onPointerCancel={(event) => {
            finish(event, false);
          }}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      )}
      {!canAddChild || expandLeft === null || drag !== null ? null : (
        <Tooltip content={t('addChildHint')}>
          <button
            type="button"
            tabIndex={-1}
            data-testid="tree-add-child"
            className="fixed z-20 flex h-6 -translate-x-full items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-label font-normal text-fg-muted shadow-popover hover:text-fg"
            style={{ left: expandLeft - 4, top: hover.cell.y + (hover.cell.height - 24) / 2 }}
            onPointerEnter={onKeep}
            onPointerLeave={onLeave}
            onClick={() => {
              onAddChild(hover.recordId, hover.row);
            }}
          >
            <CornerDownRight aria-hidden="true" className="size-3" />
            {t('subrecord')}
          </button>
        </Tooltip>
      )}
      {drag === null ? null : (
        <>
          {target === null ? null : target.placement === 'child' ? (
            <div
              aria-hidden="true"
              data-testid="tree-drop-indicator"
              data-placement="child"
              data-refused={refused}
              className={cn(
                'pointer-events-none fixed z-30 rounded-sm border-2',
                refused ? 'border-danger' : 'border-accent bg-accent-soft/40',
              )}
              style={{
                left: target.box.x,
                top: target.box.y,
                width: Math.max(0, (scroller()?.getBoundingClientRect().right ?? 0) - target.box.x),
                height: target.box.height,
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              data-testid="tree-drop-indicator"
              data-placement={target.placement}
              data-refused={refused}
              className={cn(
                'pointer-events-none fixed z-30 h-0.5',
                refused ? 'bg-danger' : 'bg-accent',
              )}
              style={{
                left: target.box.x + TREE_LEFT + treeInset(target.depth),
                top:
                  (target.placement === 'before'
                    ? target.box.y
                    : target.box.y + target.box.height) - 1,
                width: Math.max(
                  0,
                  (scroller()?.getBoundingClientRect().right ?? 0) -
                    (target.box.x + TREE_LEFT + treeInset(target.depth)),
                ),
              }}
            />
          )}
          <div
            role="status"
            data-testid="tree-drag-label"
            className={cn(
              'pointer-events-none fixed z-40 max-w-xs truncate rounded-md border bg-surface px-2 py-1 text-label font-normal shadow-popover',
              refused ? 'border-danger text-danger' : 'border-line text-fg',
            )}
            style={{ left: drag.x + 12, top: drag.y + 12 }}
          >
            {refused
              ? t(`refused.${target.problem}`)
              : target === null
                ? drag.title
                : t(`drop.${target.placement}`, { title: drag.title })}
          </div>
        </>
      )}
    </>
  );
}
