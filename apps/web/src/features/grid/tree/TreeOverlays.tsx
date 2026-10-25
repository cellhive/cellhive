import { ParentPickerDialog } from '../../../lib/records/ParentPickerDialog';

import { DeleteBranchDialog } from './DeleteBranchDialog';
import { indentTarget, outdentTarget } from './moves';
import { TreeRowMenu, type TreeRowAction } from './TreeRowMenu';

import type { GridTreeState } from './use-grid-tree';
import type { CellAddress, HeaderMenuAnchor } from '../../../grid';
import type { ReactNode } from 'react';

export interface TreeOverlaysProps {
  readonly tree: GridTreeState;
  readonly tableId: string;
  readonly tableName: string;
  readonly primaryFieldId: string | null;
  readonly parentFieldId: string | null;
  readonly onOpenRecord: (recordId: string) => void;
  readonly onCellHistory: (cell: CellAddress, anchor: HeaderMenuAnchor) => void;
  /** The keyboard focus goes back to the grid when the menu closes. */
  readonly onReturnFocus: () => void;
  /** "Follow" / "Unfollow" item of the row menu for a record (T553). */
  readonly followItem?: (recordId: string) => ReactNode;
}

/**
 * The menus and dialogs of a tree grid (T417): the row menu (right click),
 * the delete confirmation that asks about sub-records, and the parent
 * picker of "Change parent…".
 */
export function TreeOverlays({
  tree,
  tableId,
  tableName,
  primaryFieldId,
  parentFieldId,
  onOpenRecord,
  onCellHistory,
  onReturnFocus,
  followItem,
}: TreeOverlaysProps) {
  const menu = tree.rowMenu;
  const node = menu === null ? undefined : tree.nodeAt(menu.row);
  const source = { nodeAt: tree.nodeAt, branchEnd: (row: number) => row };
  const onAction = (action: TreeRowAction) => {
    if (menu === null) return;
    const { cell, row, anchor } = menu;
    tree.closeRowMenu();
    switch (action) {
      case 'open':
        onOpenRecord(cell.recordId);
        return;
      case 'history':
        onCellHistory(cell, anchor);
        return;
      case 'addChild':
        tree.addChild(cell.recordId);
        return;
      case 'addSibling':
        tree.addSibling(row, 0);
        return;
      case 'changeParent':
        tree.setPickParentFor(cell.recordId);
        return;
      case 'outdent':
        tree.outdent(row);
        return;
      case 'indent':
        tree.indent(row);
        return;
      case 'delete':
        void tree.requestDelete([cell.recordId]);
        return;
    }
  };
  const picked = tree.pickParentFor;
  const pickedRow = picked === null ? undefined : tree.data.rowOf(picked);
  const pickedNode = pickedRow === undefined ? undefined : tree.nodeAt(pickedRow);
  return (
    <>
      {menu === null ? null : (
        <TreeRowMenu
          title={tree.titleOf(menu.cell.recordId)}
          anchor={menu.anchor}
          canAddChild={tree.canAdd && (node?.depth ?? 0) < 9}
          canAddSibling={tree.canAdd}
          canMove={tree.canMove && parentFieldId !== null}
          canOutdent={outdentTarget(source, menu.row) !== undefined}
          canIndent={indentTarget(source, menu.row) !== undefined}
          canDelete={tree.canDelete}
          followItem={followItem?.(menu.cell.recordId)}
          onAction={onAction}
          onClose={() => {
            tree.closeRowMenu();
            onReturnFocus();
          }}
        />
      )}
      <DeleteBranchDialog
        request={tree.pendingDelete}
        tableName={tableName}
        onResolve={tree.resolveDelete}
      />
      {picked === null || primaryFieldId === null ? null : (
        <ParentPickerDialog
          open
          tableId={tableId}
          recordId={picked}
          recordTitle={tree.titleOf(picked)}
          primaryFieldId={primaryFieldId}
          currentParentId={pickedNode?.parentId ?? null}
          onSelect={(parentId) => tree.setParent(picked, parentId)}
          onClose={() => {
            tree.setPickParentFor(null);
            onReturnFocus();
          }}
        />
      )}
    </>
  );
}
