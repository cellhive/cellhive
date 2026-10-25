import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { GridDensity } from '../../../grid';
import type { ReactNode } from 'react';

export interface GridToolbarProps {
  readonly density: GridDensity;
  readonly onDensityChange: (density: GridDensity) => void;
  /** Narrow screens always use the comfortable (touch) height (FRONTEND §9.4). */
  readonly densityLocked: boolean;
  /** View controls: hidden fields, filter, group, sort (T311, T312). */
  readonly children?: ReactNode;
  /** The view's search box (T311), right-aligned before the record actions. */
  readonly search?: ReactNode;
  /** Before the view controls: undo / redo (icon-only; from 768 px, else in the menu). */
  readonly leading?: ReactNode;
  /**
   * After the view controls and the "⋯" menu, set apart by a divider: the
   * actions on the selected rows ("Delete N records", T322a — away from
   * the primary action).
   */
  readonly selection?: ReactNode;
  /** At the end: the primary action, "+ Record" (accent). */
  readonly primary?: ReactNode;
  /**
   * Items of the "⋯" menu (`DropdownMenuItem`s): secondary actions — undo /
   * redo, keyboard shortcuts, add field — followed by the row height.
   */
  readonly menu?: ReactNode;
}

const DENSITIES: readonly GridDensity[] = ['compact', 'comfortable'];

/**
 * Toolbar above the grid (T320b, design "Grid - Tickets", Lark): one row
 * that never wraps — the view controls on the left (their labels give way
 * to icons below 1280 px, `TOOLBAR_LABEL`),
 * then "⋯" with the secondary actions and the row height (a view setting,
 * T310), then the actions on the selected rows; the search box and
 * "+ Record" on the right.
 */
export function GridToolbar({
  density,
  onDensityChange,
  densityLocked,
  children,
  search,
  leading,
  selection,
  primary,
  menu,
}: GridToolbarProps) {
  const { t } = useTranslation('grid');
  return (
    <div
      role="toolbar"
      aria-label={t('toolbar.label')}
      className="flex min-h-11 shrink-0 flex-nowrap items-center gap-1 border-b border-line bg-surface px-3 lg:px-4"
    >
      {leading === undefined ? null : (
        <div className="mr-1 hidden shrink-0 items-center md:flex">{leading}</div>
      )}
      <div className="flex min-w-0 shrink-0 items-center gap-1">{children}</div>
      <DropdownMenu>
        <Tooltip content={t('toolbar.more')}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-fg-muted"
              aria-label={t('toolbar.more')}
              data-testid="grid-toolbar-more"
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-64">
          {menu}
          {densityLocked ? null : (
            <>
              {menu === undefined ? null : <DropdownMenuSeparator />}
              <DropdownMenuLabel>{t('toolbar.density')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={density}
                onValueChange={(value) => {
                  onDensityChange(value as GridDensity);
                }}
              >
                {DENSITIES.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {t(`toolbar.densities.${value}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {selection === undefined || selection === null ? null : (
        <div className="flex shrink-0 items-center gap-1">{selection}</div>
      )}
      <div className="min-w-0 flex-1" />
      {search === undefined ? null : (
        <div className="flex min-w-24 shrink items-center md:w-56 xl:w-64">{search}</div>
      )}
      {primary === undefined ? null : (
        <div className="flex shrink-0 items-center gap-1">{primary}</div>
      )}
    </div>
  );
}
