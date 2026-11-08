import { Button, Tooltip } from '@cellhive/ui';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Keys announced for "Add record" (FRONTEND §6.2). */
const ADD_KEYS = 'Control+Shift+Enter Meta+Shift+Enter';

/** "⌘" on macOS, "Ctrl" elsewhere (FRONTEND §6.2). */
function primaryKey(): string {
  return /Mac|iPhone|iPad/u.test(navigator.platform) ? '⌘' : 'Ctrl';
}

export interface AddRecordButtonProps {
  readonly onAdd: () => void;
}

/**
 * "+ Record" of the grid toolbar (FRONTEND §7: shown only with the `add`
 * operation; the server still decides): at the end of the toolbar, in the
 * accent color (T320b, design).
 */
export function AddRecordButton({ onAdd }: AddRecordButtonProps) {
  const { t } = useTranslation('grid');
  const shortcut = t('actions.addShortcut', { key: primaryKey() });
  return (
    <Tooltip content={t('actions.add')} shortcut={shortcut}>
      <Button
        size="toolbar"
        className="font-medium max-md:w-control max-md:px-0"
        aria-label={t('actions.add')}
        aria-keyshortcuts={ADD_KEYS}
        onClick={onAdd}
      >
        <Plus aria-hidden="true" />
        <span aria-hidden="true" className="max-md:hidden">
          {t('actions.addShort')}
        </span>
      </Button>
    </Tooltip>
  );
}
