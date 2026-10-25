import { Button, cn, Label, Select, Skeleton, Spinner, Tooltip } from '@cellhive/ui';
import { useInfiniteQuery, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, History, Lock, Square } from 'lucide-react';
import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { PageHeader } from '../../../../lib/layout/page-header';
import { canManageAutomations } from '../../../../lib/permissions/access';
import { automationQuery, automationsQuery } from '../../../../lib/query/automations';
import { keys } from '../../../../lib/query/keys';
import { baseQuery, orgMembersQuery, tablesQuery } from '../../../../lib/query/queries';
import { automationRunsApi } from '../api';
import {
  canCancel,
  elapsedMs,
  fromOf,
  parseRunFilter,
  parseRunRange,
  pollIntervalOf,
  RUN_FILTERS,
  RUN_RANGES,
  statusesOf,
} from '../model/runs';
import { useRecordTitles, type RecordRef, type RecordTitle } from '../use-record-titles';

import { AutomationTabs, useAutomationPhoneLayout } from './AutomationTabs';
import { useRunActions } from './RunActions';
import { formatDuration, retryAtOf, runErrorText, runLabelText, StatusBadge } from './RunBits';
import { RunDetail } from './RunDetail';

import type { AutomationRunDto } from '@cellhive/contracts';

/** Runs per page (the API's default is 50, at most 200). */
const PAGE_SIZE = 50;

function Message({
  icon: Icon,
  title,
  children,
  'data-testid': testId,
}: {
  readonly icon: typeof Lock;
  readonly title: string;
  readonly children?: ReactNode;
  readonly 'data-testid': string;
}) {
  return (
    <section
      data-testid={testId}
      className="flex flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-6"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h2 className="text-heading">{title}</h2>
      {children}
    </section>
  );
}

function LoadingRows() {
  const { t } = useTranslation('automationRuns');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('list.loading')}
      className="overflow-hidden rounded-lg border border-line bg-surface"
    >
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
        >
          <Skeleton className="h-5 w-20" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-[50%]" />
            <Skeleton className="h-2.5 w-[70%]" />
          </span>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

interface RowProps {
  readonly run: AutomationRunDto;
  readonly title: RecordTitle | null;
  /** Automation name (base page only). */
  readonly automationName: string | null;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly userName: (userId: string) => string | null;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
}

/**
 * One run (board "S5 · Run history" list): status, what triggered it, what
 * happened (error as a sentence, the batch, who re-ran it), when, and
 * "Cancel" for a run still queued or waiting. The row opens the drawer.
 */
function RunRow({
  run,
  title,
  automationName,
  selected,
  pending,
  userName,
  onOpen,
  onCancel,
}: RowProps) {
  const { t } = useTranslation('automationRuns');
  const format = useFormatters();
  const label = runLabelText(run, title, t, format);
  const ms = run.active_ms > 0 ? run.active_ms : elapsedMs(run.started_at, run.finished_at);
  const retryAt = run.status === 'queued' ? retryAtOf(run.error) : null;

  const details: string[] = [];
  if (automationName !== null) details.push(automationName);
  if (run.error !== null && run.status !== 'succeeded' && retryAt === null) {
    details.push(runErrorText(run.error, { t, format, userName }));
  }
  if (retryAt !== null) details.push(t('detail.retryAt', { time: format.dateTime(retryAt) }));
  if (run.status === 'waiting') details.push(t('list.waiting'));
  if (run.rerun_by !== null) details.push(t('detail.rerunBy', { name: run.rerun_by.name }));
  if (
    run.error?.code !== 'batch_fanout_exceeded' &&
    run.trigger.bulk &&
    run.trigger.batch !== null
  ) {
    details.push(t('list.batch', { count: run.trigger.batch.size }));
  }
  if (run.status === 'succeeded' && ms !== null && ms > 0)
    details.push(formatDuration(ms, format, t));

  return (
    <li
      className={cn(
        'flex items-center gap-2 border-t border-line first:border-t-0',
        selected && 'bg-accent-soft/50',
      )}
      data-testid={`run-row-${run.id}`}
      data-run-status={run.status}
      aria-busy={pending}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent max-sm:flex-wrap max-sm:gap-y-1"
        data-testid={`run-open-${run.id}`}
      >
        <StatusBadge status={run.status} className="sm:w-[104px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 max-sm:order-3 max-sm:basis-full">
          <span className="truncate text-body font-medium">{label}</span>
          {details.length === 0 ? null : (
            <span className="line-clamp-2 text-label font-normal text-fg-muted">
              {details.join(' · ')}
            </span>
          )}
        </span>
        <time
          dateTime={run.created_at}
          title={format.dateTime(run.created_at)}
          className="shrink-0 text-label font-normal text-fg-muted tabular-nums max-sm:ml-auto"
        >
          {format.dateTime(run.created_at)}
        </time>
      </button>
      {canCancel(run) ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          className="mr-3 shrink-0 max-lg:h-control"
          data-testid={`run-cancel-${run.id}`}
          aria-label={t('list.cancelRun', { name: label })}
          onClick={onCancel}
        >
          <Square aria-hidden="true" />
          <span aria-hidden="true">{t('detail.cancel')}</span>
        </Button>
      ) : null}
    </li>
  );
}

/** A trigger event id (`evt_` + 16 base62 characters, CONTRACTS §1.2). */
const EVENT_ID = /^evt_[0-9A-Za-z]{16}$/u;

/**
 * The run history (T523, FRONTEND §13.3; boards "S5 · Run history", "… -
 * 375 px"): `/b/:baseId/automations/:automationId/runs` — the "Run
 * history" tab of an automation — and `/b/:baseId/automations/runs` —
 * every automation of the base the caller manages. Filters (status, time,
 * automation on the base page) and the open run live in the URL; pages
 * of 50 by cursor ("Load more"); the run opens in a drawer. No realtime
 * for runs (CONTRACTS §21): the list and the drawer poll while a run shown
 * is queued, running or waiting.
 */
export function RunHistoryPage() {
  const { t } = useTranslation(['automationRuns', 'automation', 'common']);
  const { baseId = '', automationId } = useParams();
  const [search, setSearch] = useSearchParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const manages = canManageAutomations(base.access);
  const forAutomation = automationId !== undefined;
  const phone = useAutomationPhoneLayout();

  const automation = useQuery({
    ...automationQuery(baseId, automationId ?? ''),
    enabled: manages && forAutomation,
    retry: (count, error) =>
      !(isApiError(error) && (error.status === 403 || error.status === 404)) && count < 2,
  });
  const automations = useQuery({ ...automationsQuery(baseId), enabled: manages && !forAutomation });
  const tables = useQuery(tablesQuery(baseId));
  const members = useQuery({
    ...orgMembersQuery(base.organization_id),
    enabled: manages,
    retry: false,
  });

  const filter = parseRunFilter(search.get('status'));
  const range = parseRunRange(search.get('range'));
  const automationFilter = forAutomation ? null : search.get('automation');
  // `?event=evt_…` (T616): the runs of one trigger event — the "Run history" link of a
  // webhook request. Anything else in the parameter is ignored.
  const eventParam = search.get('event');
  const eventFilter = eventParam !== null && EVENT_ID.test(eventParam) ? eventParam : null;
  const openRunId = search.get('run');
  const scope = `${forAutomation ? automationId : `base:${automationFilter ?? ''}`}:${eventFilter ?? ''}`;

  const runs = useInfiniteQuery({
    queryKey: keys.automationRuns(baseId, scope, filter, range),
    queryFn: ({ pageParam, signal }) => {
      const params = {
        status: statusesOf(filter),
        from: fromOf(range, new Date()),
        eventId: eventFilter ?? undefined,
        cursor: pageParam,
        limit: PAGE_SIZE,
      };
      return forAutomation
        ? automationRunsApi.list(automationId, params, signal)
        : automationRunsApi.listOfBase(
            baseId,
            { ...params, automationId: automationFilter ?? undefined },
            signal,
          );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: manages && (!forAutomation || automation.data !== undefined),
    retry: (count, error) =>
      !(isApiError(error) && (error.status === 403 || error.status === 404)) && count < 2,
    refetchInterval: (query) =>
      pollIntervalOf(
        (query.state.data?.pages ?? []).flatMap((page) => page.items.map((item) => item.status)),
      ),
  });
  const items = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);

  const refs = useMemo(() => {
    const out: RecordRef[] = [];
    for (const run of items) {
      if (run.trigger.record_id !== null && run.trigger.table_id !== null) {
        out.push({ tableId: run.trigger.table_id, recordId: run.trigger.record_id });
      }
    }
    return out;
  }, [items]);
  const titleOf = useRecordTitles(refs, tables.data?.items);
  const userName = useCallback(
    (userId: string) =>
      members.data?.items.find((member) => member.user.id === userId)?.user.display_name ?? null,
    [members.data],
  );
  const automationName = (id: string) =>
    automations.data?.items.find((item) => item.id === id)?.name ?? null;

  const setParam = (key: string, value: string | null) => {
    setSearch(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: key !== 'run' },
    );
  };
  const onStatus = (value: string) => {
    setParam('status', value === 'all' ? null : value);
  };
  const onRange = (value: string) => {
    setParam('range', value);
  };
  const clearEvent = () => {
    setParam('event', null);
  };
  const onAutomation = (value: string) => {
    setParam('automation', value === '' ? null : value);
  };
  const clearFilters = () => {
    setSearch(new URLSearchParams({ range: 'all' }), { replace: true });
  };
  const openRun = (runId: string) => {
    setParam('run', runId);
  };
  const closeRun = () => {
    const runId = openRunId;
    setParam('run', null);
    window.setTimeout(() => {
      if (runId !== null)
        document.querySelector<HTMLElement>(`[data-testid="run-open-${runId}"]`)?.focus();
    }, 0);
  };
  // The re-run opens in the drawer (its status is polled there).
  const actions = useRunActions(baseId, (created) => {
    openRun(created.id);
  });

  const name = forAutomation ? (automation.data?.name ?? '') : t('page.allTitle');
  useDocumentTitle(`${t('page.title')} · ${name === '' ? t('automation:page.title') : name}`);

  const statusId = useId();
  const rangeId = useId();
  const automationId2 = useId();

  const forbidden =
    !manages ||
    (isApiError(automation.error) && automation.error.status === 403) ||
    (isApiError(runs.error) && runs.error.status === 403);
  const gone =
    (isApiError(automation.error) && automation.error.status === 404) ||
    (isApiError(runs.error) && runs.error.status === 404);

  let body: ReactNode;
  if (forbidden) {
    body = (
      <Message icon={Lock} title={t('automation:forbidden.title')} data-testid="runs-forbidden">
        <p className="max-w-[60ch] text-body text-fg-muted">
          {t('automation:forbidden.description')}
        </p>
      </Message>
    );
  } else if (gone) {
    body = (
      <Message icon={History} title={t('page.notFound')} data-testid="runs-not-found">
        <Link to={`/b/${baseId}/automations`} className="text-body text-accent underline">
          {t('page.backToList')}
        </Link>
      </Message>
    );
  } else if (automation.isError) {
    body = <ErrorAlert error={automation.error} />;
  } else {
    const filtered =
      filter !== 'all' || range !== 'all' || automationFilter !== null || eventFilter !== null;
    body = (
      <>
        <div className="flex flex-wrap items-end gap-2" data-testid="run-filters">
          <div className="flex w-full flex-col gap-1 sm:w-48">
            <Label htmlFor={statusId}>{t('filter.status')}</Label>
            <Select
              id={statusId}
              value={filter}
              data-testid="run-filter-status"
              onChange={(event) => {
                onStatus(event.target.value);
              }}
            >
              {RUN_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {t(`filter.statusOption.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex w-full flex-col gap-1 sm:w-40">
            <Label htmlFor={rangeId}>{t('filter.range')}</Label>
            <Select
              id={rangeId}
              value={range}
              data-testid="run-filter-range"
              onChange={(event) => {
                onRange(event.target.value);
              }}
            >
              {RUN_RANGES.map((value) => (
                <option key={value} value={value}>
                  {t(`filter.rangeOption.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          {forAutomation ? null : (
            <div className="flex w-full flex-col gap-1 sm:w-64">
              <Label htmlFor={automationId2}>{t('filter.automation')}</Label>
              <Select
                id={automationId2}
                value={automationFilter ?? ''}
                data-testid="run-filter-automation"
                onChange={(event) => {
                  onAutomation(event.target.value);
                }}
              >
                <option value="">{t('filter.allAutomations')}</option>
                {(automations.data?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {eventFilter === null ? null : (
            <div
              className="flex w-full flex-wrap items-center gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2"
              data-testid="run-filter-event"
            >
              <span className="text-label font-normal text-fg">{t('filter.event')}</span>
              <Button
                variant="secondary"
                size="sm"
                className="max-lg:h-control"
                onClick={clearEvent}
              >
                {t('filter.eventClear')}
              </Button>
            </div>
          )}
          <span
            className="pb-2 text-label font-normal text-fg-muted sm:ml-auto"
            role="status"
            aria-live="polite"
            data-testid="run-count"
          >
            {runs.data === undefined
              ? null
              : runs.hasNextPage
                ? t('list.countMore', { count: items.length })
                : t('list.count', { count: items.length })}
          </span>
        </div>
        {runs.isPending ? (
          <LoadingRows />
        ) : runs.isError ? (
          <ErrorAlert error={runs.error} />
        ) : items.length === 0 ? (
          <div
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface p-6"
            data-testid="runs-empty"
          >
            <p className="text-body text-fg-muted">
              {filtered ? t('list.emptyFiltered') : t('list.empty')}
            </p>
            {filtered ? (
              <Button
                variant="secondary"
                size="sm"
                className="max-lg:h-control"
                onClick={() => {
                  clearFilters();
                }}
              >
                {t('list.clear')}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <ul
              className="overflow-hidden rounded-lg border border-line bg-surface"
              aria-label={t('list.label')}
              data-testid="run-list"
            >
              {items.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  title={
                    run.trigger.record_id === null || run.trigger.table_id === null
                      ? null
                      : titleOf({ tableId: run.trigger.table_id, recordId: run.trigger.record_id })
                  }
                  automationName={forAutomation ? null : automationName(run.automation_id)}
                  selected={openRunId === run.id}
                  pending={actions.pendingId === run.id}
                  userName={userName}
                  onOpen={() => {
                    openRun(run.id);
                  }}
                  onCancel={() => {
                    actions.ask({ kind: 'cancel', run });
                  }}
                />
              ))}
            </ul>
            {runs.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  disabled={runs.isFetchingNextPage}
                  className="max-sm:h-11 max-sm:w-full"
                  data-testid="runs-load-more"
                  onClick={() => {
                    void runs.fetchNextPage();
                  }}
                >
                  {runs.isFetchingNextPage ? <Spinner /> : null}
                  {t('list.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeader>
        <Tooltip content={t('page.back')}>
          <Button asChild variant="ghost" size="icon" className="size-8 max-lg:size-control">
            <Link to={`/b/${baseId}/automations`} aria-label={t('page.back')}>
              <ChevronLeft aria-hidden="true" />
            </Link>
          </Button>
        </Tooltip>
        <nav
          aria-label={t('automation:page.breadcrumb')}
          className="flex min-w-0 shrink items-center gap-1.5"
        >
          <span className="text-body text-fg-muted max-md:hidden">
            {t('automation:page.title')}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-subtle max-md:hidden"
          />
          <h1 className="min-w-0 truncate text-heading" data-testid="runs-title">
            {forAutomation ? name : t('page.allTitle')}
          </h1>
        </nav>
        {forAutomation && automation.data !== undefined ? (
          <span
            className={cn(
              'inline-flex h-[22px] shrink-0 items-center rounded-sm px-2 text-label font-medium max-sm:hidden',
              automation.data.enabled
                ? 'bg-success/10 text-success'
                : 'bg-surface-sunken text-fg-muted',
            )}
          >
            {automation.data.enabled ? t('page.on') : t('page.off')}
          </span>
        ) : null}
        {forAutomation && !phone ? (
          <div className="ml-auto flex shrink-0 items-center">
            <AutomationTabs baseId={baseId} automationId={automationId} current="runs" />
          </div>
        ) : null}
      </PageHeader>
      {/* T556 (S5-review §4 #16): on phones the tabs get a row below the top bar, like the builder. */}
      {forAutomation && phone ? (
        <div
          className="border-b border-line bg-surface px-4 py-2"
          data-testid="automation-tabs-row"
        >
          <AutomationTabs baseId={baseId} automationId={automationId} current="runs" />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-6" data-testid="run-history">
        {body}
      </div>
      {openRunId === null || forbidden ? null : (
        <RunDetail
          key={openRunId}
          runId={openRunId}
          baseId={baseId}
          tables={tables.data?.items}
          userName={userName}
          pendingId={actions.pendingId}
          onAsk={actions.ask}
          onOpenRun={openRun}
          onClose={closeRun}
        />
      )}
      {actions.dialog}
    </div>
  );
}

export default RunHistoryPage;
