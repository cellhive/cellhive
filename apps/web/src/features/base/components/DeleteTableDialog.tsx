import { Button, Dialog, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { api } from '../../../lib/api';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { ComputedDependents } from '../../../lib/schema/ComputedDependents';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import type { TableDto, TableList } from '@cellhive/contracts';

export interface DeleteTableDialogProps {
  readonly baseId: string;
  readonly table: TableDto;
  readonly onClose: () => void;
}

function tablePath(baseId: string, tableId: string): string {
  return `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`;
}

/**
 * (T469, S4b decision #4; board "S4b · Đã xoá bảng, Hoàn tác") "Delete
 * table" of the sidebar, base admins only: the table goes to the base trash
 * for 30 days. The dialog names the formula/lookup fields of other tables
 * that will show `#REF!` (`GET /tables/:id/delete-preview`, T460; never
 * blocking); once deleted, a toast offers "Undo" (`POST
 * /tables/:id/restore`). Deleting the open table leaves it for the base.
 */
export function DeleteTableDialog({ baseId, table, onClose }: DeleteTableDialogProps) {
  const { t } = useTranslation(['base', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const preview = useQuery({
    queryKey: [...keys.table(table.id), 'delete-preview'] as const,
    queryFn: ({ signal }) => api.tables.deletePreview(table.id, signal),
    staleTime: 0,
    retry: false,
  });
  const path = tablePath(baseId, table.id);
  const onTable = location.pathname === path || location.pathname.startsWith(`${path}/`);

  // The tables and the trash (same prefix); the base's new `permission_version` comes with
  // `permission.changed` on `base:` (a refetch here too would only add to a busy base).
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.tables(baseId) }, { cancelRefetch: false });

  const restore = async () => {
    try {
      await api.tables.restore(table.id);
      await refresh();
      showToast({
        variant: 'success',
        message: t('base:deleteTable.restored', { name: table.name }),
      });
    } catch (error) {
      showErrorToast(error);
    }
  };

  const remove = useMutation({
    mutationFn: () => api.tables.remove(table.id),
    onSuccess: async () => {
      // Gone from the sidebar at once; the base route must not pick it as the first table.
      queryClient.setQueryData(keys.tables(baseId), (list: TableList | undefined) =>
        list === undefined
          ? list
          : {
              ...list,
              items: list.items.filter((item) => item.id !== table.id),
              total: Math.max(0, list.total - 1),
            },
      );
      // Out of the table while this dialog is still mounted (its screen would be a 404 now).
      if (onTable) await navigate(`/b/${encodeURIComponent(baseId)}`, { replace: true });
      onClose();
      await refresh();
      showToast({
        variant: 'success',
        message: t('base:deleteTable.done', { name: table.name }),
        actions: [
          {
            label: t('base:deleteTable.undo'),
            primary: true,
            onClick: () => {
              void restore();
            },
          },
        ],
      });
    },
  });

  const dependents = preview.data?.dependents.filter((item) => item.type === 'field') ?? [];
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={t('base:deleteTable.title', { name: table.name })}
      description={t('base:deleteTable.description')}
      closeLabel={t('common:actions.close')}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4" data-testid="delete-table-dialog">
        {preview.isPending ? (
          <Skeleton className="h-12" />
        ) : preview.isError ? null : (
          <ComputedDependents
            baseId={baseId}
            dependents={dependents.map((item) => ({
              id: item.id,
              table_id: item.table_id,
              name: item.name,
            }))}
            token="#REF!"
          />
        )}
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={remove.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            data-testid="delete-table-confirm"
            onClick={() => {
              remove.mutate();
            }}
          >
            {remove.isPending ? <Spinner /> : null}
            {t('base:deleteTable.submit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export default DeleteTableDialog;
