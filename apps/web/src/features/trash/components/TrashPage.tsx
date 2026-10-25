import { cn } from '@cellhive/ui';
import { useInfiniteQuery, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { useFormatters } from '../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { canManageSchema, canRestoreRecords } from '../../../lib/permissions/access';
import {
  baseQuery,
  fieldTrashQuery,
  recordTrashQuery,
  tableQuery,
} from '../../../lib/query/queries';
import { useTableChannel } from '../../../lib/realtime/channels';

import { FieldTrashList, isDeleted } from './FieldTrashList';
import { RecordTrashList } from './RecordTrashList';

type TrashTab = 'records' | 'fields';

/**
 * `/b/:baseId/t/:tableId/trash` (FRONTEND §10.4): deleted records of a
 * table, and its deleted fields for schema managers. The route loader has
 * already loaded the base (access) and the table, or shown the 404 screen.
 */
export function TrashPage() {
  const { t } = useTranslation('trash');
  const format = useFormatters();
  const { baseId = '', tableId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const { data: table } = useSuspenseQuery(tableQuery(tableId));
  // Deletions and restores elsewhere refresh the list (FRONTEND §5).
  useTableChannel(tableId);
  const [params, setParams] = useSearchParams();
  useDocumentTitle(t('heading', { table: table.name }));

  const canRestore = canRestoreRecords(base.access, tableId);
  const tabs: TrashTab[] = canManageSchema(base.access, tableId)
    ? ['records', 'fields']
    : ['records'];
  const requested = params.get('tab');
  const tab: TrashTab = requested === 'fields' && tabs.includes('fields') ? 'fields' : 'records';
  const tabRefs = useRef(new Map<TrashTab, HTMLButtonElement>());

  // Tab counts (design "Thùng rác") from the lists' own queries (same cache, no extra
  // request): the records trash is paged by cursor, so "N+" while more pages exist.
  const recordTrash = useInfiniteQuery({ ...recordTrashQuery(tableId), enabled: canRestore });
  const fieldTrash = useQuery({
    ...fieldTrashQuery(tableId),
    enabled: tabs.includes('fields'),
    select: (list) => list.items.filter(isDeleted).length,
  });
  const loadedRecords = recordTrash.data?.pages.reduce((sum, page) => sum + page.records.length, 0);
  const counts: Record<TrashTab, string | null> = {
    records:
      loadedRecords === undefined
        ? null
        : `${format.number(loadedRecords)}${recordTrash.hasNextPage ? '+' : ''}`,
    fields: fieldTrash.data === undefined ? null : format.number(fieldTrash.data),
  };

  const select = (next: TrashTab, focus = false) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'records') updated.delete('tab');
        else updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );
    if (focus) tabRefs.current.get(next)?.focus();
  };
  // WAI-ARIA tabs: arrows, Home and End move between tabs (automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    select(target, true);
  };

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      {/* Header band (design "Thùng rác"): back link, title, retention rule, tabs with counts. */}
      <PageHeading
        back={{
          to: `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}`,
          label: t('backToTable', { table: table.name }),
        }}
        icon={Trash2}
        title={t('heading', { table: table.name })}
        subtitle={t('subtitle')}
      >
        <div
          role="tablist"
          aria-label={t('tabs.label')}
          className="-mb-px flex gap-1"
          onKeyDown={onKeyDown}
        >
          {tabs.map((item) => (
            <button
              key={item}
              ref={(node) => {
                if (node === null) tabRefs.current.delete(item);
                else tabRefs.current.set(item, node);
              }}
              type="button"
              role="tab"
              id={`trash-tab-${item}`}
              aria-selected={tab === item}
              aria-controls={tab === item ? `trash-panel-${item}` : undefined}
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
              {t(`tabs.${item}`)}
              {/* The count is seen in the list itself; kept out of the tab's name. */}
              {counts[item] === null ? null : (
                <span
                  aria-hidden="true"
                  data-testid={`trash-count-${item}`}
                  className="font-normal text-fg-muted tabular-nums"
                >
                  {counts[item]}
                </span>
              )}
            </button>
          ))}
        </div>
      </PageHeading>
      <div
        role="tabpanel"
        id={`trash-panel-${tab}`}
        aria-labelledby={`trash-tab-${tab}`}
        className={cn('py-6', PAGE_GUTTER)}
      >
        {tab === 'records' ? (
          <RecordTrashList
            baseId={baseId}
            tableId={tableId}
            tableName={table.name}
            primaryFieldId={table.primary_field_id}
            canRestore={canRestore}
            canPurge={canManageSchema(base.access, tableId)}
          />
        ) : (
          <FieldTrashList baseId={baseId} tableId={tableId} tableName={table.name} />
        )}
      </div>
    </div>
  );
}

export default TrashPage;
