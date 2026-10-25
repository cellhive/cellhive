import { Button, Dialog, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { showToast } from '../../../lib/toast/toast';
import { DependentsList } from '../convert/parts';
import { useDeleteField } from '../mutations';

import type { FieldDto, TableDto } from '@cellhive/contracts';

export interface DeleteFieldDialogProps {
  readonly tableId: string;
  readonly field: FieldDto;
  readonly onClose: () => void;
}

/**
 * Confirmation before `DELETE /fields/:id`: the field goes to the trash of
 * the table for 30 days (ADR-0023). The primary field cannot be deleted —
 * the menu does not offer it and the server answers
 * `PRIMARY_FIELD_NOT_DELETABLE` anyway. (T469) What stops working is
 * listed first (`GET /fields/:id/delete-preview`, T460): views and roles
 * using it, and the formula/lookup fields whose cells will show `#REF!`
 * (never blocking: restoring the field heals them).
 */
export function DeleteFieldDialog({ tableId, field, onClose }: DeleteFieldDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const remove = useDeleteField(tableId);
  const queryClient = useQueryClient();
  const baseId = queryClient.getQueryData<TableDto>(keys.tableMeta(tableId))?.base_id;
  const preview = useQuery({
    queryKey: ['field', field.id, 'delete-preview'] as const,
    queryFn: ({ signal }) => api.fields.deletePreview(field.id, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const dependents = preview.data?.dependents ?? [];
  return (
    <Dialog
      open
      role={dependents.length > 0 ? 'alertdialog' : 'dialog'}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('field:delete.title', { name: field.name })}
      description={t('field:delete.description')}
      closeLabel={t('common:actions.close')}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4" data-testid="delete-field-dialog">
        {preview.isPending ? (
          <Skeleton className="h-12" />
        ) : (
          <DependentsList
            dependents={dependents}
            tableId={tableId}
            baseId={baseId}
            title={t('field:convert.dependents.title')}
            computedToken="#REF!"
          />
        )}
        {dependents.some((item) => item.type === 'field') ? (
          <p className="text-label font-normal text-fg-muted">{t('field:delete.restoreHeals')}</p>
        ) : null}
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending || field.is_primary}
            data-testid="delete-field-confirm"
            onClick={() => {
              remove.mutate(field.id, {
                onSuccess: () => {
                  showToast({
                    variant: 'success',
                    message: t('field:delete.done', { name: field.name }),
                  });
                  onClose();
                },
              });
            }}
          >
            {remove.isPending ? <Spinner /> : null}
            {t('field:delete.submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
