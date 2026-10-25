import { Button, Dialog, Spinner } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { showToast } from '../../../lib/toast/toast';
import { useDeleteView } from '../mutations';

import type { ViewDto } from '@cellhive/contracts';

export interface DeleteViewDialogProps {
  readonly view: ViewDto;
  /** `deleted`: the view was deleted (the bar moves the focus to the next open view). */
  readonly onClose: (deleted?: boolean) => void;
}

/**
 * Confirmation before `DELETE /views/:id` (the records are not touched).
 * When it was the open view, the page opens another one (`TableViewPage`).
 */
export function DeleteViewDialog({ view, onClose }: DeleteViewDialogProps) {
  const { t } = useTranslation(['view', 'common']);
  const remove = useDeleteView(view.table_id);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('view:delete.title', { name: view.name })}
      description={t('view:delete.description')}
      closeLabel={t('common:actions.close')}
    >
      <div className="flex flex-col gap-4">
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              onClose();
            }}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(view.id, {
                onSuccess: () => {
                  showToast({
                    variant: 'success',
                    message: t('view:delete.done', { name: view.name }),
                  });
                  onClose(true);
                },
              });
            }}
          >
            {remove.isPending ? <Spinner /> : null}
            {t('view:delete.submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
