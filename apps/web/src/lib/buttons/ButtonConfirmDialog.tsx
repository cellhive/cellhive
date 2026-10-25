import { Button, Dialog } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import type { ButtonConfirm } from '@cellhive/contracts';

export interface ButtonConfirmDialogProps {
  readonly confirm: ButtonConfirm;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * "Ask before running" of a button field (T525, boards "S5 · Button field"
 * and "… - 375 px"): the field's title, message and confirm label, as an
 * alert dialog — a bottom sheet below 768 px with full-width 44 px buttons,
 * the confirmation first. Escape or "Cancel" sends nothing; the focus goes
 * back to the button (native `<dialog>`).
 */
export function ButtonConfirmDialog({ confirm, onConfirm, onCancel }: ButtonConfirmDialogProps) {
  const { t } = useTranslation(['grid', 'common']);
  return (
    <Dialog
      open
      role="alertdialog"
      layout="sheet"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={confirm.title}
      {...(confirm.message === '' ? {} : { description: confirm.message })}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <div
        className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end"
        data-testid="button-confirm"
      >
        <Button variant="secondary" className="max-md:h-11 max-md:w-full" onClick={onCancel}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          className="max-md:h-11 max-md:w-full"
          data-testid="button-confirm-run"
          onClick={onConfirm}
        >
          {confirm.confirm_label}
        </Button>
      </div>
    </Dialog>
  );
}
