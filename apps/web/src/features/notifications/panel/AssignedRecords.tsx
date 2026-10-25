import { Button, cn } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FileText } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { api } from '../../../lib/api';
import { useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { assignedRecordRows } from '../model/records';

import { useItemFields } from './use-item-view';

import type { NotificationDto } from '@cellhive/contracts';

const enc = encodeURIComponent;

function RecordList({
  item,
  tableId,
  baseId,
  ids,
  count,
  listId,
  onOpen,
}: {
  readonly item: NotificationDto;
  readonly tableId: string;
  readonly baseId: string;
  readonly ids: readonly string[];
  readonly count: number;
  readonly listId: string;
  readonly onOpen: (item: NotificationDto) => void;
}) {
  const { t } = useTranslation('notifications');
  const format = useFormatters();
  const fields = useItemFields(item);
  const primary = fields.data?.items.find((field) => field.is_primary)?.id ?? null;
  // Titles as the viewer reads them now: read rule, trash and field access
  // apply; records they cannot read any more are simply absent (CONTRACTS §1.4).
  const records = useQuery({
    queryKey: keys.notificationRecords(tableId, ids.join(',')),
    queryFn: ({ signal }) =>
      api.records.query(
        tableId,
        {
          ids: [...ids],
          fields: primary === null ? [] : [primary],
          limit: ids.length,
          include_total: false,
        },
        { signal, cellFormat: 'text' },
      ),
    enabled: !fields.isPending,
  });
  if (records.isPending) {
    return (
      <p
        id={listId}
        role="status"
        aria-busy="true"
        className="py-1 text-label font-normal text-fg-muted"
      >
        {t('item.records.loading')}
      </p>
    );
  }
  if (records.isError) {
    return (
      <div id={listId} role="alert" className="flex flex-wrap items-center gap-2 py-1">
        <span className="text-label font-normal text-fg-muted">{t('item.records.error')}</span>
        <Button
          variant="ghost"
          size="sm"
          className="max-lg:h-control"
          onClick={() => {
            void records.refetch();
          }}
        >
          {t('item.records.retry')}
        </Button>
      </div>
    );
  }
  const rows = assignedRecordRows(ids, records.data.records, primary);
  const more = count - rows.length;
  const tableLink = `/b/${enc(baseId)}/t/${enc(tableId)}`;
  return (
    <div
      id={listId}
      className="flex flex-col gap-1 py-1"
      data-testid={`assigned-records-${item.id}`}
    >
      {rows.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('item.records.none')}</p>
      ) : (
        <ul
          aria-label={t(
            item.type === 'record.followed_changed'
              ? 'item.records.listFollowed'
              : 'item.records.list',
          )}
          className="flex list-none flex-col"
        >
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to={`${tableLink}?record=${enc(row.id)}`}
                className="flex min-h-8 items-center gap-2 rounded-sm px-1 text-label font-normal text-fg underline-offset-2 hover:bg-surface-sunken hover:underline max-lg:min-h-control"
                onClick={() => {
                  onOpen(item);
                }}
              >
                <FileText aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                <span className="min-w-0 truncate">{row.title ?? t('item.records.untitled')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="flex flex-wrap items-center gap-x-2 text-label font-normal text-fg-muted">
        {more > 0 ? (
          <span>{t('item.records.more', { count: more, formatted: format.number(more) })}</span>
        ) : null}
        <Link
          to={tableLink}
          className="text-accent underline-offset-4 hover:underline max-lg:py-3"
          onClick={() => {
            onOpen(item);
          }}
        >
          {t('item.records.openTable')}
        </Link>
      </p>
    </div>
  );
}

/**
 * The records of a bulk `record.assigned` (T552: the task's "list of 20
 * records in the popover" option — no URL parameter filters a table on
 * record ids, and the S5b board is not drawn yet): a disclosure button, then up to 20 records (primary
 * field as text, as the viewer reads them now) each opening the record,
 * "And 180 more records" and "Open the table". Fetched on first expansion.
 */
export function AssignedRecords({
  item,
  ids,
  count,
  onOpen,
}: {
  readonly item: NotificationDto;
  readonly ids: readonly string[];
  readonly count: number;
  readonly onOpen: (item: NotificationDto) => void;
}) {
  const { t } = useTranslation('notifications');
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (item.table_id === null || item.base === null) return null;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        data-testid={`show-records-${item.id}`}
        className="inline-flex min-h-8 items-center gap-1 self-start rounded-sm text-label font-medium text-accent underline-offset-4 hover:underline max-lg:min-h-control"
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        {t('item.records.show')}
        <ChevronDown
          aria-hidden="true"
          className={cn('size-4 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded ? (
        <RecordList
          item={item}
          tableId={item.table_id}
          baseId={item.base.id}
          ids={ids}
          count={count}
          listId={listId}
          onOpen={onOpen}
        />
      ) : null}
    </div>
  );
}
