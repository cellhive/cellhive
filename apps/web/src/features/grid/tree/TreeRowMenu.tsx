import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import {
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  History,
  Maximize2,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { TreeIcon, treeShortcutLabel, type HeaderMenuAnchor } from '../../../grid';
import { isApplePlatform } from '../../../grid/undo/keys';

import type { ReactNode } from 'react';

/** `aria-keyshortcuts` of the items (FRONTEND §6.2). */
const KEYS = {
  open: 'Space',
  addSibling: 'Shift+Enter',
  outdent: 'Control+BracketLeft Meta+BracketLeft Alt+Shift+ArrowLeft',
  indent: 'Control+BracketRight Meta+BracketRight Alt+Shift+ArrowRight',
} as const;

export type TreeRowAction =
  'open' | 'history' | 'addChild' | 'addSibling' | 'changeParent' | 'outdent' | 'indent' | 'delete';

export interface TreeRowMenuProps {
  /** Title of the row's record (accessible name of the menu). */
  readonly title: string;
  readonly anchor: HeaderMenuAnchor;
  readonly canAddChild: boolean;
  readonly canAddSibling: boolean;
  readonly canMove: boolean;
  readonly canOutdent: boolean;
  readonly canIndent: boolean;
  readonly canDelete: boolean;
  readonly onAction: (action: TreeRowAction) => void;
  readonly onClose: () => void;
  /** "Follow" / "Unfollow" of the row's record (T553, `FollowMenuItem`), after "Open". */
  readonly followItem?: ReactNode;
}

function Shortcut({ children }: { readonly children: string }) {
  return (
    <span aria-hidden="true" className="ml-auto pl-4 text-label font-normal text-fg-muted">
      {children}
    </span>
  );
}

/**
 * The row menu of a tree (T417, board "Sub-records dạng cây"): right click
 * on a row. Open the record (Space), follow or unfollow it (T553), its cell history, add a sub-record or
 * a record at the same level, change the parent (picker), move up a level
 * (Ctrl/⌘+[) or under the row above (Ctrl/⌘+]), delete. The shortcuts are
 * announced through `aria-keyshortcuts` (FRONTEND §6.2).
 */
export function TreeRowMenu({
  title,
  anchor,
  canAddChild,
  canAddSibling,
  canMove,
  canOutdent,
  canIndent,
  canDelete,
  onAction,
  onClose,
  followItem,
}: TreeRowMenuProps) {
  const { t } = useTranslation(['tree', 'grid']);
  const apple = isApplePlatform();
  const label = t('tree:menu.label', { title });
  const select = (action: TreeRowAction) => () => {
    onAction(action);
  };
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          className="pointer-events-none fixed opacity-0"
          style={{ left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={label}
        className="w-max min-w-66"
        data-testid="tree-row-menu"
      >
        <DropdownMenuItem aria-keyshortcuts={KEYS.open} onSelect={select('open')}>
          <Maximize2 aria-hidden="true" />
          {t('tree:menu.open')}
          <Shortcut>{t('grid:shortcuts.keys.space')}</Shortcut>
        </DropdownMenuItem>
        {followItem}
        <DropdownMenuItem onSelect={select('history')}>
          <History aria-hidden="true" />
          {t('grid:cellMenu.history')}
        </DropdownMenuItem>
        {canAddChild ? (
          <DropdownMenuItem onSelect={select('addChild')}>
            <CornerDownRight aria-hidden="true" />
            {t('tree:menu.addChild')}
          </DropdownMenuItem>
        ) : null}
        {canAddSibling ? (
          <DropdownMenuItem aria-keyshortcuts={KEYS.addSibling} onSelect={select('addSibling')}>
            <Plus aria-hidden="true" />
            {t('tree:menu.addSibling')}
          </DropdownMenuItem>
        ) : null}
        {canMove ? (
          <>
            <DropdownMenuItem onSelect={select('changeParent')}>
              <TreeIcon className="size-4" />
              {t('tree:menu.changeParent')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canOutdent}
              aria-keyshortcuts={KEYS.outdent}
              onSelect={select('outdent')}
            >
              <ChevronLeft aria-hidden="true" />
              {t('tree:menu.outdent')}
              <Shortcut>{treeShortcutLabel('outdent', apple)}</Shortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canIndent}
              aria-keyshortcuts={KEYS.indent}
              onSelect={select('indent')}
            >
              <ChevronRight aria-hidden="true" />
              {t('tree:menu.indent')}
              <Shortcut>{treeShortcutLabel('indent', apple)}</Shortcut>
            </DropdownMenuItem>
          </>
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-danger [&_svg]:text-danger"
              onSelect={select('delete')}
            >
              <Trash2 aria-hidden="true" />
              {t('tree:menu.delete')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
