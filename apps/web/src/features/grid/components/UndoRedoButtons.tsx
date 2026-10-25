import { Button, Tooltip } from '@cellhive/ui';
import { Redo2, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isApplePlatform } from '../../../grid/undo/keys';

import type { BulkProgress } from '../bulk/use-grid-clipboard';

/** Keys announced to assistive technology (FRONTEND §6.2). */
const UNDO_KEYS = 'Control+Z Meta+Z';
const REDO_KEYS = 'Shift+Control+Z Shift+Meta+Z Control+Y';

export interface UndoRedoButtonsProps {
  /** `false` hides undo and redo (the user cannot change records). */
  readonly editable: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly busy: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  /** A bulk write of several requests in flight (FRONTEND §4.2). */
  readonly progress: BulkProgress | null;
}

/**
 * Undo / redo (FRONTEND §6.1), icon-only at the start of the toolbar, and
 * the progress of a large paste. The shortcut list (§6.2) is in the
 * toolbar's "≡" menu (T320b).
 */
export function UndoRedoButtons({
  editable,
  canUndo,
  canRedo,
  busy,
  onUndo,
  onRedo,
  progress,
}: UndoRedoButtonsProps) {
  const { t, i18n } = useTranslation('grid');
  const mod = isApplePlatform() ? '⌘' : t('shortcuts.keys.ctrl');
  const undoLabel = t('undo.undo');
  const redoLabel = t('undo.redo');
  const count = (value: number) => value.toLocaleString(i18n.language);
  return (
    <div className="flex items-center gap-1">
      {editable ? (
        <>
          <Tooltip content={undoLabel} shortcut={t('undo.undoKeys', { mod })}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={undoLabel}
              aria-keyshortcuts={UNDO_KEYS}
              disabled={!canUndo || busy}
              onClick={onUndo}
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
              disabled={!canRedo || busy}
              onClick={onRedo}
            >
              <Redo2 aria-hidden="true" />
            </Button>
          </Tooltip>
        </>
      ) : null}
      <span aria-live="polite" className="text-label font-normal text-fg-muted">
        {progress === null
          ? ''
          : t('clipboard.progress', { done: count(progress.done), total: count(progress.total) })}
      </span>
    </div>
  );
}
