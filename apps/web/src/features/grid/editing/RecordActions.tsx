import { Button, Dialog, Tooltip } from '@cellhive/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
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

export interface DeleteRecordsButtonProps {
  readonly tableName: string;
  /** Records of the rows selected through the row markers (not a cell range, T322a). */
  readonly selectedIds: readonly string[];
  readonly onDelete: (recordIds: readonly string[]) => Promise<unknown>;
  /**
   * `false`: `onDelete` asks itself (T417: a tree's dialog also asks what
   * happens to the sub-records). Default: this button's confirmation.
   */
  readonly confirm?: boolean;
}

/**
 * "Delete N records" (FRONTEND §7: only with the `delete` operation), shown
 * while whole rows are selected. T322a: with the view controls on the
 * left, apart from the primary "+ Record" (a destructive action does not
 * sit next to the main one). Deleting asks first and moves the records to
 * the trash (soft delete).
 */
export function DeleteRecordsButton({
  tableName,
  selectedIds,
  onDelete,
  confirm = true,
}: DeleteRecordsButtonProps) {
  const { t } = useTranslation('grid');
  const [confirming, setConfirming] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      {selectedIds.length > 0 ? (
        <>
          {/* Set apart from the view controls before it. */}
          <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />
          <Tooltip content={t('actions.deleteCount', { count: selectedIds.length })}>
            <Button
              size="toolbar"
              variant="ghost"
              className="text-danger hover:bg-surface-sunken"
              aria-label={t('actions.deleteCount', { count: selectedIds.length })}
              onClick={() => {
                if (confirm) setConfirming(selectedIds);
                else void onDelete(selectedIds);
              }}
            >
              <Trash2 aria-hidden="true" />
              <span aria-hidden="true" className="max-lg:hidden">
                {t('actions.deleteCount', { count: selectedIds.length })}
              </span>
            </Button>
          </Tooltip>
        </>
      ) : null}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t('actions.confirmTitle', { count: confirming?.length ?? 0 })}
        description={t('actions.confirmDescription', {
          count: confirming?.length ?? 0,
          table: tableName,
        })}
        closeLabel={t('actions.cancel')}
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setConfirming(null);
            }}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (confirming === null) return;
              setBusy(true);
              void onDelete(confirming).finally(() => {
                setBusy(false);
                setConfirming(null);
              });
            }}
          >
            {t('actions.confirmDelete', { count: confirming?.length ?? 0 })}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
