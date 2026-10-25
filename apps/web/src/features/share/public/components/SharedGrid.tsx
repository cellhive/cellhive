import { Alert, Button } from '@cellhive/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Suspense, use, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClipboardText,
  clipboardContent,
  GridView,
  type GridField,
  dataRangeOf,
  type GridInteractionHooks,
  type GridRecord,
  type GridViewport,
  computedErrorBadges,
  useRulePainter,
} from '../../../../grid';
import { useNumberFormat } from '../../../../lib/i18n/format';
import { keys, recordQueryHash } from '../../../../lib/query/keys';
import { RECORD_BLOCK_SIZE } from '../../../../lib/query/queries';
import { showToast } from '../../../../lib/toast/toast';
import { shortCount } from '../../../../lib/views/summary/format';
import { applicableSummaries } from '../../../../lib/views/summary/functions';
import { sharedColumns } from '../fields';
import { shareRowModel } from '../group-rows';
import { shareRecordQuery } from '../query';

import { useNarrow, type SharedViewProps } from './shared-view';
import { SharedCardList } from './SharedCardList';
import { SharedRecordDialog } from './SharedRecordDialog';
import { ShareViewHeader, useShareRefresh } from './ShareViewHeader';
import { hasViewerTools, ViewerTools } from './ViewerTools';

import type { SummaryBarLayout } from '../../../../lib/views/summary/types';

/**
 * A shared grid view, read-only (T317, FRONTEND §1.3): the grid adapter
 * without editors over the rows of `POST /shares/:token/records/query`,
 * loaded in windows of 200 like the member grid (the grid's block loader,
 * handed over by the route). Group headers with their counts when the view
 * is grouped; the viewer's filter/sort/search when the link allows them;
 * copy with `allow_copy`; the record detail with `show_record_detail`.
 * The files of an attachment cell open in the viewer from the cell (Enter,
 * double click) or the card, record detail or not (T419); downloads only
 * for `meta.download_fields`. Below 768 px a list of cards.
 */
export function SharedGrid({
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
  // A formula/lookup in error shows its token on the header too (T468; no details via a link).
  const errorBadges = useMemo(() => computedErrorBadges(columns), [columns]);
  const query = useMemo(() => shareRecordQuery(meta, choices), [meta, choices]);
  const hash = recordQueryHash({ view_id: meta.view.id, ...query });

  const fetchBlock = useCallback(
    async (index: number, signal: AbortSignal) => {
      try {
        return await api.query(
          {
            ...query,
            offset: index * RECORD_BLOCK_SIZE,
            limit: RECORD_BLOCK_SIZE,
            include_total: index === 0,
          },
          signal,
        );
      } catch (error) {
        onFatal(error);
        throw error;
      }
    },
    [api, query, onFatal],
  );
  // The grid's block loader, loaded with this chunk (suspends until then).
  const useWindowedRows = use(parts.loadWindowedRows());
  const { rows, snapshot } = useWindowedRows(
    keys.shareRowsScope(api.token),
    { view_id: meta.view.id, ...query },
    fetchBlock,
  );

  // Group headers: the view's saved group (the viewer cannot change it here).
  const grouped = meta.view.config.group.length > 0;
  // (T816) Color rules of the link's scope; the server names them in `record.meta.color`.
  const colors = useRulePainter(meta.view.config.color_rules);
  const counts = useQuery({
    queryKey: keys.shareGroupCounts(api.token, hash),
    queryFn: ({ signal }) =>
      api.groupCounts(
        {
          ...(query.filter === undefined ? {} : { filter: query.filter }),
          ...(query.search === undefined ? {} : { search: query.search }),
        },
        signal,
      ),
    enabled: grouped,
    retry: false,
  });
  const byId = useMemo(
    () => new Map<string, GridField>(columns.map((field) => [field.field.id, field])),
    [columns],
  );
  const ready = snapshot.status === 'ready';
  // Header rows between the data rows (T312 row model); never collapsed through a link.
  // The canvas grid draws every group as a card (T320a spacer rows); the card list does not.
  const rowModel = useMemo(
    () =>
      counts.data === undefined || !ready
        ? undefined
        : shareRowModel(
            counts.data.group.map((level) => byId.get(level.field)),
            counts.data.groups,
            snapshot.rowCount,
            { cards: !narrow },
          ),
    [counts.data, ready, snapshot.rowCount, byId, narrow],
  );
  const onViewportChange = useCallback(
    (viewport: Pick<GridViewport, 'firstRow' | 'lastRow'> & { dragging?: boolean }) => {
      rows.setViewport(viewport, viewport.dragging ?? false);
    },
    [rows],
  );
  // The card list speaks in display rows (headers included).
  const cardHeader = useCallback(
    (display: number) => {
      const kind = rowModel?.rowAt(display);
      if (kind?.kind !== 'group') return undefined;
      const { field, value, count, level } = kind.group;
      const text = field === undefined ? '' : cellClipboardText(field, value, locale);
      return {
        level,
        label: t('group.header', {
          field: field?.field.name ?? '',
          value: text === '' ? t('group.empty') : text,
          count,
        }),
      };
    },
    [rowModel, locale, t],
  );
  const cardRecord = useCallback(
    (display: number) => {
      const kind = rowModel?.rowAt(display) ?? { kind: 'data' as const, row: display };
      return kind.kind === 'data' ? rows.getRecord(kind.row) : undefined;
    },
    [rowModel, rows],
  );
  const onCardViewport = useCallback(
    (range: { firstRow: number; lastRow: number }) => {
      const data = dataRangeOf(rowModel, range.firstRow, range.lastRow);
      if (data !== undefined) rows.setViewport(data, false);
    },
    [rowModel, rows],
  );

  // The summary bar (T472) with the view's saved summaries, read-only (T470).
  const SummaryBar = parts.Toolbar.SummaryBar;
  const fieldDtos = useMemo(() => columns.map((column) => column.field), [columns]);
  const fieldsById = useMemo(
    () => new Map(fieldDtos.map((field) => [field.id as string, field])),
    [fieldDtos],
  );
  const summaryConfig = useMemo(
    () => applicableSummaries(meta.view.config.summaries, fieldDtos),
    [meta.view.config.summaries, fieldDtos],
  );
  const hasSummaries = SummaryBar !== undefined && Object.keys(summaryConfig).length > 0;
  const summaries = useQuery({
    queryKey: keys.shareSummaries(api.token, hash),
    queryFn: ({ signal }) =>
      api.summaries(
        {
          ...(query.filter === undefined ? {} : { filter: query.filter }),
          ...(query.search === undefined ? {} : { search: query.search }),
        },
        signal,
      ),
    enabled: hasSummaries,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const [columnLayout, setColumnLayout] = useState<SummaryBarLayout | null>(null);
  const barLayout = useMemo<SummaryBarLayout | null>(
    () =>
      narrow
        ? {
            gutter: 40,
            // Cards have no columns and nothing can be changed here: only the summaries set.
            columns: columns
              .filter((field) => summaryConfig[field.field.id] !== undefined)
              .map((field) => ({ fieldId: field.field.id, width: 140 })),
            frozen: 0,
            scroller: () => null,
          }
        : columnLayout,
    [narrow, columns, columnLayout, summaryConfig],
  );

  const { refetch: refetchCounts } = counts;
  const { refetch: refetchSummaries } = summaries;
  const { updatedAt, refresh } = useShareRefresh(() => {
    rows.refresh();
    if (grouped) void refetchCounts();
    if (hasSummaries) void refetchSummaries();
  });

  // Images of fields the link may download load as originals when no thumbnail exists (T409).
  const fileAccess = useMemo(() => {
    const downloadable = new Set<string>(meta.download_fields);
    return { canView: (fieldId: string) => downloadable.has(fieldId) };
  }, [meta.download_fields]);
  const [openRecord, setOpenRecord] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const primary = columns[0];
  const viewFiles = useCallback(
    (record: GridRecord, fieldId: string) => {
      const field = byId.get(fieldId);
      if (field === undefined) return;
      setViewing({
        value: record.fields[fieldId],
        fieldId,
        fieldName: field.field.name,
        recordTitle:
          primary === undefined
            ? ''
            : cellClipboardText(primary, record.fields[primary.field.id], locale),
      });
    },
    [byId, primary, locale],
  );
  const { allow_copy: allowCopy, show_record_detail: showDetail } = meta.settings;
  const hooks = useMemo<GridInteractionHooks>(
    () => ({
      readOnlyHint: t('view.readOnly'),
      fileViewer: {
        onViewFiles: (cell, record) => {
          viewFiles(record, cell.fieldId);
        },
      },
      selection: {
        onCopy: (range) => {
          if (!allowCopy) {
            showToast({ message: t('view.copyOff') });
            return null;
          }
          const fields = range.fieldIds
            .map((id) => byId.get(id))
            .filter((field) => field !== undefined);
          const matrix = async () => {
            const records = await rows.loadRows(range.firstRow, range.lastRow);
            return clipboardContent(
              records.map((record) =>
                fields.map((field) =>
                  cellClipboardText(field, record?.fields[field.field.id], locale),
                ),
              ),
            );
          };
          return matrix();
        },
      },
      ...(showDetail
        ? {
            recordDetail: {
              onOpenRecord: (recordId: string) => {
                setOpenRecord(recordId);
              },
            },
          }
        : {}),
    }),
    [t, allowCopy, showDetail, byId, rows, locale, viewFiles],
  );

  const count = !ready
    ? t('cards.loading')
    : snapshot.estimated
      ? t('view.recordsEstimated', {
          count: snapshot.rowCount,
          formattedCount: formatNumber(snapshot.rowCount),
        })
      : t('view.records', {
          count: snapshot.rowCount,
          formattedCount: formatNumber(snapshot.rowCount),
        });

  return (
    <main className="flex min-h-0 flex-1 flex-col">
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
                error={snapshot.error}
              />
            </Suspense>
          ) : undefined
        }
      />
      {snapshot.error !== null && snapshot.error !== undefined ? (
        <Alert variant="danger" className="m-4">
          <span>{t('view.loadFailed')}</span>{' '}
          <Button variant="secondary" size="sm" onClick={rows.retry}>
            {t('view.retry')}
          </Button>
        </Alert>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {narrow ? (
          <SharedCardList
            fields={columns}
            rowCount={rowModel?.displayCount ?? (ready ? snapshot.rowCount : 0)}
            rowHeader={cardHeader}
            getRecord={cardRecord}
            dataVersion={snapshot.version}
            onViewportChange={onCardViewport}
            locale={locale}
            label={t('cards.list')}
            onOpen={showDetail ? setOpenRecord : undefined}
            onViewFiles={viewFiles}
            allowCopy={allowCopy}
            scrollResetKey={hash}
          />
        ) : (
          <GridView
            fields={columns}
            rowCount={ready ? snapshot.rowCount : 0}
            rowModel={rowModel}
            getRecord={rows.getRecord}
            dataVersion={snapshot.version}
            onViewportChange={onViewportChange}
            density={meta.view.config.row_height === 'short' ? 'compact' : 'comfortable'}
            locale={locale}
            label={meta.view.name}
            scrollResetKey={hash}
            hooks={hooks}
            headerBadges={errorBadges}
            widths={meta.view.config.column_widths}
            fileAccess={fileAccess}
            freezeColumns={Math.max(1, meta.view.config.frozen_count)}
            onColumnLayout={hasSummaries ? setColumnLayout : undefined}
            colors={colors}
          />
        )}
        {ready && snapshot.rowCount === 0 ? (
          <p className="pointer-events-none absolute inset-x-0 top-24 px-6 text-center text-fg-muted">
            {t('view.empty')}
          </p>
        ) : null}
      </div>
      {hasSummaries && barLayout !== null ? (
        <Suspense fallback={null}>
          <SummaryBar
            layout={barLayout}
            fields={fieldsById}
            config={summaryConfig}
            result={summaries.data}
            busy={summaries.isFetching}
            error={summaries.error}
            onRetry={() => {
              void refetchSummaries();
            }}
            locale={locale}
            narrow={narrow}
            count={{
              short: ready ? shortCount(snapshot.rowCount, locale.locale) : '…',
              full: count,
              status: null,
            }}
          />
        </Suspense>
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
      {viewing === null ? null : (
        <Suspense fallback={null}>
          <parts.FileViewer
            value={viewing.value}
            fieldName={viewing.fieldName}
            recordTitle={viewing.recordTitle}
            canDownload={(meta.download_fields as readonly string[]).includes(viewing.fieldId)}
            onClose={() => {
              setViewing(null);
            }}
          />
        </Suspense>
      )}
    </main>
  );
}

/** The files of a cell open in the viewer (T419). */
interface Viewing {
  readonly value: unknown;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly recordTitle: string;
}

export default SharedGrid;
