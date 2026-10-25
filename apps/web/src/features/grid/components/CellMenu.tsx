import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { History, Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { HeaderMenuAnchor } from '../../../grid';
import type { ReactNode } from 'react';

export interface CellMenuProps {
  /** Name of the cell's field (accessible name of the menu). */
  readonly fieldName: string;
  readonly anchor: HeaderMenuAnchor;
  readonly onExpand: () => void;
  readonly onHistory: () => void;
  readonly onClose: () => void;
  /** "Follow" / "Unfollow" of the row's record (T553, `FollowMenuItem`), after "Expand record". */
  readonly followItem?: ReactNode;
}

/**
 * Menu of a grid cell (right click, T206): open the record panel, follow or
 * unfollow the record (T553), or the history of that cell (FRONTEND §10.3
 * "Xem lịch sử ô"). Positioned at the
 * cell like the column header menu (the canvas has no DOM element there).
 */
export function CellMenu({
  fieldName,
  anchor,
  onExpand,
  onHistory,
  onClose,
  followItem,
}: CellMenuProps) {
  const { t } = useTranslation('grid');
  const label = t('cellMenu.label', { name: fieldName });
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
      <DropdownMenuContent align="start" aria-label={label}>
        <DropdownMenuItem onSelect={onExpand}>
          <Maximize2 aria-hidden="true" />
          {t('cellMenu.expand')}
        </DropdownMenuItem>
        {followItem}
        <DropdownMenuItem onSelect={onHistory}>
          <History aria-hidden="true" />
          {t('cellMenu.history')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
