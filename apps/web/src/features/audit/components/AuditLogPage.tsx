import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Download, History, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { orgBasesQuery, orgMembersQuery } from '../../../lib/query/queries';
import { auditApi, auditListQuery, type AuditScope } from '../api';
import {
  actorOf,
  entityOf,
  filtersToParams,
  hasNarrowingFilters,
  mergeRefs,
  parseFilters,
  toQuery,
  viaOf,
  type AuditFilters,
} from '../model';
import { useIsNarrow } from '../narrow';

import { AuditDrawer } from './AuditDrawer';
import { AuditList, type AuditRow } from './AuditList';
import { ExportStatus } from './ExportStatus';
import { FilterBar, type FilterOption } from './FilterBar';
import { useActionLabel, useActorText, useEntityText } from './labels';

export interface AuditLogPageProps {
  readonly scope: AuditScope;
  /** The organization or base name (heading, back link). */
  readonly name: string;
  readonly back: string;
}

/**
 * The audit log viewer shared by `/o/:orgSlug/settings/audit` (org
 * owners/admins) and `/b/:baseId/settings/audit` (base admins) — T716,
 * CONTRACTS §11.4, S6-research §4 #6. Filters live in the URL; the list is
 * cursor-paginated ("Load more", no page numbers — the API has no total);
 * names come from `refs` of each page. The route guards give everyone
 * else the 404 screen (the API answers `404` too).
 */
export function AuditLogPage({ scope, name, back }: AuditLogPageProps) {
  const { t } = useTranslation('audit');
  const format = useFormatters();
  const narrow = useIsNarrow();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  // Presets ("last 7 days") are anchored when the filters change or on "Refresh",
  // so the query (and its cursor) stays the same while paging.
  const [now, setNow] = useState(() => Date.now());
  const query = useMemo(
    () => toQuery(filters, now, format.timeZone, scope.kind),
    [filters, now, format.timeZone, scope.kind],
  );
  const list = useInfiniteQuery(auditListQuery(scope, query));
  const members = useQuery(orgMembersQuery(scope.orgId));
  const bases = useQuery(orgBasesQuery(scope.orgId));

  const actionLabel = useActionLabel();
  const actorText = useActorText();
  const entityText = useEntityText();
  const pages = list.data?.pages;
  const refs = useMemo(() => mergeRefs(pages ?? []), [pages]);
  const baseNames = useMemo(
    () => new Map((bases.data ?? []).map((base) => [base.id, base.name] as const)),
    [bases.data],
  );
  const rows: AuditRow[] = useMemo(
    () =>
      (pages ?? [])
        .flatMap((page) => page.items)
        .map((entry) => {
          const actor = actorOf(entry, refs);
          const entity = entityOf(entry, refs, baseNames);
          return {
            entry,
            time: format.dateTime(entry.created_at),
            actor,
            actorText: actorText(actor),
            via: viaOf(entry, refs),
            action: actionLabel(entry.action),
            entity,
            entityText: entityText(entity),
            base: entry.base_id === null ? null : (baseNames.get(entry.base_id) ?? entry.base_id),
          };
        }),
    [pages, refs, baseNames, format, actorText, actionLabel, entityText],
  );
  const retention = pages?.[0]?.retention_days;

  const people: FilterOption[] = useMemo(
    () =>
      (members.data?.items ?? []).map((member) => ({
        id: member.user.id,
        name: member.user.display_name,
        detail: member.user.email,
      })),
    [members.data],
  );
  const baseOptions: FilterOption[] | null =
    scope.kind === 'org'
      ? (bases.data ?? []).map(({ id, name: base }) => ({ id, name: base }))
      : null;

  const setFilters = useCallback(
    (next: AuditFilters) => {
      setNow(Date.now());
      setParams(filtersToParams(next), { replace: true });
    },
    [setParams],
  );

  // Details drawer; the focus goes back to the entry that opened it.
  const [open, setOpen] = useState<AuditRow | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeDrawer = () => {
    setOpen(null);
    const target = opener.current;
    // After the dialog closed (the browser may move the focus itself first).
    window.setTimeout(() => {
      if (target?.isConnected === true) target.focus();
    }, 0);
  };

  // Export: `202 { job_id }`, then the job's progress and download link.
  const [jobId, setJobId] = useState<string | null>(null);
  const exporting = useMutation({
    mutationFn: () => {
      // Same filters as the list; paging fields are not filters.
      return auditApi.export(scope, query, crypto.randomUUID());
    },
    onSuccess: (accepted) => {
      setJobId(accepted.job_id);
    },
  });

  const formatDay = (day: string) => format.date(`${day}T12:00:00.000Z`);
  const retentionNote =
    retention === undefined
      ? null
      : retention === 0
        ? t('retention.forever')
        : t('retention.days', { count: retention });

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{ to: back, label: t('page.back', { name }) }}
        icon={History}
        title={scope.kind === 'org' ? t('page.titleOrg') : t('page.titleBase')}
        subtitle={
          scope.kind === 'org' ? t('page.subtitleOrg', { name }) : t('page.subtitleBase', { name })
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setNow(Date.now());
              }}
              disabled={list.isFetching}
              data-testid="audit-refresh"
            >
              <RefreshCw aria-hidden="true" />
              {t('page.refresh')}
            </Button>
            <Button
              onClick={() => {
                setJobId(null);
                exporting.mutate();
              }}
              disabled={exporting.isPending || jobId !== null}
              data-testid="audit-export"
            >
              <Download aria-hidden="true" />
              {t('export.button')}
            </Button>
          </div>
        }
      />
      <div className={cn('flex flex-col gap-4 py-6', PAGE_GUTTER)}>
        <FilterBar
          filters={filters}
          onChange={setFilters}
          people={people}
          bases={baseOptions}
          timeZone={format.timeZone}
          formatDay={formatDay}
        />
        {retentionNote === null ? null : (
          <p className="text-label font-normal text-fg-muted" data-testid="audit-retention">
            {retentionNote} {t('export.note')}
          </p>
        )}
        {exporting.isPending ? (
          <p role="status" className="text-body text-fg-muted">
            {t('export.starting')}
          </p>
        ) : exporting.error === null ? null : (
          <ErrorAlert error={exporting.error} />
        )}
        {jobId === null ? null : (
          <ExportStatus
            key={jobId}
            jobId={jobId}
            onDismiss={() => {
              setJobId(null);
              exporting.reset();
            }}
          />
        )}

        {list.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t('page.loading')}
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : list.isError && rows.length === 0 ? (
          <ErrorAlert error={list.error} />
        ) : rows.length === 0 ? (
          <div
            className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-6"
            data-testid="audit-empty"
          >
            <p className="text-body font-medium text-fg">{t('empty.title')}</p>
            <p className="text-body text-fg-muted">{t('empty.filters')}</p>
            {retention === undefined ? null : (
              <p className="text-body text-fg-muted">
                {retention === 0 ? t('empty.forever') : t('empty.retention', { count: retention })}
              </p>
            )}
            {hasNarrowingFilters(filters) || filters.range !== '7d' ? (
              <Button
                variant="secondary"
                className="w-fit"
                onClick={() => {
                  setFilters(parseFilters(new URLSearchParams()));
                }}
              >
                {t('filters.clear')}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <AuditList
              rows={rows}
              showBase={scope.kind === 'org'}
              narrow={narrow}
              onOpen={(row, element) => {
                opener.current = element;
                setOpen(row);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-label font-normal text-fg-muted" role="status">
                {t('list.showing', { count: rows.length })}
                {list.hasNextPage ? '' : ` · ${t('list.end')}`}
              </p>
              {list.hasNextPage ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    void list.fetchNextPage();
                  }}
                  disabled={list.isFetchingNextPage}
                  data-testid="audit-load-more"
                >
                  {list.isFetchingNextPage ? <Spinner /> : null}
                  {list.isFetchingNextPage ? t('list.loadingMore') : t('list.loadMore')}
                </Button>
              ) : null}
            </div>
            {list.isFetchNextPageError ? <ErrorAlert error={list.error} /> : null}
          </>
        )}
      </div>
      <AuditDrawer
        row={open}
        refs={refs}
        onClose={closeDrawer}
        onSameBatch={(batchId) => {
          closeDrawer();
          setFilters({ ...filters, batchId });
        }}
        onOnlyAction={(action) => {
          closeDrawer();
          setFilters({ ...filters, actions: [action] });
        }}
      />
    </div>
  );
}
