import { Tooltip } from '@cellhive/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ChevronRight, Trash2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { PageHeader } from '../../../lib/layout/page-header';
import { canManageSchema, canRestoreRecords } from '../../../lib/permissions/access';
import { lastViewPreferenceKey, preferenceUser, writePreference } from '../../../lib/preferences';
import { baseQuery, tableQuery, viewsQuery } from '../../../lib/query/queries';
import { showToast } from '../../../lib/toast/toast';
import { useLinkedFilterParam } from '../../../lib/views/linked-filter';
import { takeDeletedHere } from '../deleted';
import { fallbackViewId } from '../names';

import { NoViews } from './NoViews';
import { ViewBar } from './ViewBar';
import { ViewPlaceholder } from './ViewPlaceholder';

import type { BaseDetail, TableDto, ViewDto } from '@cellhive/contracts';

export interface TableViewPageProps {
  /**
   * The grid of a grid view (`features/grid`), given by the route: features
   * do not import each other (FRONTEND §1.2).
   */
  readonly renderGrid: (view: ViewDto) => ReactNode;
  /** The board of a kanban view (`features/kanban`, T314), given by the route likewise. */
  readonly renderKanban?: ((view: ViewDto) => ReactNode) | undefined;
  /** The builder / fill page of a form view (`features/form`, T315), given by the route likewise. */
  readonly renderForm?: ((view: ViewDto) => ReactNode) | undefined;
  /** Actions of the open view shown in the view bar ("Share", T316), given by the route. */
  readonly renderViewActions?: (view: ViewDto, base: BaseDetail) => ReactNode;
  /** Actions of the table in its header (import, T318), given by the route likewise. */
  readonly renderTableActions?: ((table: TableDto) => ReactNode) | undefined;
}

/**
 * `/b/:baseId/t/:tableId/v/:viewId` (FRONTEND §2): the table header (in the
 * shell's top bar), its views, and the open view — the grid, the kanban board (T314) or the
 * form (T315); a placeholder when the route gives no screen for its type. On `/b/:baseId/t/:tableId` (reached only when the
 * user sees no view of a table they read) it offers a personal view. The route guard has loaded the base, table, fields
 * and views and answered 404 for a view the user cannot see. When the open
 * view disappears (deleted, hidden by a role change) the first remaining
 * view opens, with a notice unless this tab deleted it.
 */
export function TableViewPage({
  renderGrid,
  renderKanban,
  renderForm,
  renderViewActions,
  renderTableActions,
}: TableViewPageProps) {
  const { t } = useTranslation(['view', 'grid']);
  const { baseId = '', tableId = '', viewId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const { data: table } = useSuspenseQuery(tableQuery(tableId));
  const { data: views } = useSuspenseQuery(viewsQuery(tableId));
  const view = views.items.find((item) => item.id === viewId);
  const navigate = useNavigate();
  const { search } = useLocation();
  useDocumentTitle(view === undefined ? table.name : `${view.name} · ${table.name}`);
  // "View all" of an embedded sub-table (T416): `?linked=` becomes a temporary filter.
  useLinkedFilterParam(view);

  useEffect(() => {
    const userId = preferenceUser();
    if (view !== undefined && userId !== null) {
      writePreference(lastViewPreferenceKey(userId, tableId), view.id);
    }
  }, [tableId, view]);

  const handledGone = useRef<string | null>(null);
  // `/b/:baseId/t/:tableId` renders here only when the user sees no view at all.
  const gone = view === undefined && viewId !== '';
  useEffect(() => {
    if (!gone || handledGone.current === viewId) return;
    handledGone.current = viewId;
    if (!takeDeletedHere(viewId)) showToast({ message: t('view:gone') });
    const next = fallbackViewId(views.items, viewId);
    const tablePath = `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`;
    // No view left for this user: the table's "no view" screen.
    const path = next === undefined ? tablePath : `${tablePath}/v/${encodeURIComponent(next)}`;
    // `?record=` stays: the record belongs to the table, not to the view.
    void navigate(`${path}${search}`, { replace: true });
  }, [gone, viewId, views.items, baseId, tableId, search, navigate, t]);

  return (
    // `relative overflow-x-clip`: nothing of a view (e.g. a screen-reader-only text far
    // right in the kanban board) widens the page; views scroll in their own containers.
    <div className="relative flex h-[calc(100dvh-3.25rem)] min-h-80 flex-col overflow-x-clip">
      {/*
        T320b (design "Grid - Tickets"): the table's name, description and
        actions live in the shell's top bar; the tables are in the sidebar.
      */}
      <PageHeader>
        {/* Breadcrumb "base › table" (design); phones keep the table only. */}
        <nav aria-label={t('view:breadcrumb')} className="max-w-[60%] min-w-0 shrink-0">
          <ol className="flex min-w-0 items-center gap-1.5">
            <li className="flex min-w-0 shrink items-center gap-1.5 max-sm:hidden">
              <span data-testid="breadcrumb-base" className="truncate text-body text-fg-muted">
                {base.name}
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
            </li>
            <li aria-current="page" className="min-w-0">
              <h1 className="truncate text-heading">{table.name}</h1>
            </li>
          </ol>
        </nav>
        {table.description === null || table.description === '' ? null : (
          <p className="hidden min-w-0 truncate text-body text-fg-muted md:block">
            {table.description}
          </p>
        )}
        {/* Touch-sized screens: 44 px targets (T322a). */}
        <div className="ml-auto flex shrink-0 items-center gap-1 max-lg:[&_button]:h-control max-lg:[&_button]:min-w-control max-sm:[&_button]:gap-0 max-sm:[&_button]:text-[0px]">
          {renderTableActions?.(table)}
          {/* The trash (T208) is for those who can restore records or fields there. */}
          {canRestoreRecords(base.access, tableId) || canManageSchema(base.access, tableId) ? (
            <Tooltip content={t('grid:trashOf', { table: table.name })}>
              <Link
                to={`/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}/trash`}
                aria-label={t('grid:trashOf', { table: table.name })}
                className="inline-flex h-control min-w-control items-center justify-center gap-1.5 rounded-md px-2 text-body text-fg-muted hover:bg-surface-sunken hover:text-fg"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                <span className="hidden xl:inline">{t('grid:trash')}</span>
              </Link>
            </Tooltip>
          ) : null}
        </div>
      </PageHeader>
      {viewId === '' ? <NoViews baseId={baseId} tableId={tableId} /> : null}
      {view === undefined ? null : (
        <>
          <ViewBar
            baseId={baseId}
            tableId={tableId}
            tableName={table.name}
            views={views.items}
            active={view}
            access={base.access}
            extra={renderViewActions?.(view, base)}
          />
          {view.type === 'grid' ? (
            renderGrid(view)
          ) : view.type === 'kanban' && renderKanban !== undefined ? (
            renderKanban(view)
          ) : view.type === 'form' && renderForm !== undefined ? (
            renderForm(view)
          ) : (
            <ViewPlaceholder view={view} />
          )}
        </>
      )}
    </div>
  );
}

export default TableViewPage;
