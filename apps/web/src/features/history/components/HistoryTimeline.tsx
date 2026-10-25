import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isEditableField } from '../../../grid/editors/index';
import { orderGridFields, type GridField } from '../../../grid/types';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { canEditField } from '../../../lib/permissions/access';
import { recordHistoryQuery } from '../../../lib/query/queries';
import { useOnline } from '../../../lib/realtime/connection';
import { canRevert, groupHistory } from '../group';
import { useRevert } from '../revert';

import { HistoryEntry } from './HistoryEntry';

import type { HistoryScope } from '../../../lib/records/detail';

export interface HistoryTimelineProps extends HistoryScope {
  /** Only the changes of this field (cell history, `?field=`). */
  readonly fieldId?: string | undefined;
}

/** Loads the next page when the end of the list scrolls into view (FRONTEND §10.3). */
function useLoadMoreOnSight(enabled: boolean, loadMore: () => void) {
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(loadMore);
  useEffect(() => {
    latest.current = loadMore;
  });
  useEffect(() => {
    const element = sentinel.current;
    if (!enabled || element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [enabled]);
  return sentinel;
}

/**
 * The history of a record or of one of its cells (FRONTEND §10.3): newest
 * first, grouped by request (`batch`), cursor pages loaded as the list
 * scrolls. Only what the server returns is shown (fields the user cannot
 * read and deleted fields are left out by the API).
 */
export function HistoryTimeline({
  base,
  tableId,
  recordId,
  fields,
  fieldId,
}: HistoryTimelineProps) {
  const { t } = useTranslation(['history', 'grid']);
  const format = useFormatters();
  const online = useOnline();
  const history = useInfiniteQuery({
    ...recordHistoryQuery(tableId, recordId, fieldId),
    staleTime: 0,
  });
  const { revert, pending } = useRevert(tableId, recordId);
  // Relative times are computed against one "now" per render of the list.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // In display order (primary first, then position): the changes of an item follow it.
  const byId = useMemo(
    () =>
      new Map<string, GridField>(orderGridFields(fields).map((field) => [field.field.id, field])),
    [fields],
  );
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const items = useMemo(
    () => groupHistory(history.data?.pages.flatMap((page) => page.items) ?? []),
    [history.data],
  );
  const mayEdit = (id: string) => {
    const field = byId.get(id);
    return (
      online &&
      field !== undefined &&
      // `parent` (T465) is written like a cell (`PATCH`), without an overlay editor.
      (isEditableField(field) || field.field.type === 'parent') &&
      canEditField(base.access, tableId, id)
    );
  };

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  const sentinel = useLoadMoreOnSight(hasNextPage && !isFetchingNextPage, () => {
    void fetchNextPage();
  });

  if (history.isPending) {
    return (
      <div className="flex flex-col gap-3 py-3" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (history.isError && history.data === undefined) {
    return (
      <div className="flex flex-col items-start gap-2 py-3">
        <ErrorAlert error={history.error} />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void history.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="py-3 text-fg-muted">{t(fieldId === undefined ? 'none' : 'noneForField')}</p>
    );
  }
  return (
    <div className="flex flex-col">
      <ol className="flex flex-col divide-y divide-line" aria-label={t('timeline')}>
        {items.map((item) => (
          <HistoryEntry
            key={item.key}
            item={item}
            fields={byId}
            format={format}
            locale={locale}
            revertable={canRevert(item, mayEdit)}
            reverting={pending === item.head.id}
            onRevert={(auditId) => {
              void revert(auditId);
            }}
            singleField={fieldId !== undefined}
            now={now}
          />
        ))}
      </ol>
      {history.hasNextPage ? (
        <div ref={sentinel} className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
            }}
          >
            {history.isFetchingNextPage ? <Spinner /> : null}
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
      {history.isError ? <ErrorAlert error={history.error} /> : null}
    </div>
  );
}
