import { Alert, Button, cn, Spinner } from '@cellhive/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Suspense, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../../grid/display/CellValue';
import { useNumberFormat } from '../../../../lib/i18n/format';
import { keys, recordQueryHash } from '../../../../lib/query/keys';
import { boardColumns, NO_VALUE, placeCards, type BoardColumn } from '../board';
import { sharedColumns } from '../fields';
import { shareRecordQuery } from '../query';

import { useNarrow, type SharedViewProps } from './shared-view';
import { SharedRecordDialog } from './SharedRecordDialog';
import { ShareViewHeader, useShareRefresh } from './ShareViewHeader';
import { hasViewerTools, ViewerTools } from './ViewerTools';

import type { GridField } from '../../../../grid';
import type { RecordDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** Cards per request, in the order of the view. */
export const BOARD_PAGE_SIZE = 200;

/** A kanban group field: a single select or a single user field (CONTRACTS §15). */
function isGroupField(field: GridField | undefined): field is GridField {
  const config = field?.config;
  return (config?.type === 'select' || config?.type === 'user') && !config.options.multiple;
}

interface CardProps {
  readonly record: RecordDto;
  readonly primary: GridField | undefined;
  readonly fields: readonly GridField[];
  readonly locale: LocaleContext;
  readonly onOpen: ((recordId: string) => void) | undefined;
}

function Card({ record, primary, fields, locale, onOpen }: CardProps) {
  const { t } = useTranslation('sharePage');
  const body = (
    <>
      <span className="text-body font-semibold break-words">
        {primary === undefined ? null : (
          <CellValue
            links={onOpen === undefined}
            field={primary}
            value={record.fields[primary.field.id]}
            locale={locale}
            empty={t('cards.untitled')}
          />
        )}
      </span>
      {fields.map((field) => (
        <span
          key={field.field.id}
          className="flex min-w-0 items-center gap-2 text-label font-normal"
        >
          <span className="w-20 shrink-0 truncate text-fg-muted">{field.field.name}</span>
          <CellValue
            links={onOpen === undefined}
            field={field}
            value={record.fields[field.field.id]}
            locale={locale}
            empty="—"
            compact
            className="min-w-0 flex-1"
          />
        </span>
      ))}
    </>
  );
  const className =
    'flex w-full flex-col items-stretch gap-1 rounded-md border border-line bg-surface p-3 text-left';
  return onOpen === undefined ? (
    <div className={className} data-testid="share-card">
      {body}
    </div>
  ) : (
    <button
      type="button"
      className={cn(className, 'hover:border-line-strong')}
      data-testid="share-card"
      onClick={() => {
        onOpen(record.id);
      }}
    >
      {body}
    </button>
  );
}

interface ColumnProps {
  readonly column: BoardColumn;
  readonly groupField: GridField;
  readonly cards: readonly RecordDto[];
  readonly card: Omit<CardProps, 'record'>;
  readonly locale: LocaleContext;
}

function Column({ column, groupField, cards, card, locale }: ColumnProps) {
  const { t } = useTranslation('sharePage');
  const headingId = useId();
  const count = column.count ?? cards.length;
  const format = useNumberFormat();
  return (
    <section
      aria-labelledby={headingId}
      className="flex w-[85vw] max-w-72 shrink-0 snap-start flex-col gap-2 rounded-lg bg-surface-sunken p-2 sm:w-72"
      data-testid="share-board-column"
    >
      <h2 id={headingId} className="flex items-center justify-between gap-2 px-1 text-label">
        <span className="min-w-0 truncate">
          {column.key === NO_VALUE ? (
            t('board.noValue')
          ) : (
            <CellValue field={groupField} value={column.value} locale={locale} compact />
          )}
        </span>
        <span className="shrink-0 font-normal text-fg-muted">{format(count)}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="px-1 py-2 text-label font-normal text-fg-muted">{t('board.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((record) => (
            <li key={record.id}>
              <Card record={record} {...card} />
            </li>
          ))}
        </ul>
      )}
      {cards.length < count ? (
        <p className="px-1 text-label font-normal text-fg-muted">
          {t('board.shown', { shown: format(cards.length), count })}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A shared kanban view, read-only (T317, FRONTEND §6.6): no dragging, no
 * adding. Cards come in the order of the view, 200 at a time ("Load more"),
 * and go to the column of their group value; the column counts come from
 * `group-counts` by the board's group field (allowed without
 * `allow_viewer_filter_sort`, CONTRACTS §16A). A group field outside the
 * link's fields: one list of every card.
 */
export function SharedBoard({
  meta,
  api,
  parts,
  locale,
  choices,
  onChoices,
  onFatal,
  download,
}: SharedViewProps) {
  const { t } = useTranslation('sharePage');
  const formatNumber = useNumberFormat();
  const narrow = useNarrow();
  const columns = useMemo(() => sharedColumns(meta), [meta]);
  const byId = useMemo(
    () => new Map<string, GridField>(columns.map((field) => [field.field.id, field])),
    [columns],
  );
  const kanban = meta.view.config.kanban;
  const candidate =
    kanban?.group_field === null || kanban === undefined ? undefined : byId.get(kanban.group_field);
  const groupField = isGroupField(candidate) ? candidate : undefined;
  const primary = columns.find((field) => field.field.is_primary);
  const cardFields = useMemo(() => {
    const wanted = new Set(kanban?.card_fields ?? []);
    return columns.filter((field) => !field.field.is_primary && wanted.has(field.field.id));
  }, [columns, kanban?.card_fields]);

  const query = useMemo(() => shareRecordQuery(meta, choices), [meta, choices]);
  const hash = recordQueryHash({ view_id: meta.view.id, ...query });
  const pages = useInfiniteQuery({
    queryKey: keys.shareCards(api.token, hash),
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await api.query(
          { ...query, offset: pageParam, limit: BOARD_PAGE_SIZE, include_total: pageParam === 0 },
          signal,
        );
      } catch (error) {
        onFatal(error);
        throw error;
      }
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.records.length === BOARD_PAGE_SIZE ? all.length * BOARD_PAGE_SIZE : undefined,
    retry: false,
  });
  const counts = useQuery({
    queryKey: keys.shareGroupCounts(api.token, `board:${groupField?.field.id ?? ''}:${hash}`),
    queryFn: ({ signal }) =>
      api.groupCounts(
        {
          group: [{ field: groupField?.field.id ?? '', direction: 'asc' }],
          ...(query.filter === undefined ? {} : { filter: query.filter }),
          ...(query.search === undefined ? {} : { search: query.search }),
        },
        signal,
      ),
    enabled: groupField !== undefined,
    retry: false,
  });

  const records = useMemo(
    () => pages.data?.pages.flatMap((page) => page.records) ?? [],
    [pages.data],
  );
  const placed = useMemo(
    () =>
      groupField === undefined ? new Map<string, RecordDto[]>() : placeCards(groupField, records),
    [groupField, records],
  );
  const boardColumnsList = useMemo(
    () =>
      groupField === undefined
        ? []
        : boardColumns(
            groupField,
            counts.data?.groups,
            kanban?.hide_empty_columns ?? false,
            placed,
          ),
    [groupField, counts.data, kanban?.hide_empty_columns, placed],
  );

  const { refetch: refetchPages } = pages;
  const { refetch: refetchCounts } = counts;
  const { updatedAt, refresh } = useShareRefresh(() => {
    void refetchPages();
    if (groupField !== undefined) void refetchCounts();
  });
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const { allow_copy: allowCopy, show_record_detail: showDetail } = meta.settings;
  const card = {
    primary,
    fields: cardFields,
    locale,
    onOpen: showDetail ? setOpenRecord : undefined,
  };

  const first = pages.data?.pages[0];
  const estimated = first !== undefined && 'total_estimate' in first;
  const total =
    first === undefined
      ? null
      : 'total' in first
        ? first.total
        : 'total_estimate' in first
          ? first.total_estimate
          : null;
  const count =
    total === null
      ? t('cards.loading')
      : t(estimated ? 'view.recordsEstimated' : 'view.records', {
          count: total,
          formattedCount: formatNumber(total),
        });

  let content;
  if (pages.isPending) {
    content = (
      <p role="status" className="flex items-center gap-2 p-6 text-fg-muted">
        <Spinner />
        {t('board.loading')}
      </p>
    );
  } else if (pages.isError) {
    content = (
      <Alert variant="danger" className="m-4">
        <span>{t('view.loadFailed')}</span>{' '}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void refetchPages();
          }}
        >
          {t('view.retry')}
        </Button>
      </Alert>
    );
  } else if (groupField === undefined) {
    content = (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-fg-muted">{t('board.noGroup')}</p>
        <section aria-label={t('board.all')} className="max-w-xl">
          <ul className="flex flex-col gap-2">
            {records.map((record) => (
              <li key={record.id}>
                <Card record={record} {...card} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  } else {
    content = (
      <div
        role="region"
        aria-label={t('board.label', { field: groupField.field.name })}
        tabIndex={0}
        className={cn(
          'flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4',
          narrow && 'snap-x snap-mandatory',
        )}
        data-testid="share-board"
      >
        {boardColumnsList.map((column) => (
          <Column
            key={column.key}
            column={column}
            groupField={groupField}
            cards={placed.get(column.key) ?? []}
            card={card}
            locale={locale}
          />
        ))}
      </div>
    );
  }

  return (
    <main className={cn('flex min-h-0 flex-1 flex-col', !allowCopy && 'select-none')}>
      <ShareViewHeader
        meta={meta}
        download={download}
        count={count}
        updatedAt={updatedAt}
        onRefresh={refresh}
        tools={
          hasViewerTools(meta) ? (
            <Suspense fallback={null}>
              <ViewerTools
                meta={meta}
                parts={parts}
                choices={choices}
                onChoices={onChoices}
                error={pages.error}
              />
            </Suspense>
          ) : undefined
        }
      />
      {content}
      {pages.hasNextPage ? (
        <div className="flex justify-center p-4">
          <Button
            variant="secondary"
            disabled={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            {pages.isFetchingNextPage ? <Spinner /> : null}
            {t('board.loadMore')}
          </Button>
        </div>
      ) : null}
      <SharedRecordDialog
        api={api}
        recordId={openRecord}
        onClose={() => {
          setOpenRecord(null);
        }}
        columns={columns}
        locale={locale}
        allowCopy={allowCopy}
        downloadFields={meta.download_fields}
        Files={parts.Files}
      />
    </main>
  );
}

export default SharedBoard;
