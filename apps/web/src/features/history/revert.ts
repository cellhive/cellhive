import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../lib/api';
import { isApiError } from '../../lib/api/client';
import { keys } from '../../lib/query/keys';
import { cachedRecord, forgetCachedRecord, putCachedRecord } from '../../lib/records/record-sync';
import { classifyWriteError } from '../../lib/records/write-errors';
import { showErrorToast, showToast } from '../../lib/toast/toast';

import type { TFunction } from 'i18next';

export interface RevertTarget {
  readonly tableId: string;
  readonly recordId: string;
}

/** The `version` a revert is checked against: the newest cached copy, else the server's. */
async function currentVersion(queryClient: QueryClient, target: RevertTarget): Promise<number> {
  const cached = cachedRecord(queryClient, target.tableId, target.recordId);
  if (cached !== undefined) return cached.version;
  const fresh = await api.records.get(target.tableId, target.recordId);
  putCachedRecord(queryClient, target.tableId, fresh);
  return fresh.version;
}

function refreshHistory(queryClient: QueryClient, recordId: string): void {
  // The prefix reaches the record's history and every cell history.
  void queryClient.invalidateQueries({ queryKey: keys.recordHistory(recordId) });
}

/**
 * "Restore previous value" of a history item (FRONTEND §10.3, CONTRACTS
 * §11.2): `POST …/revert` with the entry and the record `version` held
 * now. It is a new write through the server's normal checks:
 * - success: the record is put back everywhere, the history reloads (the
 *   revert is a new entry); linked records deleted since are not linked
 *   again, and the toast says how many (`skipped`, T465);
 * - `409 VERSION_CONFLICT`: the record changed since; the latest copy is
 *   loaded and a toast (as for cell conflicts, T203) offers to restore anyway;
 * - `404`: the entry or the record is gone for the user;
 * - `403` and anything else: translated error toast.
 */
export function useRevert(tableId: string, recordId: string) {
  const queryClient = useQueryClient();
  const target = useMemo(() => ({ tableId, recordId }), [tableId, recordId]);
  const { t } = useTranslation('history');
  const [pending, setPending] = useState<string | null>(null);

  const revert = useCallback(
    async (auditId: string): Promise<void> => {
      setPending(auditId);
      try {
        await runRevert(queryClient, target, auditId, t);
      } finally {
        setPending(null);
      }
    },
    [queryClient, target, t],
  );

  return { revert, pending };
}

async function runRevert(
  queryClient: QueryClient,
  target: RevertTarget,
  auditId: string,
  t: TFunction<'history'>,
  version?: number,
): Promise<void> {
  const { tableId, recordId } = target;
  try {
    const expected = version ?? (await currentVersion(queryClient, target));
    const record = await api.records.revert(tableId, recordId, {
      audit_id: auditId as `aud_${string}`,
      version: expected,
    });
    if (record === null) {
      // Written, but the record left what the user may read.
      forgetCachedRecord(queryClient, tableId, recordId);
      showToast({ message: t('revert.gone') });
    } else {
      // `skipped` (T465): linked records deleted since were not linked again.
      const { skipped, ...fresh } = record;
      putCachedRecord(queryClient, tableId, fresh);
      showToast({
        variant: 'success',
        message:
          skipped === undefined ? t('revert.done') : t('revert.doneSkipped', { count: skipped }),
      });
    }
    refreshHistory(queryClient, recordId);
  } catch (error) {
    await revertFailed(queryClient, target, auditId, t, error);
  }
}

async function revertFailed(
  queryClient: QueryClient,
  target: RevertTarget,
  auditId: string,
  t: TFunction<'history'>,
  error: unknown,
): Promise<void> {
  const { tableId, recordId } = target;
  const failure = classifyWriteError(error, '');
  if (failure.kind === 'conflict') {
    let fresh: number | undefined;
    try {
      const record = await api.records.get(tableId, recordId);
      putCachedRecord(queryClient, tableId, record);
      fresh = record.version;
    } catch (refetchError) {
      if (isApiError(refetchError) && refetchError.status === 404) {
        forgetCachedRecord(queryClient, tableId, recordId);
        showToast({ message: t('revert.gone') });
        return;
      }
    }
    refreshHistory(queryClient, recordId);
    showToast({
      variant: 'info',
      title: t('revert.conflict.title'),
      message: t('revert.conflict.message', {
        name: failure.updatedBy?.name ?? t('revert.conflict.someone'),
      }),
      actions: [
        { label: t('revert.conflict.keep'), onClick: () => undefined },
        {
          label: t('revert.conflict.restoreAnyway'),
          primary: true,
          onClick: () => {
            void runRevert(queryClient, target, auditId, t, fresh);
          },
        },
      ],
    });
    return;
  }
  if (failure.kind === 'not_found') {
    // The entry or the record is gone for the user (CONTRACTS §11.2).
    refreshHistory(queryClient, recordId);
    void queryClient.invalidateQueries({ queryKey: keys.record(tableId, recordId) });
    showToast({ message: t('revert.notFound') });
    return;
  }
  if (failure.kind === 'transient' || failure.kind === 'fatal') {
    showErrorToast(error, {
      actions: [
        {
          label: t('revert.retry'),
          onClick: () => {
            void runRevert(queryClient, target, auditId, t);
          },
        },
      ],
    });
    return;
  }
  // 403 (a field became read-only), 422, schema lock: explained by code.
  showErrorToast(error);
}
