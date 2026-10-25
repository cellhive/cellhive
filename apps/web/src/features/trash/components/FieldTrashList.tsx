import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, Columns3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { fieldTrashQuery } from '../../../lib/query/queries';
import { expectOwnSchemaChange, retractOwnSchemaChange } from '../../../lib/realtime/own-changes';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { DaysLeft, DeletedAt, TABLE_CLASS, TD_CLASS, TH_CLASS } from './cells';
import { EmptyState } from './EmptyState';

import type { FieldDto } from '@cellhive/contracts';

type DeletedField = FieldDto & { deleted_at: string };

export function isDeleted(field: FieldDto): field is DeletedField {
  return field.deleted_at !== undefined;
}

/**
 * Restoring a field bumps `permission_version` and causes one
 * `schema.changed` on `table:{id}` plus one `permission.changed` on the base
 * (same as creating or deleting a field, `field/mutations.ts`). Announcing
 * it here too keeps the realtime channel from refetching what this
 * mutation's own `onSuccess` already refetched (`lib/realtime/own-changes.ts`).
 */
const FIELD_RESTORE_CHANGE = { schema: 1, permission: 1 } as const;

/**
 * Fields tab of the trash (schema managers only): fields deleted less than
 * 30 days ago, restored with their data by `POST /fields/:id/restore`.
 */
export function FieldTrashList({
  baseId,
  tableId,
  tableName,
}: {
  baseId: string;
  tableId: string;
  tableName: string;
}) {
  const { t } = useTranslation('trash');
  const queryClient = useQueryClient();
  const fields = useQuery({
    ...fieldTrashQuery(tableId),
    select: (list) => list.items.filter(isDeleted),
  });
  const now = new Date();

  const restore = useMutation({
    mutationFn: async (field: DeletedField) => {
      expectOwnSchemaChange(tableId, FIELD_RESTORE_CHANGE);
      try {
        return await api.fields.restore(field.id);
      } catch (error) {
        retractOwnSchemaChange(tableId, FIELD_RESTORE_CHANGE);
        throw error;
      }
    },
    onSuccess: async (restored) => {
      showToast({ variant: 'success', message: t('fields.restored', { name: restored.name }) });
      // The field is back in the schema, the records and the access of the base.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.table(tableId) }),
        queryClient.invalidateQueries({ queryKey: keys.base(baseId) }),
      ]);
    },
    onError: async (error, field) => {
      if (isApiError(error) && error.status === 404) {
        // Expired, purged, or no schema rights any more.
        showToast({ variant: 'error', message: t('fields.expired', { name: field.name }) });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.fieldTrash(tableId) }),
          queryClient.invalidateQueries({ queryKey: keys.base(baseId) }),
        ]);
        return;
      }
      showErrorToast(error);
    },
  });

  if (fields.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (fields.isError) return <ErrorAlert error={fields.error} />;
  if (fields.data.length === 0) {
    return (
      <EmptyState
        icon={<Columns3 aria-hidden="true" className="size-6 text-fg-muted" />}
        title={t('fields.empty.title')}
        description={t('fields.empty.description')}
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={TABLE_CLASS}>
        <caption className="sr-only">{t('fields.caption', { table: tableName })}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASS}>
              {t('fields.field')}
            </th>
            <th scope="col" className={TH_CLASS}>
              {t('fields.deletedAt')}
            </th>
            <th scope="col" className={TH_CLASS}>
              {t('fields.daysLeft')}
            </th>
            <th scope="col" className={TH_CLASS}>
              <span className="sr-only">{t('fields.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.data.map((field) => {
            const busy = restore.isPending && restore.variables.id === field.id;
            return (
              <tr key={field.id}>
                <td className={TD_CLASS}>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{field.name}</span>
                    <span className="font-mono text-label font-normal text-fg-muted">
                      {field.id}
                    </span>
                  </div>
                </td>
                <td className={TD_CLASS}>
                  <DeletedAt value={field.deleted_at} now={now} />
                </td>
                <td className={TD_CLASS}>
                  <DaysLeft deletedAt={field.deleted_at} now={now} />
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={t('fields.restoreOne', { name: field.name })}
                    disabled={busy}
                    onClick={() => {
                      restore.mutate(field);
                    }}
                  >
                    {busy ? <Spinner /> : <ArchiveRestore aria-hidden="true" />}
                    {t('fields.restore')}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
