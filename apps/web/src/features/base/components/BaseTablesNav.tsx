import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
} from '@cellhive/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { MoreHorizontal, Settings, Table2, Trash2 } from 'lucide-react';
import { lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';

import { isBaseAdmin } from '../../../lib/permissions/access';
import {
  baseQuery,
  tableRecordCountQuery,
  tablesQuery,
  tableTrashQuery,
} from '../../../lib/query/queries';

import { BaseDashboardsNav } from './BaseDashboardsNav';

import type { TableDto } from '@cellhive/contracts';

/**
 * (T469) Confirmation of "Delete table": its own chunk (with the `base`
 * strings), loaded when a base admin opens it — the sidebar is part of the
 * app shell (FRONTEND §11.1).
 */
const DeleteTableDialog = lazy(() => import('./DeleteTableDialog'));

/** Tables whose record count the sidebar asks for (one small count request each). */
export const COUNTED_TABLES = 50;

function tablePath(baseId: string, tableId: string): string {
  return `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`;
}

/**
 * The tables of the open base in the sidebar (T320b, design "Grid -
 * Tickets"), with their record counts. The base's name is not repeated here
 * (T322a): the workspace tree below marks the open base and the table
 * header shows "base › table". The tables used to be tabs
 * under the table name; the views are the tabs now (like Lark: tables on
 * the left, views as tabs). The count is what the user reads (read rule,
 * no view), "~" when only estimated; it is decorative (the link's name is
 * the table's), the footer of the grid says it too.
 *
 * (T469, S4b decision #4) Base admins get a "…" menu per table ("Delete
 * table") and, at the bottom of the list, the base trash with the number of
 * deleted tables (`/b/:baseId/trash`).
 *
 * (T520) `extra`: entries of other features under the tables, before the
 * trash (the automation list): `<li>` elements given by the app shell —
 * features do not import each other (FRONTEND §1.2).
 *
 * (T811) The "Dashboards" group follows the tables (`BaseDashboardsNav`).
 */
export function BaseTablesNav({ baseId, extra }: { baseId: string; extra?: ReactNode }) {
  const { t, i18n } = useTranslation('common');
  const headingId = useId();
  const tables = useQuery(tablesQuery(baseId));
  const base = useQuery(baseQuery(baseId));
  const admin = base.data !== undefined && isBaseAdmin(base.data.access);
  const trash = useQuery({ ...tableTrashQuery(baseId), enabled: admin });
  const [deleting, setDeleting] = useState<TableDto | null>(null);
  const items: readonly TableDto[] = tables.data?.items ?? [];
  // The UI language's digits (not `useFormatters`: it would put the formatters
  // in a chunk shared with the public share page, `.size-limit.js`).
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const counts = useQueries({
    queries: items.slice(0, COUNTED_TABLES).map((table) => tableRecordCountQuery(table.id)),
  });
  const trashed = trash.data?.items.length;
  return (
    <>
      <nav aria-labelledby={headingId} className="flex flex-col gap-1">
        <h2 id={headingId} className="px-2 text-label text-fg-muted">
          {t('nav.tables')}
        </h2>
        {tables.isPending ? (
          <div className="flex flex-col gap-2 px-2">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : tables.isError ? (
          <p className="px-2 text-label font-normal text-fg-muted">{t('nav.loadFailed')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((table, index) => {
              const count = counts[index]?.data;
              return (
                <li key={table.id} className="group/table relative flex">
                  <NavLink
                    to={tablePath(baseId, table.id)}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken',
                        isActive && 'bg-accent-soft font-medium text-accent',
                        admin && 'pr-9',
                      )
                    }
                  >
                    <Table2 aria-hidden="true" className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{table.name}</span>
                    {count === undefined ? null : (
                      <span
                        aria-hidden="true"
                        data-testid={`table-count-${table.id}`}
                        className={cn(
                          'shrink-0 text-label font-normal text-fg-muted tabular-nums',
                          // The menu button takes the count's place on hover/focus.
                          admin &&
                            'lg:group-focus-within/table:invisible lg:group-hover/table:invisible',
                        )}
                      >
                        {count.estimated ? '~' : ''}
                        {numbers.format(count.count)}
                      </span>
                    )}
                  </NavLink>
                  {admin ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={t('nav.tableMenu', { table: table.name })}
                        data-testid={`table-menu-${table.id}`}
                        className={cn(
                          'absolute top-1/2 right-0.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg',
                          'focus-visible:outline-2 focus-visible:outline-accent',
                          // Touch screens have no hover: always there (44 px target).
                          'max-lg:size-control max-lg:right-0',
                          'lg:opacity-0 lg:group-focus-within/table:opacity-100 lg:group-hover/table:opacity-100 lg:data-[state=open]:opacity-100',
                        )}
                      >
                        <MoreHorizontal aria-hidden="true" className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          className="text-danger [&_svg]:text-danger"
                          onSelect={() => {
                            setDeleting(table);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          {t('nav.deleteTable')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </li>
              );
            })}
            {admin || extra !== undefined ? (
              <li className="mt-1 border-t border-line pt-1">
                <ul className="flex flex-col gap-0.5">
                  {extra}
                  {admin ? (
                    // T712: the base settings (members, roles, share links, webhooks — T611's
                    // entry moved into its nav), base admins only like the route guard.
                    <li className="flex">
                      <NavLink
                        to={`/b/${encodeURIComponent(baseId)}/settings`}
                        data-testid="base-settings-link"
                        className={({ isActive }) =>
                          cn(
                            'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg hover:bg-surface-sunken max-lg:min-h-control',
                            isActive && 'bg-accent-soft font-medium text-accent',
                          )
                        }
                      >
                        <Settings aria-hidden="true" className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t('nav.baseSettings')}</span>
                      </NavLink>
                    </li>
                  ) : null}
                  {admin ? (
                    <li className="flex">
                      <NavLink
                        to={`/b/${encodeURIComponent(baseId)}/trash`}
                        data-testid="base-trash-link"
                        className={({ isActive }) =>
                          cn(
                            'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-body text-fg-muted hover:bg-surface-sunken hover:text-fg max-lg:min-h-control',
                            isActive && 'bg-accent-soft font-medium text-accent',
                          )
                        }
                      >
                        <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{t('nav.trash')}</span>
                        {trashed === undefined || trashed === 0 ? null : (
                          <span
                            aria-hidden="true"
                            data-testid="base-trash-count"
                            className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
                          >
                            {numbers.format(trashed)}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ) : null}
                </ul>
              </li>
            ) : null}
          </ul>
        )}
        {deleting === null ? null : (
          <Suspense fallback={null}>
            <DeleteTableDialog
              baseId={baseId}
              table={deleting}
              onClose={() => {
                setDeleting(null);
              }}
            />
          </Suspense>
        )}
      </nav>
      {/* T811: the base's dashboards, a group of their own under the tables. */}
      <BaseDashboardsNav baseId={baseId} />
    </>
  );
}
