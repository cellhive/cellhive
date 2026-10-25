import { MAX_RECORDS_PER_REQUEST, type SubrecordDeleteMode, RecordDto } from '@cellhive/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { cellClipboardText } from '../../../grid';
import { recordTreeApi } from '../../../lib/api/record-tree';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { checkDrop, indentTarget, outdentTarget, type MoveCheck, type MoveSource } from './moves';
import { TREE_MAX_LEVELS, type TreeNode } from './tree-rows';

import type { TreeRowsState } from './use-tree-rows';
import type {
  GridField,
  GridTree,
  GridViewHandle,
  GridViewport,
  HeaderMenuAnchor,
  CellAddress,
} from '../../../grid';
import type { DropPlacement, MoveProblem } from '../../../grid/tree/types';
import type { CommandSink } from '../../../lib/records/commands';
import type { RecordEditController } from '../../../lib/records/edit-controller';
import type { LocaleContext } from '@cellhive/field-types';

/** How long a record created or moved is looked for to select it (its rows load meanwhile). */
const FOCUS_MS = 5_000;

/** The rows of the tree in data rows (grid, clipboard, record panel neighbours). */
export interface TreeDataRows {
  readonly getRecord: (row: number) => RecordDto | undefined;
  readonly rowOf: (recordId: string) => number | undefined;
  readonly loadRows: (firstRow: number, lastRow: number) => Promise<(RecordDto | undefined)[]>;
  readonly findRecord: (recordId: string) => RecordDto | undefined;
}

/** A delete waiting for its confirmation (the dialog asks about sub-records). */
export interface TreeDeleteRequest {
  readonly ids: readonly string[];
  /** Sub-records of the records to delete in the visible tree (0: nothing to ask). */
  readonly children: number;
}

export interface TreeRowMenuState {
  readonly cell: CellAddress;
  readonly row: number;
  readonly anchor: HeaderMenuAnchor;
}

export interface GridTreeOptions {
  readonly state: TreeRowsState;
  readonly tableId: string;
  /** Every field of the table (the primary field titles the sticky path). */
  readonly fields: readonly GridField[];
  readonly parentFieldId: string | null;
  readonly locale: LocaleContext;
  readonly controller: RecordEditController;
  readonly undo: CommandSink;
  readonly gridHandle: RefObject<GridViewHandle | null>;
  readonly canAdd: boolean;
  readonly canDelete: boolean;
  /** The user may write the parent field (drag, indent, outdent, change parent). */
  readonly canMove: boolean;
  /** Records left (the record panel closes when its record did). */
  readonly onRecordsGone: (recordIds: readonly string[]) => void;
}

export interface GridTreeState {
  readonly active: boolean;
  /** What `GridView` takes (`undefined` when the view is flat). */
  readonly grid: GridTree | undefined;
  readonly data: TreeDataRows;
  readonly setViewport: (viewport: GridViewport) => void;
  readonly nodeAt: (row: number) => TreeNode | undefined;
  readonly titleOf: (recordId: string) => string;
  /** "+ Record": a new root, selected once its row loads. */
  readonly addRoot: (column?: number) => void;
  readonly addChild: (recordId: string) => void;
  /** Shift+Enter, "Add a sibling": a record under the same parent as the row. */
  readonly addSibling: (row: number, column?: number) => void;
  readonly indent: (row: number) => void;
  readonly outdent: (row: number) => void;
  /** New parent from the picker ("Change parent…"). */
  readonly setParent: (recordId: string, parentId: string | null) => Promise<void>;
  /** Asks (sub-records?) then deletes; resolves with the number deleted, 0 when cancelled. */
  readonly requestDelete: (recordIds: readonly string[]) => Promise<number>;
  /** Deletes at once with the given fate of the sub-records. */
  readonly deleteRecords: (
    recordIds: readonly string[],
    children: SubrecordDeleteMode,
  ) => Promise<number>;
  readonly pendingDelete: TreeDeleteRequest | null;
  readonly resolveDelete: (children: SubrecordDeleteMode | null) => void;
  readonly rowMenu: TreeRowMenuState | null;
  readonly closeRowMenu: () => void;
  /** "Change parent…" of the row menu: the record whose parent the picker changes. */
  readonly pickParentFor: string | null;
  readonly setPickParentFor: (recordId: string | null) => void;
  readonly canAdd: boolean;
  readonly canDelete: boolean;
  readonly canMove: boolean;
  /** A card of the narrow list (< 768 px): its parent path, and whether it is dimmed. */
  readonly cardPath: (row: number) => { readonly path: string; readonly dimmed: boolean };
}

const NO_ROWS: TreeDataRows = {
  getRecord: () => undefined,
  rowOf: () => undefined,
  loadRows: () => Promise.resolve([]),
  findRecord: () => undefined,
};

/** The first non-empty text. */
function firstText(...texts: readonly string[]): string {
  return texts.find((text) => text !== '') ?? '';
}

/** Title of a `parent` value (`{ id, title }`, CONTRACTS §2), '' when none. */
function linkTitleOf(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('title' in value)) return '';
  return typeof value.title === 'string' ? value.title : '';
}

function problemKey(problem: MoveProblem): string {
  return `refused.${problem}`;
}

/**
 * The sub-record tree of a grid page (T417): what `GridView` draws and the
 * actions of its rows — expand, "+ Sub-record", drag ⋮⋮ / indent / outdent
 * (checked here first: a record into its own branch or past 10 levels is
 * refused before any request; the server's `SUBRECORD_CYCLE` /
 * `SUBRECORD_TOO_DEEP` still apply), delete with the sub-records' fate,
 * and the selection following a moved or created record.
 */
export function useGridTree({
  state,
  tableId,
  fields,
  parentFieldId,
  locale,
  controller,
  undo,
  gridHandle,
  canAdd,
  canDelete,
  canMove,
  onRecordsGone,
}: GridTreeOptions): GridTreeState {
  const { t } = useTranslation(['tree', 'grid']);
  const queryClient = useQueryClient();
  const { rows, snapshot, expand } = state;
  const primary = useMemo(() => fields.find((field) => field.field.is_primary), [fields]);

  /** The primary field of a record as text ('' when empty or unknown). */
  const textOf = useCallback(
    (record: RecordDto | undefined) =>
      record === undefined || primary === undefined
        ? ''
        : cellClipboardText(primary, record.fields[primary.field.id], locale),
    [primary, locale],
  );
  const titleOf = useCallback(
    (recordId: string) => {
      const text = textOf(rows?.findRecord(recordId));
      return text === '' ? t('tree:untitled') : text;
    },
    [rows, textOf, t],
  );
  const nodeAt = useCallback((row: number) => rows?.nodeAt(row), [rows]);

  // --- selection following a record (created, moved) ------------------------------------
  /** A move is on its way (until its record is selected again). */
  const moving = useRef(false);
  const focusTarget = useRef<{ recordId: string; column: number; since: number } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const focusRecord = useCallback((recordId: string, column = 0) => {
    focusTarget.current = { recordId, column, since: Date.now() };
    setFocusTick((tick) => tick + 1);
  }, []);
  useEffect(() => {
    const target = focusTarget.current;
    if (target === null || rows === null) return;
    const row = rows.rowOf(target.recordId);
    if (row !== undefined) {
      // Focus first: glide selects its first cell when it gains the focus without a
      // selection (the click went to "+ Sub-record"), which would win over ours.
      gridHandle.current?.focus();
      gridHandle.current?.focusCell(row, target.column);
      focusTarget.current = null;
      moving.current = false;
      return;
    }
    if (Date.now() - target.since > FOCUS_MS) {
      focusTarget.current = null;
      moving.current = false;
    }
  }, [focusTick, rows, snapshot.version, gridHandle]);

  // --- moves ------------------------------------------------------------------------------
  const source = useMemo<MoveSource>(
    () => ({
      nodeAt: (row) => rows?.nodeAt(row),
      branchEnd: (row) => rows?.model.branchEnd(row) ?? row,
    }),
    [rows],
  );

  const refuse = useCallback(
    (problem: MoveProblem) => {
      if (problem === 'same') return;
      showToast({
        variant: problem === 'unloaded' ? 'info' : 'error',
        message: t(problemKey(problem) as 'tree:refused.cycle', { max: TREE_MAX_LEVELS }),
      });
    },
    [t],
  );

  const move = useCallback(
    async (recordId: string, parentId: string | null, parentDepth: number) => {
      // One move at a time: until the moved record is selected again, the selected row
      // is where it was, and a second key would move another record.
      if (rows === null || moving.current) return;
      moving.current = true;
      const before = rows.findRecord(recordId);
      // Named now: once the levels are fetched again the record may sit in a branch not loaded yet.
      const title = textOf(before);
      const parentTitle = parentId === null ? '' : textOf(rows.findRecord(parentId));
      try {
        const updated = await recordTreeApi.setParent(tableId, recordId, parentId);
        // The new parent opens: the record stays in sight where it went.
        if (parentId !== null) expand.setExpanded(parentId, parentDepth, true);
        if (updated !== null && parentFieldId !== null) {
          rows.cache.replace(updated);
          undo({
            kind: 'update',
            tableId,
            changes: [
              {
                recordId,
                fieldId: parentFieldId,
                before: before?.fields[parentFieldId] ?? null,
                after: updated.fields[parentFieldId] ?? null,
                ...(before === undefined ? {} : { versionBefore: before.version }),
                versionAfter: updated.version,
              },
            ],
          });
        }
        // Selected once the levels are fetched again (before that it is still in its old place).
        await rows.refresh();
        if (updated === null) {
          moving.current = false;
          onRecordsGone([recordId]);
        } else {
          focusRecord(recordId);
        }
        const moved = firstText(title, textOf(updated ?? undefined), t('tree:untitled'));
        showToast({
          variant: 'success',
          message:
            parentId === null
              ? t('tree:moved.root', { title: moved })
              : t('tree:moved.under', {
                  title: moved,
                  parent: firstText(
                    parentTitle,
                    parentFieldId === null ? '' : linkTitleOf(updated?.fields[parentFieldId]),
                    t('tree:untitled'),
                  ),
                }),
        });
      } catch (error) {
        // SUBRECORD_CYCLE / SUBRECORD_TOO_DEEP / LINK_TARGET_NOT_FOUND: the row stays where it was.
        showErrorToast(error);
        moving.current = false;
        void rows.refresh();
      }
    },
    [rows, tableId, expand, parentFieldId, undo, onRecordsGone, focusRecord, t, textOf],
  );

  const apply = useCallback(
    (row: number, check: MoveCheck | undefined, none: string) => {
      const node = rows?.nodeAt(row);
      if (node?.recordId === undefined) return;
      if (check === undefined) {
        showToast({ variant: 'info', message: t(none as 'tree:indentNone') });
        return;
      }
      if (!check.ok) {
        refuse(check.problem);
        return;
      }
      const parentDepth =
        check.parentId === null ? -1 : (rowDepth(rows, check.parentId) ?? node.depth - 1);
      void move(node.recordId, check.parentId, parentDepth);
    },
    [rows, refuse, move, t],
  );

  const indent = useCallback(
    (row: number) => {
      if (!canMove) return;
      apply(row, indentTarget(source, row), 'tree:indentNone');
    },
    [canMove, apply, source],
  );
  const outdent = useCallback(
    (row: number) => {
      if (!canMove) return;
      apply(row, outdentTarget(source, row), 'tree:outdentNone');
    },
    [canMove, apply, source],
  );

  const setParent = useCallback(
    async (recordId: string, parentId: string | null) => {
      const depth = parentId === null ? -1 : (rowDepth(rows, parentId) ?? 0);
      await move(recordId, parentId, depth);
    },
    [rows, move],
  );

  // --- adding ------------------------------------------------------------------------------
  const addChild = useCallback(
    (recordId: string) => {
      if (rows === null) return;
      const row = rows.rowOf(recordId);
      const depth = row === undefined ? 0 : (rows.nodeAt(row)?.depth ?? 0);
      if (depth >= TREE_MAX_LEVELS - 1) {
        refuse('depth');
        return;
      }
      void recordTreeApi.createChild(tableId, recordId).then(
        (response) => {
          const record = response.records[0];
          expand.setExpanded(recordId, depth, true);
          if (record !== undefined) undo({ kind: 'create', tableId, recordIds: [record.id] });
          void rows.refresh().then(() => {
            if (record !== undefined) focusRecord(record.id);
          });
        },
        (error: unknown) => {
          showErrorToast(error);
        },
      );
    },
    [rows, tableId, expand, undo, focusRecord, refuse],
  );

  const addRoot = useCallback(
    (column = 0) => {
      void controller.create().then((created) => {
        if (created !== null) focusRecord(created.record.id, column);
      });
    },
    [controller, focusRecord],
  );

  const addSibling = useCallback(
    (row: number, column = 0) => {
      const node = rows?.nodeAt(row);
      if (node === undefined || node.parentId === null) {
        addRoot(column);
        return;
      }
      addChild(node.parentId);
    },
    [rows, addRoot, addChild],
  );

  // --- deleting ------------------------------------------------------------------------------
  const deleteRecords = useCallback(
    async (recordIds: readonly string[], children: SubrecordDeleteMode) => {
      if (recordIds.length === 0) return 0;
      const deleted: string[] = [];
      try {
        for (let start = 0; start < recordIds.length; start += MAX_RECORDS_PER_REQUEST) {
          const chunk = recordIds.slice(start, start + MAX_RECORDS_PER_REQUEST);
          const response = await recordTreeApi.remove(tableId, chunk, children);
          deleted.push(...response.ids);
        }
      } catch (error) {
        showErrorToast(error);
      }
      if (deleted.length > 0) {
        // Restoring brings back the whole branch deleted with them (undo).
        undo({ kind: 'delete', tableId, recordIds: deleted });
        if (rows === null) {
          void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
        } else {
          rows.removeRecords(deleted);
        }
        onRecordsGone(deleted);
        showToast({
          variant: 'success',
          message: t('grid:edit.deleted', { count: deleted.length }),
        });
      }
      return deleted.length;
    },
    [rows, tableId, undo, onRecordsGone, t, queryClient],
  );

  const [pendingDelete, setPendingDelete] = useState<TreeDeleteRequest | null>(null);
  const deleteResolver = useRef<((count: number) => void) | null>(null);
  const requestDelete = useCallback(
    (recordIds: readonly string[]) => {
      const ids = [...new Set(recordIds)];
      let children = 0;
      for (const id of ids) {
        const row = rows?.rowOf(id);
        const node = row === undefined ? undefined : rows?.nodeAt(row);
        children += node?.childCount ?? 0;
      }
      deleteResolver.current?.(0);
      return new Promise<number>((resolve) => {
        deleteResolver.current = resolve;
        setPendingDelete({ ids, children });
      });
    },
    [rows],
  );
  const resolveDelete = useCallback(
    (children: SubrecordDeleteMode | null) => {
      const request = pendingDelete;
      const resolve = deleteResolver.current;
      deleteResolver.current = null;
      setPendingDelete(null);
      if (request === null || resolve === null) return;
      if (children === null) {
        resolve(0);
        return;
      }
      void deleteRecords(request.ids, children).then(resolve);
    },
    [pendingDelete, deleteRecords],
  );

  // --- the grid ------------------------------------------------------------------------------
  const [rowMenu, setRowMenu] = useState<TreeRowMenuState | null>(null);
  const [pickParentFor, setPickParentFor] = useState<string | null>(null);
  const reveal = useCallback(
    (recordId: string) => {
      const row = rows?.rowOf(recordId);
      if (row !== undefined) gridHandle.current?.focusCell(row, 0);
    },
    [rows, gridHandle],
  );
  const toggle = useCallback(
    // Against whatever opens it by default (levels, a filter match below it).
    (recordId: string) => {
      expand.toggle(recordId);
    },
    [expand],
  );

  const grid = useMemo<GridTree | undefined>(() => {
    if (rows === null) return undefined;
    return {
      nodeAt: (row) => rows.nodeAt(row),
      titleOf,
      hooks: {
        onToggle: toggle,
        onReveal: reveal,
        ...(canAdd ? { onAddChild: addChild } : {}),
        ...(canMove
          ? {
              moves: {
                checkDrop: (row: number, target: number, placement: DropPlacement) => {
                  const check = checkDrop(source, row, target, placement);
                  return check.ok ? null : check.problem;
                },
                onDrop: (row: number, target: number, placement: DropPlacement) => {
                  const check = checkDrop(source, row, target, placement);
                  const node = rows.nodeAt(row);
                  if (!check.ok) {
                    refuse(check.problem);
                    return;
                  }
                  if (node?.recordId === undefined) return;
                  const over = rows.nodeAt(target);
                  const parentDepth =
                    check.parentId === null
                      ? -1
                      : placement === 'child'
                        ? (over?.depth ?? 0)
                        : (over?.depth ?? 1) - 1;
                  void move(node.recordId, check.parentId, parentDepth);
                },
                onIndent: indent,
                onOutdent: outdent,
              },
            }
          : {}),
        onRowMenu: (cell, row, anchor) => {
          setRowMenu({ cell, row, anchor });
        },
      },
    };
  }, [
    rows,
    titleOf,
    toggle,
    reveal,
    canAdd,
    addChild,
    canMove,
    source,
    refuse,
    move,
    indent,
    outdent,
  ]);

  const data = useMemo<TreeDataRows>(
    () =>
      rows === null
        ? NO_ROWS
        : {
            getRecord: (row) => rows.getRecord(row),
            rowOf: (recordId) => rows.rowOf(recordId),
            loadRows: (firstRow, lastRow) => rows.loadRows(firstRow, lastRow),
            findRecord: (recordId) => rows.findRecord(recordId),
          },
    [rows],
  );
  const setViewport = useCallback(
    (viewport: GridViewport) => {
      rows?.setViewport(viewport.firstRow, viewport.lastRow, viewport.dragging);
    },
    [rows],
  );

  return {
    active: rows !== null,
    grid,
    data,
    setViewport,
    nodeAt,
    titleOf,
    addRoot,
    addChild,
    addSibling,
    indent,
    outdent,
    setParent,
    requestDelete,
    deleteRecords,
    pendingDelete,
    resolveDelete,
    rowMenu,
    closeRowMenu: () => {
      setRowMenu(null);
    },
    pickParentFor,
    setPickParentFor,
    canAdd,
    canDelete,
    canMove,
    cardPath: (row) => {
      const node = rows?.nodeAt(row);
      return {
        path: node === undefined ? '' : node.ancestors.map(titleOf).join(' › '),
        dimmed: node?.ancestorOnly === true,
      };
    },
  };
}

/** Depth of a record shown in the tree, `undefined` when it is not shown. */
function rowDepth(rows: TreeRowsState['rows'], recordId: string): number | undefined {
  const row = rows?.rowOf(recordId);
  return row === undefined ? undefined : rows?.nodeAt(row)?.depth;
}
