import { Button, Skeleton } from '@cellhive/ui';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Database, Plus, Table2, Trash2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { canManageSchema, canRestoreRecords } from '../../../lib/permissions/access';
import { tablesQuery } from '../../../lib/query/queries';
import { baseQuery } from '../api';

import type { EffectiveAccess, TableDto } from '@cellhive/contracts';
import type { ReactNode } from 'react';

const CreateTableDialog = lazy(() => import('./CreateTableDialog'));

function tablePath(baseId: string, tableId: string): string {
  return `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`;
}

/**
 * Tables of the base, each with its trash (FRONTEND §10.4) for those who can
 * restore records or fields there.
 */
function TableList({
  baseId,
  access,
  tables,
}: {
  baseId: string;
  access: EffectiveAccess;
  tables: readonly TableDto[];
}) {
  const { t } = useTranslation('base');
  return (
    <section aria-labelledby="base-tables" className="flex flex-col gap-3">
      <h2 id="base-tables" className="text-heading">
        {t('tables.heading')}
      </h2>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {tables.map((table) => (
          <li key={table.id} className="flex items-center gap-3 px-4 py-2">
            <Link
              to={tablePath(baseId, table.id)}
              className="flex min-w-0 flex-1 items-center gap-2 font-medium hover:underline"
            >
              <Table2 aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <span className="truncate">{table.name}</span>
            </Link>
            {canRestoreRecords(access, table.id) || canManageSchema(access, table.id) ? (
              <Link
                to={`${tablePath(baseId, table.id)}/trash`}
                aria-label={t('tables.trashOf', { table: table.name })}
                className="inline-flex h-control items-center gap-1 rounded-md px-2 text-fg-muted hover:bg-surface-sunken hover:text-fg"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                {t('tables.trash')}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/b/:baseId`. The route guard opens the first table's grid when the base
 * has tables (the grid page has the table tabs and the trash link); this
 * page shows a base without tables, and the table list should the guard let
 * it through (tables listed between the loader and the render).
 */
export interface BasePageProps {
  /** Actions of the base given by the route, e.g. import as a new table (T318). */
  readonly actions?: ReactNode;
}

export function BasePage({ actions }: BasePageProps = {}) {
  const { t } = useTranslation('base');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const tables = useQuery(tablesQuery(baseId));
  const format = useFormatters();
  const [creating, setCreating] = useState(false);
  useDocumentTitle(base.name);
  return (
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <div className="flex items-start gap-3">
        <Database aria-hidden="true" className="mt-1 size-5 shrink-0 text-accent" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-title break-words">{base.name}</h1>
          {base.description === null ? null : <p className="text-fg-muted">{base.description}</p>}
          <p className="text-label font-normal text-fg-muted">
            {t('createdAt', { date: format.dateTime(base.created_at) })}
          </p>
        </div>
        {actions === undefined ? null : <div className="ml-auto shrink-0">{actions}</div>}
      </div>
      {tables.isPending ? (
        <Skeleton className="h-24" />
      ) : tables.isError ? (
        <ErrorAlert error={tables.error} />
      ) : tables.data.items.length > 0 ? (
        <TableList baseId={baseId} access={base.access} tables={tables.data.items} />
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
          <Table2 aria-hidden="true" className="size-6 text-fg-muted" />
          <h2 className="text-heading">{t('empty.title')}</h2>
          <p className="max-w-md text-fg-muted">{t('empty.description')}</p>
          {canManageSchema(base.access) ? (
            <Button
              className="mt-2"
              data-testid="empty-base-new-table"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus aria-hidden="true" />
              {t('tables.new')}
            </Button>
          ) : null}
        </div>
      )}
      {creating ? (
        <Suspense fallback={null}>
          <CreateTableDialog
            baseId={baseId}
            tableCount={tables.data?.items.length ?? 0}
            onClose={() => {
              setCreating(false);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export default BasePage;
