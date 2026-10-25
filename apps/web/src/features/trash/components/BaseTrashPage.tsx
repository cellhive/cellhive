import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { ArchiveRestore, Table2, Trash2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { dashboardTrashQuery } from '../../../lib/query/dashboards';
import { keys } from '../../../lib/query/keys';
import { baseQuery, tablesQuery, tableTrashQuery } from '../../../lib/query/queries';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { DaysLeft, DeletedAt, DeletedBy, TABLE_CLASS, TD_CLASS, TH_CLASS } from './cells';
import { DashboardTrashList } from './DashboardTrashList';
import { EmptyState } from './EmptyState';
import { PurgeTableDialog } from './PurgeTableDialog';

import type { TrashedTableDto } from '@cellhive/contracts';

type BaseTrashTab = 'tables' | 'dashboards';
const TABS: readonly BaseTrashTab[] = ['tables', 'dashboards'];

/**
 * `/b/:baseId/trash` (T469, S4b decision #4; board "S4b · Thùng rác base,
 * xoá vĩnh viễn bảng"): the tables of the base in the trash, base admins
 * only (the route guard shows 404 to others). Each row: name and field
 * count, links from other tables, who deleted it and when, days left,
 * "Restore" and "Delete permanently" (typed-name confirmation). Records and
 * fields deleted from a live table stay in that table's trash. Other tabs
 * follow through `schema.changed` / `permission.changed` on `base:`.
 *
 * (T811, S7 decision #22) A second tab, "Dashboards" (`?tab=dashboards`):
 * deleted dashboards with "Restore".
 */
export function BaseTrashPage() {
  const { t, i18n } = useTranslation(['trash', 'common']);
  const format = useFormatters();
  const queryClient = useQueryClient();
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const trash = useQuery(tableTrashQuery(baseId));
  const tables = useQuery(tablesQuery(baseId));
  const [purging, setPurging] = useState<TrashedTableDto | null>(null);
  const dashboardTrash = useQuery(dashboardTrashQuery(baseId));
  const [params, setParams] = useSearchParams();
  const tab: BaseTrashTab = params.get('tab') === 'dashboards' ? 'dashboards' : 'tables';
  const tabRefs = useRef(new Map<BaseTrashTab, HTMLButtonElement>());
  useDocumentTitle(t('trash:tables.heading'));
  const now = new Date();
  const numbers = new Intl.NumberFormat(i18n.language);

  // The tables and the trash (same prefix); the base's new `permission_version` comes with
  // `permission.changed` on `base:` (a refetch here too would only add to a busy base).
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.tables(baseId) }, { cancelRefetch: false });

  const restore = useMutation({
    mutationFn: (table: TrashedTableDto) => api.tables.restore(table.id),
    onSuccess: async (restored) => {
      await refresh();
      showToast({
        variant: 'success',
        message: t('trash:tables.restored', { name: restored.name }),
      });
    },
    onError: async (error) => {
      showErrorToast(error);
      if (isApiError(error) && error.status === 404) await refresh();
    },
  });

  const purge = useMutation({
    mutationFn: ({ table, confirmName }: { table: TrashedTableDto; confirmName: string }) =>
      api.tables.purge(table.id, { confirm_name: confirmName }),
    onSuccess: async (purged) => {
      setPurging(null);
      await refresh();
      showToast({
        variant: 'success',
        message: t('trash:tables.purged', {
          name: purged.name,
          count: purged.record_count,
          formatted: numbers.format(purged.record_count),
        }),
      });
    },
    onError: async (error) => {
      if (isApiError(error) && error.status === 404) {
        setPurging(null);
        showErrorToast(error);
        await refresh();
      }
    },
  });

  const items = trash.data?.items ?? [];
  const counts: Record<BaseTrashTab, number | undefined> = {
    tables: trash.data === undefined ? undefined : items.length,
    dashboards: dashboardTrash.data?.items.length,
  };
  const select = (next: BaseTrashTab, focus = false) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'tables') updated.delete('tab');
        else updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );
    if (focus) tabRefs.current.get(next)?.focus();
  };
  // WAI-ARIA tabs: arrows, Home and End move between tabs (automatic activation).
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowLeft'
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : event.key === 'Home'
            ? TABS[0]
            : event.key === 'End'
              ? TABS[TABS.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    select(target, true);
  };
  let body;
  if (trash.isPending) {
    body = (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  } else if (trash.isError) {
    body = <ErrorAlert error={trash.error} />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon={<Table2 aria-hidden="true" className="size-6 text-fg-muted" />}
        title={t('trash:tables.empty.title')}
        description={t('trash:tables.empty.description')}
      />
    );
  } else {
    const actions = (table: TrashedTableDto) => {
      const restoring = restore.isPending && restore.variables.id === table.id;
      return (
        <span className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="max-lg:h-control"
            aria-label={t('trash:tables.restoreOne', { name: table.name })}
            disabled={restoring}
            onClick={() => {
              restore.mutate(table);
            }}
          >
            {restoring ? <Spinner /> : <ArchiveRestore aria-hidden="true" />}
            {t('trash:tables.restore')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger max-lg:h-control"
            aria-label={t('trash:tables.purgeOne', { name: table.name })}
            data-testid={`purge-table-${table.id}`}
            onClick={() => {
              purge.reset();
              setPurging(table);
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('trash:purge.action')}
          </Button>
        </span>
      );
    };
    const links = (table: TrashedTableDto) =>
      table.partner_fields.length === 0
        ? t('trash:tables.noLinks')
        : t('trash:tables.links', {
            count: table.partner_fields.length,
            formatted: numbers.format(table.partner_fields.length),
          });
    const nameCell = (table: TrashedTableDto) => (
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
          <Table2 aria-hidden="true" className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{table.name}</span>
          <span className="text-label font-normal text-fg-muted">
            {t('trash:tables.fieldCount', {
              count: table.field_count,
              formatted: numbers.format(table.field_count),
            })}
          </span>
        </span>
      </span>
    );
    body = (
      <>
        {/* Phones: one card per table (no sideways scrolling, 44 px buttons). */}
        <ul className="flex flex-col gap-3 sm:hidden" data-testid="table-trash-cards">
          {items.map((table) => (
            <li
              key={table.id}
              className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
            >
              {nameCell(table)}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label font-normal">
                <dt className="text-fg-muted">{t('trash:tables.linksColumn')}</dt>
                <dd>{links(table)}</dd>
                <dt className="text-fg-muted">{t('trash:records.deletedBy')}</dt>
                <dd>
                  <DeletedBy user={table.deleted_by} />
                </dd>
                <dt className="text-fg-muted">{t('trash:records.deletedAt')}</dt>
                <dd>{format.dateTime(table.deleted_at)}</dd>
                <dt className="text-fg-muted">{t('trash:records.daysLeft')}</dt>
                <dd>
                  <DaysLeft deletedAt={table.deleted_at} now={now} />
                </dd>
              </dl>
              {actions(table)}
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface sm:block">
          <table className={TABLE_CLASS} data-testid="table-trash">
            <caption className="sr-only">{t('trash:tables.caption')}</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>
                  {t('trash:tables.table')}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {t('trash:tables.linksColumn')}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {t('trash:records.deletedBy')}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {t('trash:records.deletedAt')}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {t('trash:records.daysLeft')}
                </th>
                <th scope="col" className={TH_CLASS}>
                  <span className="sr-only">{t('trash:records.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((table) => (
                <tr key={table.id} data-testid={`trashed-table-${table.id}`}>
                  <td className={TD_CLASS}>{nameCell(table)}</td>
                  <td
                    className={cn(
                      TD_CLASS,
                      table.partner_fields.length === 0 ? 'text-fg-muted' : 'text-fg',
                    )}
                  >
                    {links(table)}
                  </td>
                  <td className={TD_CLASS}>
                    <DeletedBy user={table.deleted_by} />
                  </td>
                  <td className={TD_CLASS}>
                    <DeletedAt value={table.deleted_at} now={now} />
                  </td>
                  <td className={TD_CLASS}>
                    <DaysLeft deletedAt={table.deleted_at} now={now} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>{actions(table)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(baseId)}`,
          label: t('trash:tables.back', { base: base.name }),
        }}
        icon={Trash2}
        title={t('trash:tables.heading')}
        subtitle={t(tab === 'tables' ? 'trash:tables.subtitle' : 'trash:dashboards.subtitle')}
      >
        <div
          role="tablist"
          aria-label={t('trash:tabs.label')}
          className="-mb-px flex gap-1"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((item) => (
            <button
              key={item}
              ref={(node) => {
                if (node === null) tabRefs.current.delete(item);
                else tabRefs.current.set(item, node);
              }}
              type="button"
              role="tab"
              id={`base-trash-tab-${item}`}
              aria-selected={tab === item}
              aria-controls={tab === item ? `base-trash-panel-${item}` : undefined}
              tabIndex={tab === item ? 0 : -1}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-3 py-2 font-medium',
                tab === item
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg',
              )}
              onClick={() => {
                select(item);
              }}
            >
              {t(`trash:${item}.tab`)}
              {counts[item] === undefined ? null : (
                <span
                  aria-hidden="true"
                  data-testid={
                    item === 'tables' ? 'base-trash-tab-count' : 'base-trash-dashboard-count'
                  }
                  className="font-normal text-fg-muted tabular-nums"
                >
                  {numbers.format(counts[item])}
                </span>
              )}
            </button>
          ))}
        </div>
      </PageHeading>
      <div
        role="tabpanel"
        id={`base-trash-panel-${tab}`}
        aria-labelledby={`base-trash-tab-${tab}`}
        className={cn('flex flex-col gap-3 py-6', PAGE_GUTTER)}
      >
        {tab === 'tables' ? (
          <>
            <p className="text-label font-normal text-fg-muted">{t('trash:tables.note')}</p>
            {body}
          </>
        ) : (
          <DashboardTrashList baseId={baseId} />
        )}
      </div>
      {purging === null ? null : (
        <PurgeTableDialog
          key={purging.id}
          baseId={baseId}
          table={purging}
          tables={tables.data?.items ?? []}
          pending={purge.isPending}
          error={purge.error}
          onCancel={() => {
            setPurging(null);
          }}
          onConfirm={(confirmName) => {
            purge.mutate({ table: purging, confirmName });
          }}
        />
      )}
    </div>
  );
}

export default BaseTrashPage;
