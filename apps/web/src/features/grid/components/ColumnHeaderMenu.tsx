import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import {
  ArrowDownWideNarrow,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpNarrowWide,
  EyeOff,
  LoaderCircle,
  Sigma,
  TriangleAlert,
  Pencil,
  Pin,
  Settings2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { computedColumnOf } from '../../../grid/display/computed';

import type { HeaderMenuAnchor } from '../../../grid';
import type { FieldDto } from '@cellhive/contracts';

/** What the header menu of a column can do. */
export type ColumnMenuAction =
  | 'edit'
  | 'rename'
  | 'insertLeft'
  | 'insertRight'
  | 'sortAsc'
  | 'sortDesc'
  | 'freeze'
  | 'hide'
  | 'delete'
  /** T414: undo the last type conversion (7 days). */
  | 'revert'
  /** T414: focus the conversion banner of the column. */
  | 'progress'
  /** T468: the formula popover under the header ("Edit formula"). */
  | 'formula'
  /** T468: the details of a field-level error (the header badge, from the keyboard). */
  | 'computedError';

/** What the menu of a formula/lookup column adds (T468). */
export interface ColumnComputedMenu {
  readonly formula: boolean;
  readonly error: boolean;
  /** Not sortable: locked, in error, or a record/file result (CONTRACTS §1.4). */
  readonly sortable: boolean;
}

/** The computed part of a column's menu, `undefined` for other fields. */
export function columnComputed(field: FieldDto): ColumnComputedMenu | undefined {
  const computed = computedColumnOf(field);
  if (computed === undefined) return undefined;
  const kind = computed.resultType?.kind;
  return {
    formula: computed.type === 'formula',
    error: computed.error !== null,
    sortable:
      !computed.locked && computed.error === null && kind !== 'record' && kind !== 'attachment',
  };
}

export interface ColumnHeaderMenuProps {
  readonly field: FieldDto;
  readonly anchor: HeaderMenuAnchor;
  /** Schema rights on the table (FRONTEND §7): edit, rename, insert, delete. */
  readonly canManageSchema: boolean;
  /**
   * T414: a conversion of the field runs: schema actions and sorting are
   * disabled with the reason (`409 SCHEMA_LOCKED`), "Show progress" added.
   */
  readonly converting?: boolean;
  /** T414: days left to undo the last conversion (schema managers); `null`: none. */
  readonly revertDays?: number | null;
  /** T468: a formula/lookup column (`columnComputed`). */
  readonly computed?: ColumnComputedMenu | undefined;
  readonly onAction: (action: ColumnMenuAction) => void;
  readonly onClose: () => void;
}

/**
 * Menu of a column header (T207): field configuration for schema managers,
 * view actions (sort, freeze, hide) for everyone. Opened from glide's header
 * menu button or a right click, positioned at the header.
 */
export function ColumnHeaderMenu({
  field,
  anchor,
  canManageSchema,
  converting = false,
  revertDays = null,
  computed,
  onAction,
  onClose,
}: ColumnHeaderMenuProps) {
  const { t } = useTranslation('grid');
  const primary = field.is_primary;
  const lockedHint = converting ? (
    <span className="ml-auto pl-3 text-label font-normal text-fg-muted">
      {t('columnMenu.converting')}
    </span>
  ) : null;
  const item = (action: ColumnMenuAction) => () => {
    onAction(action);
  };
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        {/* Invisible anchor at the header; the canvas has no DOM element to attach to. */}
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('columnMenu.label', { name: field.name })}
          className="pointer-events-none fixed opacity-0"
          style={{ left: anchor.x, top: anchor.y, width: anchor.width, height: anchor.height }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={t('columnMenu.label', { name: field.name })}>
        {computed?.error === true ? (
          <>
            <DropdownMenuItem onSelect={item('computedError')} className="text-danger">
              <TriangleAlert aria-hidden="true" className="text-danger" />
              {t('columnMenu.computedError')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {canManageSchema ? (
          <>
            {computed?.formula === true ? (
              <DropdownMenuItem disabled={converting} onSelect={item('formula')}>
                <Sigma aria-hidden="true" />
                {t('columnMenu.editFormula')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem disabled={converting} onSelect={item('edit')}>
              <Settings2 aria-hidden="true" />
              {t('columnMenu.edit')}
              {lockedHint}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={converting} onSelect={item('rename')}>
              <Pencil aria-hidden="true" />
              {t('columnMenu.rename')}
            </DropdownMenuItem>
            {revertDays !== null && !converting ? (
              <DropdownMenuItem onSelect={item('revert')}>
                <Undo2 aria-hidden="true" />
                {t('columnMenu.revert', { count: revertDays })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {primary ? null : (
              <DropdownMenuItem onSelect={item('insertLeft')}>
                <ArrowLeftToLine aria-hidden="true" />
                {t('columnMenu.insertLeft')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={item('insertRight')}>
              <ArrowRightToLine aria-hidden="true" />
              {t('columnMenu.insertRight')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          disabled={converting || computed?.sortable === false || field.type === 'button'}
          onSelect={item('sortAsc')}
        >
          <ArrowUpNarrowWide aria-hidden="true" />
          {t('columnMenu.sortAsc')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={converting || computed?.sortable === false || field.type === 'button'}
          onSelect={item('sortDesc')}
        >
          <ArrowDownWideNarrow aria-hidden="true" />
          {t('columnMenu.sortDesc')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={item('freeze')}>
          <Pin aria-hidden="true" />
          {t('columnMenu.freeze')}
        </DropdownMenuItem>
        {primary ? null : (
          <DropdownMenuItem onSelect={item('hide')}>
            <EyeOff aria-hidden="true" />
            {t('columnMenu.hide')}
          </DropdownMenuItem>
        )}
        {converting ? (
          <DropdownMenuItem onSelect={item('progress')}>
            <LoaderCircle aria-hidden="true" />
            {t('columnMenu.progress')}
          </DropdownMenuItem>
        ) : null}
        {canManageSchema ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={primary || converting}
              onSelect={item('delete')}
              className="text-danger [&_svg]:text-danger"
            >
              <Trash2 aria-hidden="true" />
              {primary ? t('columnMenu.primaryNotDeletable') : t('columnMenu.delete')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
