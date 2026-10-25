import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { isApiError } from '../../../lib/api/client';
import { dashboardsApi } from '../../../lib/api/dashboards';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { dashboardPath, dashboardTrashQuery } from '../../../lib/query/dashboards';
import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import { DaysLeft, DeletedAt, DeletedBy, TABLE_CLASS, TD_CLASS, TH_CLASS } from './cells';
import { EmptyState } from './EmptyState';

import type { TrashedDashboardDto } from '@cellhive/contracts';

/**
 * (T811, S7 decision #22) The "Dashboards" tab of the base trash: deleted
 * dashboards (with their widgets) for 30 days, base admins only. "Restore"
 * puts one back at the end of the sidebar list (`POST
 * /dashboards/:id/restore`); a name taken meanwhile is `409 NAME_CONFLICT`,
 * a full base `422 DASHBOARD_LIMIT_EXCEEDED` — both shown in a toast.
 */
export function DashboardTrashList({ baseId }: { baseId: string }) {
  const { t, i18n } = useTranslation(['trash', 'common']);
  const format = useFormatters();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const trash = useQuery(dashboardTrashQuery(baseId));
  const now = new Date();
  const numbers = new Intl.NumberFormat(i18n.language);
  // The list and the trash share a prefix.
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.dashboards(baseId) });

  const restore = useMutation({
    mutationFn: (dashboard: TrashedDashboardDto) => dashboardsApi.restore(dashboard.id),
    onSuccess: async (restored) => {
      await refresh();
      showToast({
        variant: 'success',
        message: t('trash:dashboards.restored', { name: restored.name }),
        actions: [
          {
            label: t('trash:dashboards.open'),
            onClick: () => {
              void navigate(dashboardPath(baseId, restored.id));
            },
          },
        ],
      });
    },
    onError: async (error) => {
      showErrorToast(error);
      if (isApiError(error) && error.status === 404) await refresh();
    },
  });

  if (trash.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (trash.isError) return <ErrorAlert error={trash.error} />;
  const items = trash.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<LayoutDashboard aria-hidden="true" className="size-6 text-fg-muted" />}
        title={t('trash:dashboards.empty.title')}
        description={t('trash:dashboards.empty.description')}
      />
    );
  }

  const action = (dashboard: TrashedDashboardDto) => {
    const restoring = restore.isPending && restore.variables.id === dashboard.id;
    return (
      <Button
        size="sm"
        variant="secondary"
        className="max-lg:h-control"
        aria-label={t('trash:dashboards.restoreOne', { name: dashboard.name })}
        data-testid={`restore-dashboard-${dashboard.id}`}
        disabled={restoring}
        onClick={() => {
          restore.mutate(dashboard);
        }}
      >
        {restoring ? <Spinner /> : <ArchiveRestore aria-hidden="true" />}
        {t('trash:tables.restore')}
      </Button>
    );
  };
  const nameCell = (dashboard: TrashedDashboardDto) => (
    <span className="flex min-w-0 items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
        <LayoutDashboard aria-hidden="true" className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{dashboard.name}</span>
        <span className="text-label font-normal text-fg-muted">
          {t('trash:dashboards.widgetCount', {
            count: dashboard.widget_count,
            formatted: numbers.format(dashboard.widget_count),
          })}
        </span>
      </span>
    </span>
  );

  return (
    <>
      <ul className="flex flex-col gap-3 sm:hidden" data-testid="dashboard-trash-cards">
        {items.map((dashboard) => (
          <li
            key={dashboard.id}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          >
            {nameCell(dashboard)}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label font-normal">
              <dt className="text-fg-muted">{t('trash:records.deletedBy')}</dt>
              <dd>
                <DeletedBy user={dashboard.deleted_by} />
              </dd>
              <dt className="text-fg-muted">{t('trash:records.deletedAt')}</dt>
              <dd>{format.dateTime(dashboard.deleted_at)}</dd>
              <dt className="text-fg-muted">{t('trash:records.daysLeft')}</dt>
              <dd>
                <DaysLeft deletedAt={dashboard.deleted_at} now={now} />
              </dd>
            </dl>
            <span className="flex justify-end">{action(dashboard)}</span>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface sm:block">
        <table className={TABLE_CLASS} data-testid="dashboard-trash">
          <caption className="sr-only">{t('trash:dashboards.caption')}</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                {t('trash:dashboards.dashboard')}
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
            {items.map((dashboard) => (
              <tr key={dashboard.id} data-testid={`trashed-dashboard-${dashboard.id}`}>
                <td className={TD_CLASS}>{nameCell(dashboard)}</td>
                <td className={TD_CLASS}>
                  <DeletedBy user={dashboard.deleted_by} />
                </td>
                <td className={TD_CLASS}>
                  <DeletedAt value={dashboard.deleted_at} now={now} />
                </td>
                <td className={TD_CLASS}>
                  <DaysLeft deletedAt={dashboard.deleted_at} now={now} />
                </td>
                <td className={`${TD_CLASS} text-right`}>{action(dashboard)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
