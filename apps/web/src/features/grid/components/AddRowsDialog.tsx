import { Button, Dialog } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import type { AddRowsRequest } from '../bulk/use-grid-clipboard';

/**
 * "Add N new rows?" when a paste goes past the last row (FRONTEND §4.2).
 * Cancelling pastes only what fits in the existing rows.
 */
export function AddRowsDialog({ request }: { readonly request: AddRowsRequest | null }) {
  const { t, i18n } = useTranslation('grid');
  const count = request?.count ?? 0;
  const formatted = count.toLocaleString(i18n.language);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) request?.answer(false);
      }}
      title={t('clipboard.addRowsTitle', { count, formatted })}
      description={t('clipboard.addRowsDescription', { count, formatted })}
      closeLabel={t('actions.cancel')}
    >
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            request?.answer(false);
          }}
        >
          {t('clipboard.addRowsNo')}
        </Button>
        <Button
          onClick={() => {
            request?.answer(true);
          }}
        >
          {t('clipboard.addRowsYes', { count, formatted })}
        </Button>
      </div>
    </Dialog>
  );
}
