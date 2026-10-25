import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CircleAlert, Lock, Trash2, TrashIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { recordTreeApi } from '../../../lib/api/record-tree';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { translateDetail, translateError } from '../../../lib/errors/translate';
import { useFormatters, type Formatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { fieldsQuery, recordTrashQuery } from '../../../lib/query/queries';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import {
  purgeInChunks,
  restoreInChunks,
  type RestoreFailure,
  type RestoreOutcome,
} from '../restore';

import { DaysLeft, DeletedAt, DeletedBy, TABLE_CLASS, TD_CLASS, TH_CLASS } from './cells';
import { EmptyState } from './EmptyState';
import { PurgeDialog, type PurgeRequest } from './PurgeDialog';

import type { TrashedRecordDto } from '@cellhive/contracts';

export interface RecordTrashListProps {
  baseId: string;
  tableId: string;
  tableName: string;
  primaryFieldId: string;
  /** `lib/permissions` `canRestoreRecords`: the trash API refuses everyone else. */
  canRestore: boolean;
  /**
   * `lib/permissions` `canManageSchema`: "Delete permanently" (T408, BACKLOG
   * S4 open question #5); hidden for everyone else, whom the API refuses.
   */
  canPurge?: boolean;
}

/** Display text of a primary field value (JSON cell format), `null` when empty. */
function titleText(value: unknown, format: Formatters): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return format.number(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => titleText(item, format)).filter((item) => item !== null);
    return parts.length === 0 ? null : parts.join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' && name !== '' ? name : null;
  }
  return null;
}

function isAccessError(error: unknown): boolean {
  return isApiError(error) && (error.status === 403 || error.status === 404);
}

/**
 * Records tab of the trash (FRONTEND §10.4): newest deletion first, cursor
 * pages loaded while scrolling, multi-select and per-row restore. A record
 * the server refuses (`UNIQUE_VIOLATION`, gone from the trash…) keeps its
 * row with the reason; the others are restored.
 */
export function RecordTrashList(props: RecordTrashListProps) {
  const { t } = useTranslation('trash');
  if (!props.canRestore) {
    return (
      <EmptyState
        icon={<Lock aria-hidden="true" className="size-6 text-fg-muted" />}
        title={t('records.noAccess.title')}
        description={t('records.noAccess.description')}
      />
    );
  }
  return <RestorableRecords {...props} />;
}

function RestorableRecords({
  baseId,
  tableId,
  tableName,
  primaryFieldId,
  canPurge = false,
}: RecordTrashListProps) {
  const { t, i18n } = useTranslation('trash');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const trash = useInfiniteQuery(recordTrashQuery(tableId));
  // The code shown under each title: the first auto-number field (cached with the grid).
  const codeFieldId = useQuery({
    ...fieldsQuery(tableId),
    select: (list) =>
      list.items.find((field) => field.type === 'auto_number' && field.deleted_at === undefined)
        ?.id,
  }).data;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, RestoreFailure>>(new Map());
  const now = new Date();

  const rows: TrashedRecordDto[] = useMemo(
    () => trash.data?.pages.flatMap((page) => page.records) ?? [],
    [trash.data],
  );
  // Selection only ever covers rows still listed (restored rows leave it).
  const selectedIds = rows.filter((row) => selected.has(row.id)).map((row) => row.id);

  // Lost access (403/404) → the base access is stale: refetch it (FRONTEND §7).
  const accessLost = trash.isError && isAccessError(trash.error);
  useEffect(() => {
    if (accessLost) void queryClient.invalidateQueries({ queryKey: keys.base(baseId) });
  }, [accessLost, baseId, queryClient]);

  const restore = useMutation({
    mutationFn: (ids: readonly string[]) =>
      restoreInChunks(ids, (chunk) => api.records.restore(tableId, chunk)),
    onSuccess: async (outcome: RestoreOutcome, ids) => {
      setFailures((previous) => {
        const next = new Map(previous);
        for (const id of ids) next.delete(id);
        for (const [id, failure] of outcome.failed) next.set(id, failure);
        return next;
      });
      setSelected((previous) => {
        const next = new Set(previous);
        for (const id of outcome.restored) next.delete(id);
        return next;
      });
      if (outcome.restored.length > 0) {
        showToast({
          variant: 'success',
          message: t('records.restored', { count: outcome.restored.length }),
        });
      }
      const failed = [...outcome.failed.values()];
      const general = failed.find((failure) => failure.item === undefined);
      if (general !== undefined) {
        showErrorToast(general.error);
        if (isAccessError(general.error)) {
          void queryClient.invalidateQueries({ queryKey: keys.base(baseId) });
        }
      } else if (failed.length > 0) {
        showToast({ variant: 'error', message: t('records.failed', { count: failed.length }) });
      }
      // Restored rows come back in every grid block and leave the trash.
      await queryClient.invalidateQueries({ queryKey: keys.table(tableId) });
    },
  });
  const restoring = new Set(restore.isPending ? restore.variables : []);
  // "Restore branch" (T417): a record deleted with its sub-records comes back with them.
  const restoreBranch = useMutation({
    mutationFn: (id: string) => recordTreeApi.restoreBranch(tableId, [id]),
    onSuccess: async (response) => {
      showToast({
        variant: 'success',
        message: t('records.restored', { count: response.records.length }),
      });
      await queryClient.invalidateQueries({ queryKey: keys.table(tableId) });
    },
    onError: (error) => {
      showErrorToast(error);
    },
  });

  // "Delete permanently" (T408): confirmed first, in chunks of the bulk limit.
  const [purgeRequest, setPurgeRequest] = useState<PurgeRequest | null>(null);
  const [purgeKey, setPurgeKey] = useState(0);
  const askPurge = (ids: readonly string[]) => {
    const listed = rows.filter((row) => ids.includes(row.id));
    setPurgeKey((key) => key + 1);
    setPurgeRequest({
      ids,
      branchSize: listed.reduce((sum, row) => sum + (row.branch_size ?? 0), 0),
    });
  };
  const purge = useMutation({
    mutationFn: ({ ids, branch }: { ids: readonly string[]; branch: boolean }) =>
      purgeInChunks(ids, (chunk) => api.records.purge(tableId, chunk, branch)),
    onSuccess: async (purged) => {
      setPurgeRequest(null);
      setSelected((previous) => {
        const next = new Set(previous);
        for (const id of purged) next.delete(id);
        return next;
      });
      showToast({ variant: 'success', message: t('purge.done', { count: purged.length }) });
      await queryClient.invalidateQueries({ queryKey: keys.recordTrash(tableId) });
    },
    onError: async (error) => {
      setPurgeRequest(null);
      showErrorToast(error);
      if (isAccessError(error)) {
        await queryClient.invalidateQueries({ queryKey: keys.base(baseId) });
      }
      await queryClient.invalidateQueries({ queryKey: keys.recordTrash(tableId) });
    },
  });

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = trash;
  useEffect(() => {
    const node = sentinel.current;
    if (node === null || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const selectAll = useRef<HTMLInputElement>(null);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && !allSelected;
  useEffect(() => {
    if (selectAll.current !== null) selectAll.current.indeterminate = someSelected;
  }, [someSelected]);

  if (trash.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (trash.isError) return <ErrorAlert error={trash.error} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 aria-hidden="true" className="size-6 text-fg-muted" />}
        title={t('records.empty.title')}
        description={t('records.empty.description')}
      />
    );
  }

  const toggle = (id: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const failureText = (failure: RestoreFailure) =>
    failure.item === undefined
      ? translateError(failure.error, i18n).message
      : translateDetail(i18n, failure.item);

  return (
    <div className="flex flex-col gap-3">
      {selectedIds.length > 0 ? (
        <div
          role="region"
          aria-label={t('records.selected', { count: selectedIds.length })}
          className="flex flex-wrap items-center gap-3 rounded-lg bg-inverse px-3 py-2 text-on-inverse"
        >
          <span className="font-semibold" aria-live="polite">
            {t('records.selected', { count: selectedIds.length })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('records.restoreSelected')}
            disabled={restore.isPending}
            onClick={() => {
              restore.mutate(selectedIds);
            }}
          >
            {restore.isPending ? <Spinner /> : <ArchiveRestore aria-hidden="true" />}
            {t('records.restore')}
          </Button>
          {canPurge ? (
            <Button
              size="sm"
              variant="ghost"
              // Outlined on the dark bar (board "Thùng rác", T421b); the dialog confirms.
              className="border border-danger-on-inverse text-danger-on-inverse hover:bg-on-inverse/15"
              aria-label={t('purge.selected')}
              data-testid="purge-selected"
              disabled={purge.isPending}
              onClick={() => {
                askPurge(selectedIds);
              }}
            >
              <TrashIcon aria-hidden="true" />
              {t('purge.action')}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-on-inverse hover:bg-on-inverse/15"
            onClick={() => {
              setSelected(new Set());
            }}
          >
            {t('records.clearSelection')}
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className={TABLE_CLASS}>
          <caption className="sr-only">{t('records.caption', { table: tableName })}</caption>
          <thead>
            <tr>
              <th scope="col" className={`${TH_CLASS} w-10`}>
                <input
                  ref={selectAll}
                  type="checkbox"
                  className="size-4 accent-accent"
                  aria-label={t('records.selectAll')}
                  checked={allSelected}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked ? new Set(rows.map((row) => row.id)) : new Set(),
                    );
                  }}
                />
              </th>
              <th scope="col" className={TH_CLASS}>
                {t('records.record')}
              </th>
              <th scope="col" className={TH_CLASS}>
                {t('records.deletedBy')}
              </th>
              <th scope="col" className={TH_CLASS}>
                {t('records.deletedAt')}
              </th>
              <th scope="col" className={TH_CLASS}>
                {t('records.daysLeft')}
              </th>
              <th scope="col" className={TH_CLASS}>
                <span className="sr-only">{t('records.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const title = titleText(row.fields[primaryFieldId], format) ?? t('records.untitled');
              const code =
                codeFieldId === undefined ? null : titleText(row.fields[codeFieldId], format);
              const failure = failures.get(row.id);
              const errorId = `trash-error-${row.id}`;
              return (
                <tr key={row.id} className={selected.has(row.id) ? 'bg-accent-soft/50' : ''}>
                  <td className={TD_CLASS}>
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      aria-label={t('records.select', { title })}
                      checked={selected.has(row.id)}
                      onChange={(event) => {
                        toggle(row.id, event.target.checked);
                      }}
                    />
                  </td>
                  <td className={TD_CLASS}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">
                        {title}
                        {row.branch_size === undefined ? null : (
                          <span className="ml-2 text-label font-normal text-fg-muted">
                            {t('records.branchSize', { count: row.branch_size })}
                          </span>
                        )}
                      </span>
                      {/* The record's code (first auto-number field), not its internal id. */}
                      {code === null ? null : (
                        <span className="font-mono text-mono text-fg-muted">{code}</span>
                      )}
                      {failure === undefined ? null : (
                        <span
                          id={errorId}
                          className="mt-1 flex items-start gap-1 text-label font-normal text-danger"
                        >
                          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                          {t('records.notRestored', { message: failureText(failure) })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={TD_CLASS}>
                    <DeletedBy user={row.deleted_by} />
                  </td>
                  <td className={TD_CLASS}>
                    <DeletedAt value={row.deleted_at} now={now} />
                  </td>
                  <td className={TD_CLASS}>
                    <DaysLeft deletedAt={row.deleted_at} now={now} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <div className="flex flex-wrap justify-end gap-2">
                      {row.branch_size === undefined ? null : (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={t('records.restoreBranchOne', { title })}
                          disabled={restoreBranch.isPending || restoring.has(row.id)}
                          data-testid="restore-branch"
                          onClick={() => {
                            restoreBranch.mutate(row.id);
                          }}
                        >
                          {restoreBranch.isPending && restoreBranch.variables === row.id ? (
                            <Spinner />
                          ) : (
                            <ArchiveRestore aria-hidden="true" />
                          )}
                          {t('records.restoreBranch')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={t('records.restoreOne', { title })}
                        aria-describedby={failure === undefined ? undefined : errorId}
                        disabled={restoring.has(row.id)}
                        onClick={() => {
                          restore.mutate([row.id]);
                        }}
                      >
                        {restoring.has(row.id) ? (
                          <Spinner />
                        ) : (
                          <ArchiveRestore aria-hidden="true" />
                        )}
                        {t('records.restore')}
                      </Button>
                      {canPurge ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:bg-danger/10"
                          aria-label={t('purge.one', { title })}
                          data-testid="purge-one"
                          disabled={purge.isPending || restoring.has(row.id)}
                          onClick={() => {
                            askPurge([row.id]);
                          }}
                        >
                          <TrashIcon aria-hidden="true" />
                          {t('purge.action')}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <PurgeDialog
        key={purgeKey}
        request={purgeRequest}
        pending={purge.isPending}
        onCancel={() => {
          setPurgeRequest(null);
        }}
        onConfirm={(branch) => {
          if (purgeRequest !== null) purge.mutate({ ids: purgeRequest.ids, branch });
        }}
      />
      {hasNextPage ? (
        <div ref={sentinel} className="flex justify-center">
          <Button
            variant="secondary"
            disabled={isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
            }}
          >
            {isFetchingNextPage ? <Spinner /> : null}
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
