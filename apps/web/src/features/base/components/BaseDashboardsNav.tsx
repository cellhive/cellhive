import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, LayoutDashboard, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { lazy, Suspense, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router';

import { isBaseAdmin } from '../../../lib/permissions/access';
import { dashboardPath, dashboardsQuery, loadDashboardsApi } from '../../../lib/query/dashboards';
import { keys } from '../../../lib/query/keys';
import { baseQuery } from '../../../lib/query/queries';
import { showErrorToast } from '../../../lib/toast/toast';

import type { DashboardDialogRequest } from './DashboardDialog';

/** Create / rename / delete: one lazy chunk (with the `base` strings), loaded when opened. */
const DashboardDialog = lazy(() => import('./DashboardDialog'));

const ITEM_CLASS =
  'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken max-lg:min-h-control';

/**
 * (T811, S7 decisions #18, #22) The "Dashboards" group of the base sidebar:
 * the dashboards the caller can read (`GET /bases/:id/dashboards`, already
 * filtered by the server), each a link to `/b/:baseId/d/:dashboardId`. Base
 * admins and owners also get "New dashboard" and a "…" menu per dashboard
 * (rename, duplicate, delete → base trash). Members who see none get no
 * group at all. The menu is UX only: the API answers `403` to others.
 */
export function BaseDashboardsNav({ baseId }: { baseId: string }) {
  const { t } = useTranslation('common');
  const headingId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = useQuery(baseQuery(baseId));
  const list = useQuery(dashboardsQuery(baseId));
  const admin = base.data !== undefined && isBaseAdmin(base.data.access);
  const [dialog, setDialog] = useState<DashboardDialogRequest | null>(null);
  const items = list.data?.items ?? [];
  if (!admin && items.length === 0) return null;

  const duplicate = async (dashboardId: string) => {
    try {
      const copy = await (await loadDashboardsApi()).duplicate(dashboardId);
      await queryClient.invalidateQueries({ queryKey: keys.dashboards(baseId) });
      await navigate(dashboardPath(baseId, copy.id));
    } catch (error) {
      showErrorToast(error);
    }
  };

  return (
    <nav aria-labelledby={headingId} className="flex flex-col gap-1" data-testid="dashboards-nav">
      <div className="flex items-center justify-between gap-2 px-2">
        <h2 id={headingId} className="text-label text-fg-muted">
          {t('nav.dashboards')}
        </h2>
        {admin ? (
          <Tooltip content={t('nav.newDashboard')}>
            <button
              type="button"
              aria-label={t('nav.newDashboard')}
              data-testid="new-dashboard"
              className="flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-accent max-lg:size-control"
              onClick={() => {
                setDialog({ kind: 'create' });
              }}
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((dashboard) => (
          <li key={dashboard.id} className="group/dashboard relative flex">
            <NavLink
              to={dashboardPath(baseId, dashboard.id)}
              data-testid={`dashboard-link-${dashboard.id}`}
              className={({ isActive }) =>
                cn(
                  ITEM_CLASS,
                  isActive && 'bg-accent-soft font-medium text-accent',
                  admin && 'pr-9',
                )
              }
            >
              <LayoutDashboard aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>
            </NavLink>
            {admin ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t('nav.dashboardMenu', { name: dashboard.name })}
                  data-testid={`dashboard-menu-${dashboard.id}`}
                  className={cn(
                    'absolute top-1/2 right-0.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg',
                    'focus-visible:outline-2 focus-visible:outline-accent',
                    'max-lg:size-control max-lg:right-0',
                    'lg:opacity-0 lg:group-focus-within/dashboard:opacity-100 lg:group-hover/dashboard:opacity-100 lg:data-[state=open]:opacity-100',
                  )}
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => {
                      setDialog({ kind: 'rename', dashboard });
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    {t('nav.renameDashboard')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      void duplicate(dashboard.id);
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {t('nav.duplicateDashboard')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-danger [&_svg]:text-danger"
                    onSelect={() => {
                      setDialog({ kind: 'delete', dashboard });
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {t('nav.deleteDashboard')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </li>
        ))}
      </ul>
      {dialog === null ? null : (
        <Suspense fallback={null}>
          <DashboardDialog
            baseId={baseId}
            request={dialog}
            onClose={() => {
              setDialog(null);
            }}
          />
        </Suspense>
      )}
    </nav>
  );
}
