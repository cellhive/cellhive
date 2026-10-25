import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import {
  Columns3,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Redo2,
  SquareKanban,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isApplePlatform } from '../../../grid/undo/keys';

import type { GridField } from '../../../grid/types';
import type { GridUndo } from '../../../grid/undo/table-undo';
import type { ReactNode } from 'react';

/** Keys announced to assistive technology (FRONTEND §6.2), as on the grid. */
const UNDO_KEYS = 'Control+Z Meta+Z';
const REDO_KEYS = 'Shift+Control+Z Shift+Meta+Z Control+Y';

/** Toolbar above the board: undo/redo, then the board settings. */
export function KanbanToolbar({ children }: { children: ReactNode }) {
  const { t } = useTranslation('kanban');
  return (
    <div
      role="toolbar"
      aria-label={t('toolbar.label')}
      className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
    >
      {children}
    </div>
  );
}

/** Undo / redo of the table (FRONTEND §6.1): a move is one step, shared with the grid. */
export function UndoButtons({ editable, undo }: { editable: boolean; undo: GridUndo }) {
  const { t } = useTranslation('grid');
  if (!editable) return null;
  const mod = isApplePlatform() ? '⌘' : t('shortcuts.keys.ctrl');
  const undoLabel = t('undo.undo');
  const redoLabel = t('undo.redo');
  return (
    <div className="flex items-center gap-1">
      <Tooltip content={undoLabel} shortcut={t('undo.undoKeys', { mod })}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={undoLabel}
          aria-keyshortcuts={UNDO_KEYS}
          disabled={!undo.canUndo || undo.busy}
          onClick={undo.undo}
        >
          <Undo2 aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip content={redoLabel} shortcut={t('undo.redoKeys', { mod })}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={redoLabel}
          aria-keyshortcuts={REDO_KEYS}
          disabled={!undo.canRedo || undo.busy}
          onClick={undo.redo}
        >
          <Redo2 aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
  );
}

export interface BoardSettingsProps {
  /** Fields that can group the board (single select, single user). */
  readonly groupFields: readonly GridField[];
  readonly groupFieldId: string | null;
  /** Fields a card may show (every readable field but the primary one). */
  readonly fields: readonly GridField[];
  readonly cardFields: readonly string[];
  readonly hideEmpty: boolean;
  readonly onGroupField: (fieldId: string) => void;
  readonly onCardFields: (fieldIds: string[]) => void;
  readonly onHideEmpty: (hide: boolean) => void;
  /** Attachment fields that can give the cards a cover image (T418, `cover_field`). */
  readonly coverFields?: readonly GridField[];
  readonly coverFieldId?: string | null;
  readonly onCoverField?: (fieldId: string | null) => void;
}

/** Value of the "no cover" radio item (field ids never look like this). */
const NO_COVER = 'none';

/**
 * Board settings (`kanban` of the view config): group field, card fields,
 * empty columns. Saved to the view for those who may, else kept on this
 * device as unsaved changes (T310).
 */
export function BoardSettings({
  groupFields,
  groupFieldId,
  fields,
  cardFields,
  hideEmpty,
  onGroupField,
  onCardFields,
  onHideEmpty,
  coverFields = [],
  coverFieldId = null,
  onCoverField,
}: BoardSettingsProps) {
  const { t } = useTranslation('kanban');
  const groupField = groupFields.find((field) => field.field.id === groupFieldId);
  const shown = new Set(cardFields);
  const count = fields.filter((field) => shown.has(field.field.id)).length;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="toolbar" disabled={groupFields.length === 0}>
            <SquareKanban aria-hidden="true" />
            {groupField === undefined
              ? t('settings.groupBy')
              : t('settings.groupedBy', { name: groupField.field.name })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          <DropdownMenuLabel>{t('settings.groupHeading')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={groupFieldId ?? ''}
            onValueChange={(value) => {
              onGroupField(value);
            }}
          >
            {groupFields.map(({ field }) => (
              <DropdownMenuRadioItem key={field.id} value={field.id}>
                <span className="truncate">{field.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="toolbar"
            className={cn(count > 0 && 'bg-accent-soft text-accent hover:bg-accent-soft')}
          >
            <Columns3 aria-hidden="true" />
            {count > 0 ? t('settings.cardFieldsCount', { count }) : t('settings.cardFields')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          <DropdownMenuLabel>{t('settings.cardFieldsHeading')}</DropdownMenuLabel>
          {fields.map(({ field }) => (
            <DropdownMenuCheckboxItem
              key={field.id}
              checked={shown.has(field.id)}
              onSelect={(event) => {
                // Keep the list open to pick several fields.
                event.preventDefault();
              }}
              onCheckedChange={(checked) => {
                // Card fields follow the order of the table's fields.
                const next = new Set(cardFields);
                if (checked) next.add(field.id);
                else next.delete(field.id);
                onCardFields(
                  fields.map((item) => item.field.id).filter((fieldId) => next.has(fieldId)),
                );
              }}
            >
              <span className="truncate">{field.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {coverFields.length === 0 || onCoverField === undefined ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="toolbar"
              data-testid="kanban-cover-menu"
              className={cn(
                coverFieldId !== null && 'bg-accent-soft text-accent hover:bg-accent-soft',
              )}
            >
              <ImageIcon aria-hidden="true" />
              {t('settings.cover')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            <DropdownMenuLabel>{t('settings.coverHeading')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={coverFieldId ?? NO_COVER}
              onValueChange={(value) => {
                onCoverField(value === NO_COVER ? null : value);
              }}
            >
              <DropdownMenuRadioItem value={NO_COVER}>
                {t('settings.noCover')}
              </DropdownMenuRadioItem>
              {coverFields.map(({ field }) => (
                <DropdownMenuRadioItem key={field.id} value={field.id}>
                  <span className="truncate">{field.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="ghost"
        size="toolbar"
        aria-pressed={hideEmpty}
        className={cn(hideEmpty && 'bg-accent-soft text-accent hover:bg-accent-soft')}
        onClick={() => {
          onHideEmpty(!hideEmpty);
        }}
      >
        {hideEmpty ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        {t('settings.hideEmpty')}
      </Button>
    </>
  );
}
