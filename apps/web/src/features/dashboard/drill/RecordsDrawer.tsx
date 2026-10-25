import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Suspense, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { toGridField } from '../../../grid/types';
import { useFormatters } from '../../../lib/i18n/format';
import { loadDashboardsApi } from '../../../lib/query/dashboards';
import { fieldsQuery, tableQuery } from '../../../lib/query/queries';
import { shouldRetryWidget, widgetDataHash, type WidgetDataContext } from '../api';
import { widgetRequests } from '../model/limit';
import { WidgetMessage } from '../widgets/WidgetMessage';

import type { RecordDetailComponents } from '../../../lib/records/detail';
import type { RecordsRequest } from '../view/widget-actions';
import type { BaseDetail, FieldDto, RecordDto } from '@cellhive/contracts';

/** Records of one page of the drawer (CONTRACTS §28.4: default 50, at most 200). */
export const DRILL_PAGE_SIZE = 50;
/** Columns of the list besides the primary field. */
const MAX_COLUMNS = 5;
const NARROW_QUERY = '(max-width: 767px)';

function subscribeNarrow(onChange: () => void) {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null;
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}
const isNarrow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;

/** Field ids a widget's config names (dimension, series, metrics): shown first. */
function widgetFieldIds(config: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === 'string') {
      if ((key === 'field' || key === 'date_field') && value.startsWith('fld_')) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => {
        visit(item, key === 'fields' ? 'field' : null);
      });
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) visit(item, name);
    }
  };
  visit(config, null);
  return [...new Set(found)];
}

/**
 * Click-through (T813, CONTRACTS §28.4, S7 decision #9): the records behind
 * a widget or one of its groups, `POST /widgets/:id/records` with the same
 * live filters — only what the viewer reads (record and field rules), never
 * through a share link. A panel at the right edge (full screen below
 * 768 px), not modal so the record panel of the grid (`RecordDetail.Panel`,
 * given by the app layer, F§1.2) opens over it; Escape or the close button
 * close it and focus goes back where it was.
 */
export default function RecordsDrawer({
  request,
  base,
  context,
  RecordDetail,
  onClose,
}: {
  readonly request: RecordsRequest;
  readonly base: BaseDetail;
  readonly context: WidgetDataContext;
  readonly RecordDetail?: RecordDetailComponents | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  const tableId = (request.widget.config as { table_id?: string }).table_id ?? '';
  const table = useQuery(tableQuery(tableId));
  const fields = useQuery(fieldsQuery(tableId));
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );

  const pages = useInfiniteQuery({
    queryKey: [
      'widget',
      request.widget.id,
      widgetDataHash(request.widget, context, request.filters),
      'records',
      request.segment,
    ] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      widgetRequests.run(
        async () =>
          (await loadDashboardsApi()).widgetRecords(
            request.widget.id,
            {
              segment: request.segment,
              filters: [...request.filters],
              timezone: context.timezone,
              offset: pageParam,
              limit: DRILL_PAGE_SIZE,
            },
            signal,
          ),
        signal,
      ),
    getNextPageParam: (last) => {
      const next = last.offset + last.records.length;
      const total = last.total ?? last.total_estimate;
      if (last.records.length < last.limit) return undefined;
      return total !== undefined && next >= total ? undefined : next;
    },
    retry: shouldRetryWidget,
  });
  const first = pages.data?.pages[0];
  const records = useMemo<RecordDto[]>(
    () => pages.data?.pages.flatMap((page) => page.records) ?? [],
    [pages.data],
  );

  useEffect(() => {
    // After the frame: a menu that opened the drawer gives focus back to its trigger first.
    const frame = requestAnimationFrame(() => {
      opener.current = document.activeElement;
      panel.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (opener.current instanceof HTMLElement && opener.current.isConnected) {
        opener.current.focus();
      }
    };
  }, []);
  // Escape closes the drawer wherever focus is (it is not modal), unless a record, menu or dialog is open.
  const recordOpen = openRecord !== null;
  useEffect(() => {
    if (recordOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="menu"], dialog[open]') !== null) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [recordOpen, onClose]);

  const columns = useMemo<FieldDto[]>(() => {
    const list = fields.data?.items ?? [];
    const present = new Set(records.flatMap((record) => Object.keys(record.fields)));
    const primary = table.data?.primary_field_id;
    const readable = list.filter((field) => field.id !== primary && present.has(field.id));
    const named = widgetFieldIds(request.widget.config);
    readable.sort(
      (a, b) =>
        (named.includes(a.id) ? named.indexOf(a.id) : named.length + list.indexOf(a)) -
        (named.includes(b.id) ? named.indexOf(b.id) : named.length + list.indexOf(b)),
    );
    return readable.slice(0, MAX_COLUMNS);
  }, [fields.data, records, table.data?.primary_field_id, request.widget.config]);
  const primaryField = fields.data?.items.find(
    (field) => field.id === table.data?.primary_field_id,
  );

  const openIndex = openRecord === null ? -1 : records.findIndex((item) => item.id === openRecord);
  const total = first?.total ?? first?.total_estimate;

  const body = () => {
    if (pages.isPending || fields.isPending || table.isPending) {
      return (
        <div className="flex flex-col gap-2 p-4" aria-hidden="true">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      );
    }
    if (pages.isError) {
      return (
        <WidgetMessage
          kind="error"
          title={t('drill.failed')}
          onRetry={() => {
            void pages.refetch();
          }}
        />
      );
    }
    if (first?.status === 'no_permission') {
      return <WidgetMessage kind="no_permission" title={t('state.noPermission')} />;
    }
    if (first?.status === 'broken') {
      return <WidgetMessage kind="broken" title={t('state.broken.title')} />;
    }
    if (records.length === 0) {
      return <WidgetMessage kind="empty" title={t('drill.empty')} />;
    }
    return (
      <div
        className="min-h-0 flex-1 overflow-auto"
        role="region"
        aria-labelledby={titleId}
        tabIndex={0}
      >
        <table className="w-full border-collapse text-left text-body" data-testid="drill-records">
          <caption className="sr-only">{t('drill.caption', { title: request.title })}</caption>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th
                scope="col"
                className="border-b border-line px-3 py-2 text-label font-medium text-fg-muted"
              >
                {primaryField?.name ?? t('drill.record')}
              </th>
              {columns.map((field) => (
                <th
                  key={field.id}
                  scope="col"
                  className="border-b border-line px-3 py-2 text-label font-medium text-fg-muted"
                >
                  {field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const title = primaryField === undefined ? null : record.fields[primaryField.id];
              return (
                <tr key={record.id} data-record-id={record.id}>
                  <th
                    scope="row"
                    className="max-w-64 border-b border-line px-3 py-1.5 text-left font-normal"
                  >
                    <button
                      type="button"
                      className="max-w-full truncate text-left text-accent underline-offset-4 hover:underline disabled:text-fg disabled:no-underline"
                      disabled={RecordDetail === undefined}
                      data-testid="drill-open-record"
                      onClick={() => {
                        setOpenRecord(record.id);
                      }}
                    >
                      {primaryField === undefined ? (
                        record.id
                      ) : (
                        <CellValue
                          field={toGridField(primaryField)}
                          value={title}
                          locale={locale}
                          compact
                        />
                      )}
                    </button>
                  </th>
                  {columns.map((field) => (
                    <td
                      key={field.id}
                      className="max-w-64 border-b border-line px-3 py-1.5 align-top"
                    >
                      <CellValue
                        field={toGridField(field)}
                        value={record.fields[field.id]}
                        locale={locale}
                        compact
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {pages.hasNextPage ? (
          <div className="flex justify-center p-3">
            <Button
              variant="secondary"
              disabled={pages.isFetchingNextPage}
              onClick={() => {
                void pages.fetchNextPage();
              }}
            >
              {pages.isFetchingNextPage ? <Spinner aria-hidden="true" /> : null}
              {t('drill.more')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <section
        ref={panel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="drill-drawer"
        className={
          narrow
            ? 'fixed inset-0 z-40 flex flex-col bg-surface text-fg outline-none'
            : 'fixed top-0 right-0 bottom-0 z-40 flex w-[min(640px,100vw)] flex-col border-l border-line bg-surface text-fg shadow-popover outline-none'
        }
      >
        <header className="flex items-start gap-2 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={titleId} className="truncate text-heading font-semibold">
              {t('drill.title', { title: request.title })}
            </h2>
            <p
              className="truncate text-label font-normal text-fg-muted"
              data-testid="drill-summary"
            >
              {[
                request.segmentLabel,
                total === undefined
                  ? null
                  : t(first?.total === undefined ? 'drill.countEstimate' : 'drill.count', {
                      count: total,
                      formatted: new Intl.NumberFormat(format.locale).format(total),
                    }),
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('drill.close')}
            data-testid="drill-close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        {body()}
      </section>
      {RecordDetail === undefined || openRecord === null || table.data === undefined ? null : (
        <Suspense fallback={null}>
          <RecordDetail.Panel
            base={base}
            tableId={tableId}
            tableName={table.data.name}
            recordId={openRecord}
            fields={fields.data?.items ?? []}
            hiddenFieldIds={[]}
            initialRecord={records[openIndex]}
            neighbors={{
              previous: records[openIndex - 1]?.id ?? null,
              next: records[openIndex + 1]?.id ?? null,
            }}
            onNavigate={setOpenRecord}
            onClose={() => {
              const id = openRecord;
              setOpenRecord(null);
              requestAnimationFrame(() => {
                panel.current
                  ?.querySelector<HTMLElement>(`[data-record-id="${id}"] button`)
                  ?.focus();
              });
            }}
            fullScreen={narrow}
            History={RecordDetail.History}
            CellHistory={RecordDetail.CellHistory}
            Attachments={RecordDetail.Attachments}
          />
        </Suspense>
      )}
    </>
  );
}
