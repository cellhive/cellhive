import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isComputing } from '../../../grid/display/computed';
import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';
import { fieldTrashQuery } from '../../../lib/query/queries';
import {
  clearComputedProgress,
  progressOf,
  useComputedProgress,
} from '../../../lib/realtime/computed-progress';
import { expectOwnSchemaChange, retractOwnSchemaChange } from '../../../lib/realtime/own-changes';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { computedErrorDetails, retryOptionsOf, type ComputedErrorDetails } from './error-model';

import type { GridField, HeaderBadge, HeaderMenuAnchor } from '../../../grid';
import type { FieldDto } from '@cellhive/contracts';

/** A restored field comes back in the schema and the access of the base. */
const FIELD_SET_CHANGE = { schema: 1, permission: 1 } as const;
const FIELD_UPDATE = { schema: 1, permission: 0 } as const;

export interface ComputedErrorOpen {
  readonly fieldId: string;
  readonly anchor: HeaderMenuAnchor;
}

/**
 * Computed columns of the grid page (T468): the header badges (recompute
 * progress from `computed.recomputing`, field-level errors), the error
 * popover and its actions — restore a referenced field (`POST
 * /fields/:id/restore`), retry a `TIMEOUT` (`PATCH` with the definition
 * unchanged, CONTRACTS §13).
 */
export function useComputedColumns({
  tableId,
  baseId,
  columns,
  fields,
  canManage,
}: {
  readonly tableId: string;
  readonly baseId: string;
  /** Columns shown (for the badges). */
  readonly columns: readonly GridField[];
  /** Every live field of the table the user reads. */
  readonly fields: readonly FieldDto[];
  readonly canManage: boolean;
}) {
  const { t } = useTranslation('grid');
  const queryClient = useQueryClient();
  const progress = useComputedProgress();
  const [errorOpen, setErrorOpen] = useState<ComputedErrorOpen | null>(null);

  // A field back to `ready` forgets its last progress (the next job starts from 0 %).
  const settled = useMemo(
    () =>
      fields
        .filter(
          (field) =>
            (field.type === 'formula' || field.type === 'lookup') &&
            field.compute_state !== 'backfilling' &&
            field.compute_state !== 'recomputing',
        )
        .map((field) => field.id),
    [fields],
  );
  useEffect(() => {
    clearComputedProgress(settled);
  }, [settled]);

  const headerBadges = useMemo(() => {
    const badges = new Map<string, HeaderBadge>();
    for (const column of columns) {
      const computed = column.computed;
      if (computed === undefined) continue;
      if (computed.error !== null) {
        badges.set(column.field.id, {
          kind: 'error',
          open: errorOpen?.fieldId === column.field.id,
        });
      } else if (isComputing(computed)) {
        badges.set(column.field.id, {
          kind: 'progress',
          progress: progressOf(progress.get(column.field.id)),
        });
      }
    }
    return badges;
  }, [columns, progress, errorOpen]);

  const openField =
    errorOpen === null ? undefined : fields.find((field) => field.id === errorOpen.fieldId);
  const openColumn =
    errorOpen === null
      ? undefined
      : columns.find((column) => column.field.id === errorOpen.fieldId);
  const trash = useQuery({
    ...fieldTrashQuery(tableId),
    enabled: canManage && openField !== undefined,
  });
  const details: ComputedErrorDetails | null =
    openField === undefined || openColumn?.computed === undefined
      ? null
      : computedErrorDetails(openField, openColumn.computed, fields, trash.data?.items);

  const restore = useMutation({
    mutationFn: async (fieldId: string) => {
      expectOwnSchemaChange(tableId, FIELD_SET_CHANGE);
      try {
        return await api.fields.restore(fieldId);
      } catch (error) {
        retractOwnSchemaChange(tableId, FIELD_SET_CHANGE);
        throw error;
      }
    },
    onSuccess: async (restored) => {
      setErrorOpen(null);
      showToast({ variant: 'success', message: t('computed.restored', { name: restored.name }) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.table(tableId) }),
        queryClient.invalidateQueries({ queryKey: keys.base(baseId) }),
      ]);
    },
    onError: async (error) => {
      showErrorToast(error);
      if (isApiError(error) && error.status === 404) {
        await queryClient.invalidateQueries({ queryKey: keys.fieldTrash(tableId) });
      }
    },
  });

  const retry = useMutation({
    mutationFn: async (field: FieldDto) => {
      const options = retryOptionsOf(field);
      if (options === null) return;
      expectOwnSchemaChange(tableId, FIELD_UPDATE);
      try {
        await api.fields.update(field.id, { options });
      } catch (error) {
        retractOwnSchemaChange(tableId, FIELD_UPDATE);
        throw error;
      }
    },
    onSuccess: async () => {
      setErrorOpen(null);
      showToast({ variant: 'info', message: t('computed.retrying') });
      await queryClient.invalidateQueries({ queryKey: keys.table(tableId) });
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });

  return {
    headerBadges,
    errorOpen,
    openError: setErrorOpen,
    closeError: () => {
      setErrorOpen(null);
    },
    openField,
    details,
    busy: restore.isPending ? ('restore' as const) : retry.isPending ? ('retry' as const) : null,
    restore: (fieldId: string) => {
      restore.mutate(fieldId);
    },
    retry: () => {
      if (openField !== undefined) retry.mutate(openField);
    },
  };
}
