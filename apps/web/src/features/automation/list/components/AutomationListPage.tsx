import { Button, cn, Input, Skeleton } from '@cellhive/ui';
import { useQueries, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { ChevronRight, History, Info, Lock, Plus, Search, Zap } from 'lucide-react';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PageHeader } from '../../../../lib/layout/page-header';
import { canManageAutomations, isBaseAdmin } from '../../../../lib/permissions/access';
import { automationsQuery } from '../../../../lib/query/automations';
import { incomingWebhooksQuery } from '../../../../lib/query/incoming-webhooks';
import { baseQuery, fieldsQuery, tablesQuery, viewsQuery } from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { showToast } from '../../../../lib/toast/toast';
import { baseRunsPath } from '../../runs/components/AutomationTabs';
import {
  filterAutomations,
  STATUS_FILTERS,
  statusCounts,
  type StatusFilter,
} from '../model/filter';
import { triggerTableId, type SchemaNames } from '../model/summary';
import { useAutomationActions } from '../use-automation-actions';
import { useAutomationRealtime } from '../use-automation-realtime';
import { useDuplicateAutomation } from '../use-duplicate-automation';

import { AutomationCards, AutomationTable, switchIdOf } from './AutomationRows';
import { DeleteAutomationDialog, EnableDialog, TakeOverDialog } from './ConfirmDialogs';
import { CreateAutomationDialog } from './CreateAutomationDialog';

import type { AutomationDto } from '@cellhive/contracts';

type Pending =
  | { readonly kind: 'enable' | 'takeOver' | 'delete'; readonly automation: AutomationDto }
  | { readonly kind: 'create' }
  | null;

const NARROW_QUERY = '(max-width: 767.98px)';

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Phones show cards; from 768 px the table (FRONTEND §9.4). */
function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

function StatusTabs({
  value,
  counts,
  onChange,
}: {
  readonly value: StatusFilter;
  readonly counts: Record<StatusFilter, number>;
  readonly onChange: (value: StatusFilter) => void;
}) {
  const { t, i18n } = useTranslation('automation');
  const numbers = new Intl.NumberFormat(i18n.language);
  return (
    <div
      role="radiogroup"
      aria-label={t('page.statusLabel')}
      className="inline-flex h-control max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-line bg-surface-sunken p-0.5"
    >
      {STATUS_FILTERS.map((status, index) => (
        <button
          key={status}
          type="button"
          role="radio"
          aria-checked={value === status}
          tabIndex={value === status ? 0 : -1}
          data-status={status}
          data-testid={`status-${status}`}
          className={cn(
            'inline-flex h-full items-center gap-1.5 rounded-sm px-3 text-label font-normal whitespace-nowrap text-fg-muted',
            value === status && 'bg-surface font-medium text-fg shadow-sm',
          )}
          onClick={() => {
            onChange(status);
          }}
          onKeyDown={(event) => {
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (step === 0) return;
            event.preventDefault();
            const next =
              STATUS_FILTERS[(index + step + STATUS_FILTERS.length) % STATUS_FILTERS.length] ??
              'all';
            onChange(next);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(`[data-status="${next}"]`)
              ?.focus();
          }}
        >
          {t(`page.status.${status}`)}
          <span className="tabular-nums">{numbers.format(counts[status])}</span>
        </button>
      ))}
    </div>
  );
}

function LoadingRows() {
  const { t } = useTranslation('automation');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('page.loading')}
      className="overflow-hidden rounded-lg border border-line bg-surface"
    >
      <div className="h-[34px] bg-surface-sunken" />
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="grid grid-cols-[50px_minmax(0,1fr)_120px_90px] items-center gap-3 border-t border-line px-4 py-3.5"
        >
          <Skeleton className="h-5 w-9 rounded-full" />
          <span className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-[70%]" />
            <Skeleton className="h-2.5 w-[45%]" />
          </span>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function Message({
  icon: Icon,
  title,
  children,
  'data-testid': testId,
}: {
  readonly icon: typeof Zap;
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

/**
 * `/b/:baseId/automations` (T520, FRONTEND §13; boards "S5 · Automation
 * list", "… - trạng thái", "… - 375 px"): the automations of a base the
 * caller manages (CONTRACTS §21) — switch, name and trigger, `run_as`, why
 * the system turned one off with "Turn back on" / "Take over" (ADR-25 §5–6,
 * ADR-26 §5), create, delete. Turning on one that runs as someone else asks
 * first (ADR-25 §4). People who manage no automation see why (the list is
 * `403` for them). Phones: cards, switch and fixes only (editing ≥ 768 px).
 */
export function AutomationListPage() {
  const { t } = useTranslation(['automation', 'common']);
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const me = useQuery(meQuery());
  const meId = me.data?.user.id ?? null;
  const manages = canManageAutomations(base.access);
  const list = useQuery({ ...automationsQuery(baseId), enabled: manages });
  const tables = useQuery(tablesQuery(baseId));
  const narrow = useIsNarrow();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const actions = useAutomationActions(baseId);
  const duplicate = useDuplicateAutomation(baseId, { linkToSource: true });
  const navigate = useNavigate();
  useDocumentTitle(`${t('page.title')} · ${base.name}`);

  const items = list.data?.items ?? [];
  // Field names for the trigger lines (watched, date and button fields).
  const fieldTables = [
    ...new Set(
      items
        .map((item) => item.definition.trigger)
        .filter(
          (trigger) =>
            trigger.type === 'record.updated' ||
            trigger.type === 'record.date_reached' ||
            trigger.type === 'button.clicked',
        )
        .map(triggerTableId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const fieldLists = useQueries({ queries: fieldTables.map((id) => fieldsQuery(id)) });
  // Form names: the views of the base's tables, only when a form trigger is listed.
  const formTables = items.some((item) => item.definition.trigger.type === 'form.submitted')
    ? (tables.data?.items ?? [])
    : [];
  const viewLists = useQueries({ queries: formTables.map((table) => viewsQuery(table.id)) });
  // (T612) Hook names of `webhook.received` triggers (base admins: only they read hooks).
  const hooks = useQuery({
    ...incomingWebhooksQuery(baseId),
    enabled:
      isBaseAdmin(base.access) &&
      items.some((item) => item.definition.trigger.type === 'webhook.received'),
  });
  const names: SchemaNames = {
    hook: (hookId) => hooks.data?.items.find((hook) => hook.id === hookId)?.name,
    table: (id) => tables.data?.items.find((table) => table.id === id)?.name,
    field: (tableId, fieldId) =>
      fieldLists[fieldTables.indexOf(tableId)]?.data?.items.find((field) => field.id === fieldId)
        ?.name,
    view: (viewId) => {
      for (const views of viewLists) {
        const view = views.data?.items.find((item) => item.id === viewId);
        if (view !== undefined) return view.name;
      }
      return undefined;
    },
  };

  const focusRow = useCallback(
    (automation: AutomationDto) => {
      setStatus('all');
      setQuery('');
      window.setTimeout(() => {
        const element = document.getElementById(switchIdOf(automation, narrow ? 'card' : 'table'));
        element?.scrollIntoView({ block: 'center' });
        element?.focus();
      }, 0);
    },
    [narrow],
  );
  useAutomationRealtime(baseId, meId, (disabled) => {
    for (const automation of disabled) {
      showToast({
        variant: 'warning',
        message: t(`disabled.toast.${automation.disabled_reason ?? 'circuit_breaker'}`, {
          name: automation.name,
        }),
        actions: [
          {
            label: t('disabled.toast.view'),
            onClick: () => {
              focusRow(automation);
            },
          },
        ],
      });
    }
  });

  const toggle = (automation: AutomationDto, on: boolean) => {
    if (!on) {
      actions.disable.mutate(automation);
    } else if (automation.run_as.id !== meId) {
      setPending({ kind: 'enable', automation });
    } else {
      actions.enable.mutate(automation);
    }
  };
  const close = () => {
    setPending(null);
  };

  const forbidden = !manages || (isApiError(list.error) && list.error.status === 403);
  const counts = statusCounts(items);
  const shown = filterAutomations(items, status, query);
  const canCreate = manages && !forbidden && !narrow;
  const openCreate = () => {
    setPending({ kind: 'create' });
  };

  let body;
  if (forbidden) {
    body = (
      <Message icon={Lock} title={t('forbidden.title')} data-testid="automations-forbidden">
        <p className="max-w-[60ch] text-body text-fg-muted">{t('forbidden.description')}</p>
      </Message>
    );
  } else if (list.isPending) {
    body = <LoadingRows />;
  } else if (list.isError) {
    body = <ErrorAlert error={list.error} />;
  } else if (items.length === 0) {
    body = (
      <Message icon={Zap} title={t('empty.title')} data-testid="automations-empty">
        <p className="max-w-[60ch] text-body text-fg-muted">{t('empty.description')}</p>
        {canCreate ? (
          <Button onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t('page.create')}
          </Button>
        ) : null}
      </Message>
    );
  } else {
    const rowProps = {
      items: shown,
      names,
      meId,
      pendingId: actions.pendingId ?? duplicate.pendingId,
      onToggle: toggle,
      onTakeOver: (automation: AutomationDto) => {
        setPending({ kind: 'takeOver', automation });
      },
      onDelete: (automation: AutomationDto) => {
        setPending({ kind: 'delete', automation });
      },
      onDuplicate: duplicate.duplicate,
    };
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-[280px]">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-muted"
            />
            <Input
              type="search"
              value={query}
              placeholder={t('page.search')}
              aria-label={t('page.search')}
              className="pl-8"
              data-testid="automation-search"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <StatusTabs value={status} counts={counts} onChange={setStatus} />
        </div>
        {narrow ? (
          <p className="-mx-4 flex items-center gap-2 bg-surface-sunken px-4 py-2.5 text-label font-normal text-fg-muted">
            <Info aria-hidden="true" className="size-3.5 shrink-0" />
            {t('page.mobileNote')}
          </p>
        ) : null}
        {shown.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface p-6">
            <p className="text-body text-fg-muted">{t('empty.noMatch')}</p>
            <Button
              variant="secondary"
              size="sm"
              className="max-lg:h-control"
              onClick={() => {
                setStatus('all');
                setQuery('');
              }}
            >
              {t('empty.clear')}
            </Button>
          </div>
        ) : narrow ? (
          <AutomationCards {...rowProps} />
        ) : (
          <AutomationTable {...rowProps} caption={t('page.caption', { base: base.name })} />
        )}
      </>
    );
  }

  const tableName = (id: string) => tables.data?.items.find((table) => table.id === id)?.name;
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeader>
        <nav aria-label={t('page.breadcrumb')} className="min-w-0 shrink">
          <ol className="flex min-w-0 items-center gap-1.5">
            <li className="flex min-w-0 shrink items-center gap-1.5 max-sm:hidden">
              <span className="truncate text-body text-fg-muted">{base.name}</span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
            </li>
            <li aria-current="page" className="flex min-w-0 flex-col">
              <h1 className="truncate text-heading">{t('page.title')}</h1>
              {list.data === undefined ? null : (
                <span className="truncate text-label font-normal text-fg-muted sm:hidden">
                  {t('page.summary', { base: base.name, count: list.data.total })}
                </span>
              )}
            </li>
          </ol>
        </nav>
        {manages && !forbidden ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* T523: the runs of every automation of the base. */}
            <Button asChild variant="ghost" data-testid="base-runs-link">
              <Link to={baseRunsPath(baseId)}>
                <History aria-hidden="true" />
                <span className="max-sm:sr-only">{t('page.runs')}</span>
              </Link>
            </Button>
            {canCreate ? (
              <Button onClick={openCreate} data-testid="create-automation">
                <Plus aria-hidden="true" />
                {t('page.create')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PageHeader>
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-6 lg:py-4">{body}</div>

      {pending?.kind === 'create' ? (
        <CreateAutomationDialog
          base={base}
          onCancel={close}
          onContinue={(start) => {
            // T521: the builder creates it on the first save.
            const query = new URLSearchParams({ name: start.name, trigger: start.trigger });
            void navigate(`/b/${baseId}/automations/new?${query.toString()}`);
          }}
        />
      ) : null}
      {pending?.kind === 'enable' ? (
        <EnableDialog
          automation={pending.automation}
          baseName={base.name}
          pending={actions.enable.isPending}
          onCancel={close}
          onConfirm={() => {
            actions.enable.mutate(pending.automation, { onSettled: close });
          }}
        />
      ) : null}
      {pending?.kind === 'takeOver' ? (
        <TakeOverDialog
          automation={pending.automation}
          tableName={tableName}
          pending={actions.takeOver.isPending}
          onCancel={close}
          onConfirm={(enable) => {
            actions.takeOver.mutate(
              { automation: pending.automation, enable },
              { onSettled: close },
            );
          }}
        />
      ) : null}
      {pending?.kind === 'delete' ? (
        <DeleteAutomationDialog
          automation={pending.automation}
          pending={actions.remove.isPending}
          onCancel={close}
          onConfirm={() => {
            actions.remove.mutate(pending.automation, { onSettled: close });
          }}
        />
      ) : null}
      {duplicate.dialog}
    </div>
  );
}

export default AutomationListPage;
