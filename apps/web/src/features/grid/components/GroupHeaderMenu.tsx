import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { ChevronsDownUp, ChevronsUpDown, FoldVertical, Plus, UnfoldVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { HeaderMenuAnchor } from '../../../grid';

/** What the menu of a group header can do (T320a, like Lark's header menu). */
export type GroupMenuAction =
  'toggle' | 'collapseAll' | 'expandAll' | 'collapseSubgroups' | 'expandSubgroups' | 'add';

export interface GroupHeaderMenuProps {
  /** Accessible name of the group (field and value). */
  readonly label: string;
  readonly anchor: HeaderMenuAnchor;
  readonly collapsed: boolean;
  /** The group has nested groups (the subgroup items). */
  readonly nested: boolean;
  /** A record may be added to the group. */
  readonly canAdd: boolean;
  readonly onAction: (action: GroupMenuAction) => void;
  readonly onClose: () => void;
  /** Where the focus goes when the menu closes (the grid: its header row stays selected). */
  readonly onReturnFocus?: () => void;
}

/**
 * Menu of a group header (T320a): right click, the "▾" after the count,
 * or Shift+F10 / the menu key on a header row. Collapse or expand this
 * group, all groups, or the subgroups of this one — replaces the separate
 * "collapse all / expand all" toolbar line of T312 — and add a record to
 * the group (the keyboard way to the "+" row).
 */
export function GroupHeaderMenu({
  label,
  anchor,
  collapsed,
  nested,
  canAdd,
  onAction,
  onClose,
  onReturnFocus,
}: GroupHeaderMenuProps) {
  const { t } = useTranslation('grid');
  const menuLabel = t('groupMenu.label', { group: label });
  const item = (action: GroupMenuAction) => () => {
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
          aria-label={menuLabel}
          className="pointer-events-none fixed opacity-0"
          style={{ left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        aria-label={menuLabel}
        onCloseAutoFocus={(event) => {
          if (onReturnFocus === undefined) return;
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DropdownMenuItem onSelect={item('toggle')}>
          {collapsed ? <UnfoldVertical aria-hidden="true" /> : <FoldVertical aria-hidden="true" />}
          {collapsed ? t('groupMenu.expand') : t('groupMenu.collapse')}
        </DropdownMenuItem>
        {nested ? (
          <>
            <DropdownMenuItem onSelect={item('expandSubgroups')}>
              <ChevronsUpDown aria-hidden="true" />
              {t('groupMenu.expandSubgroups')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={item('collapseSubgroups')}>
              <ChevronsDownUp aria-hidden="true" />
              {t('groupMenu.collapseSubgroups')}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={item('expandAll')}>
          <ChevronsUpDown aria-hidden="true" />
          {t('group.expandAll')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={item('collapseAll')}>
          <ChevronsDownUp aria-hidden="true" />
          {t('group.collapseAll')}
        </DropdownMenuItem>
        {canAdd ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={item('add')}>
              <Plus aria-hidden="true" />
              {t('groupMenu.add')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
