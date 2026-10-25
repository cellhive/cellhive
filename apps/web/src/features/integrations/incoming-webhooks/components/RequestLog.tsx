import { INCOMING_WEBHOOK_REQUEST_RETENTION_DAYS } from '@cellhive/contracts';
import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CopyX, Inbox, Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { incomingWebhooksApi } from '../api';
import { hookKeys } from '../cache';
import { formatBytes } from '../model';

import type { IncomingWebhookDto } from '@cellhive/contracts';

/** Requests per page of the log. */
const PAGE_SIZE = 50;

/**
 * The request log of a webhook (`GET …/requests`, CONTRACTS §25.1):
 * newest first, metadata only — time, size, replay (`duplicate`), a
 * continued automation chain (`causation_accepted`) and the event, with a
 * link to the base's run history. Never body, headers or query. No realtime:
 * refetched when the window regains focus and with "Refresh".
 */
export function RequestLog({
  baseId,
  hook,
}: {
  readonly baseId: string;
  readonly hook: IncomingWebhookDto;
}) {
  const { t } = useTranslation('incomingWebhooks');
  const format = useFormatters();
  const log = useInfiniteQuery({
    queryKey: hookKeys.requests(baseId, hook.id),
    queryFn: ({ pageParam, signal }) =>
      incomingWebhooksApi.requests(hook.id, { cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const runsPath = `/b/${encodeURIComponent(baseId)}/automations/runs`;

  return (
    <div className="flex flex-col gap-3" data-testid="hook-log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label font-normal text-fg-muted">
          {t('log.note', { days: INCOMING_WEBHOOK_REQUEST_RETENTION_DAYS })}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="max-lg:h-control"
          disabled={log.isFetching}
          data-testid="hook-log-refresh"
          onClick={() => {
            void log.refetch();
          }}
        >
          {log.isFetching ? <Spinner /> : <RefreshCw aria-hidden="true" />}
          {t('log.refresh')}
        </Button>
      </div>
      {log.isPending ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t('log.loading')}
          className="flex flex-col gap-2"
        >
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12" />
          ))}
        </div>
      ) : log.isError ? (
        <ErrorAlert error={log.error} />
      ) : items.length === 0 ? (
        <div
          className="flex flex-col items-start gap-2 rounded-lg border border-line bg-surface p-4"
          data-testid="hook-log-empty"
        >
          <Inbox aria-hidden="true" className="size-5 text-fg-muted" />
          <p className="text-body text-fg-muted">{t('log.empty')}</p>
        </div>
      ) : (
        <ol
          aria-label={t('log.listLabel', { name: hook.name })}
          className="flex flex-col rounded-lg border border-line"
        >
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="hook-log-row"
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-t border-line px-3 py-2.5 first:border-t-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <time
                  dateTime={item.received_at}
                  className="text-body font-medium text-fg tabular-nums"
                >
                  {format.dateTime(item.received_at)}
                </time>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label font-normal text-fg-muted">
                  <span>
                    {t('log.size', { size: formatBytes(item.size_bytes, format.locale) })}
                  </span>
                  {item.duplicate ? (
                    <span
                      className="inline-flex items-center gap-1 text-fg"
                      data-testid="hook-log-duplicate"
                    >
                      <CopyX aria-hidden="true" className="size-3.5" />
                      {t('log.duplicate')}
                    </span>
                  ) : null}
                  {item.causation_accepted ? (
                    <span
                      className="inline-flex items-center gap-1 text-fg"
                      data-testid="hook-log-causation"
                    >
                      <Link2 aria-hidden="true" className="size-3.5" />
                      {t('log.causation')}
                    </span>
                  ) : null}
                </span>
              </div>
              {item.event_id === null ? null : (
                <Link
                  to={`${runsPath}?event=${encodeURIComponent(item.event_id)}&range=all`}
                  className="inline-flex min-h-6 items-center text-label text-accent underline-offset-4 hover:underline max-lg:min-h-control"
                  aria-label={t('log.runsFor', { time: format.dateTime(item.received_at) })}
                >
                  {t('log.runs')}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
      {log.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            disabled={log.isFetchingNextPage}
            onClick={() => {
              void log.fetchNextPage();
            }}
          >
            {log.isFetchingNextPage ? <Spinner /> : null}
            {t('log.more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
