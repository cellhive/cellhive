import { FIELD_TYPE_REGISTRY, type LocaleContext } from '@cellhive/field-types';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
} from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Link2,
  Lock,
  Maximize2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Unlink,
} from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { CellValue } from '../../../grid/display/CellValue';
import { orderGridFields, type GridField } from '../../../grid/types';
import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { useFormatters } from '../../../lib/i18n/format';
import {
  linkDisplayValue,
  linkRefsOf,
  linkText,
  linkTargetDeleted,
  linkWriteValue,
  type LinkRef,
} from '../../../lib/links/values';
import { canAddRecord, canPickLinks, canSaveViewConfig } from '../../../lib/permissions/access';
import { fieldsQuery, tablesQuery } from '../../../lib/query/queries';
import { RECORD_PARAM } from '../../../lib/records/detail';
import { cachedRecord, putCachedRecord } from '../../../lib/records/record-sync';
import { dismissToast, showErrorToast, showToast } from '../../../lib/toast/toast';
import { linkedSearchParam } from '../../../lib/views/linked-filter';
import { useViewConfig } from '../../../lib/views/use-view-config';
import { usePanelEditing, type PanelEditing } from '../use-panel-editing';

import { ColumnPicker } from './ColumnPicker';
import {
  columnTotal,
  readableIds,
  resolveColumns,
  restoreLink,
  SUBTABLE_EXPANDED_CAP,
  SUBTABLE_ROW_CAP,
  subTableRows,
  summedColumn,
  withoutLink,
  type SubTableRow,
} from './model';
import { isNumericField, SubTableCell } from './SubTableCell';
import { useLinkedRecords } from './use-linked-records';

import type { LinkComponents } from '../../../lib/links/picker';
import type { BaseDetail, RecordDto, ViewDto } from '@cellhive/contracts';

/** Props of the sub-table of one link field of the record panel (T416). */
export interface LinkedSubTableProps {
  readonly base: BaseDetail;
  /** Table of the record the panel shows. */
  readonly tableId: string;
  /** The link field (`field.link` set). */
  readonly field: GridField;
  readonly record: RecordDto;
  /** The record's title (the picker's header). */
  readonly recordTitle: string;
  /** Edit flow of the panel's table: link writes (unlink, link existing). */
  readonly editing: PanelEditing;
  readonly locale: LocaleContext;
  /** The view open behind the panel: the columns are saved to it (`record_detail`). */
  readonly view?: ViewDto | undefined;
  /** Below 640 px: a list of cards (board "Chi tiết record trên mobile"). */
  readonly narrow: boolean;
  /** Below 768 px: the picker covers the screen. */
  readonly fullScreen: boolean;
  readonly Link?: LinkComponents | undefined;
  readonly userId: string | null;
}

/** Where the sub-table's columns are kept. */
interface ColumnsState {
  /** Saved columns of this link field; `undefined` → the defaults. */
  readonly saved: readonly string[] | undefined;
  /** The view they are saved to, `null` when kept on this device only. */
  readonly savedIn: string | null;
  readonly set: (columns: string[]) => void;
}

/** Columns kept in the view's config (saved when the user may, else temporary, T310/T311). */
function ViewColumns({
  view,
  base,
  tableId,
  fieldId,
  children,
}: {
  view: ViewDto;
  base: BaseDetail;
  tableId: string;
  fieldId: string;
  children: (columns: ColumnsState) => ReactNode;
}) {
  const state = useViewConfig(view, canSaveViewConfig(base.access, tableId, view));
  const all = state.config.record_detail?.link_columns;
  const { change } = state;
  const set = useCallback(
    (columns: string[]) => {
      change({ record_detail: { link_columns: { ...all, [fieldId]: columns } } });
    },
    [change, all, fieldId],
  );
  return children({ saved: all?.[fieldId], savedIn: state.canSave ? view.name : null, set });
}

/** No view behind the panel: the choice lives as long as the panel. */
function LocalColumns({ children }: { children: (columns: ColumnsState) => ReactNode }) {
  const [saved, setSaved] = useState<string[] | undefined>(undefined);
  return children({ saved, savedIn: null, set: setSaved });
}

/** A value of a card's second line (board: "VT-0211 · SL 2 cái"). */
function cardText(field: GridField, value: unknown, locale: LocaleContext): string {
  if (field.link !== undefined) return linkText(linkRefsOf(value));
  const config = field.config;
  if (config === null)
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (value === null || value === undefined || value === '') return '';
  return (
    FIELD_TYPE_REGISTRY[config.type] as {
      formatText: (value: unknown, options: unknown, ctx: LocaleContext) => string;
    }
  ).formatText(value, config.options, locale);
}

/**
 * The linked table is not readable (FRONTEND §10.2): the number of links
 * and a lock, no rows (board: "2 liên kết. Bạn không có quyền xem bảng
 * Tickets."). Shaped like a field row of the panel.
 */
function LockedLinks({
  baseId,
  field,
  count,
}: {
  baseId: string;
  field: GridField;
  count: number;
}) {
  const { t } = useTranslation('subtable');
  const labelId = useId();
  // Usually absent: the base's table list leaves out tables the user cannot read.
  const tables = useQuery(tablesQuery(baseId));
  const table = tables.data?.items.find((item) => item.id === field.link?.link_table);
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="subtable-locked"
      className="grid grid-cols-1 items-center gap-y-0.5 sm:min-h-9 sm:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)] sm:gap-x-4"
    >
      <span
        id={labelId}
        className="truncate px-2 text-label font-normal text-fg-muted sm:px-0 sm:text-body"
      >
        {field.field.name}
      </span>
      <span className="flex min-h-8 items-center gap-1.5 px-2 text-label font-normal text-fg-muted">
        <Lock aria-hidden="true" className="size-3 shrink-0" />
        {table === undefined
          ? t('lockedUnnamed', { count })
          : t('locked', { count, table: table.name })}
      </span>
    </div>
  );
}

/** A link field whose linked table is in the trash (T421a, CONTRACTS §13): says so, read-only. */
function TrashedLinks({ field }: { field: GridField }) {
  const { t } = useTranslation('subtable');
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="subtable-target-deleted"
      className="grid grid-cols-1 items-center gap-y-0.5 sm:min-h-9 sm:grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)] sm:gap-x-4"
    >
      <span
        id={labelId}
        className="truncate px-2 text-label font-normal text-fg-muted sm:px-0 sm:text-body"
      >
        {field.field.name}
      </span>
      <span className="flex min-h-8 items-center gap-1.5 px-2 text-label font-normal text-fg-muted">
        <Trash2 aria-hidden="true" className="size-3 shrink-0" />
        {t('targetDeleted')}
      </span>
    </div>
  );
}

/**
 * Embedded sub-table of a link field (T416, FRONTEND §10.2, board "Bảng
 * con trong chi tiết record"): the linked records as a small table with
 * the chosen columns, edited in place with the linked table's rights; "Add"
 * creates a linked record, "Link existing" opens the picker (T413), each
 * row opens its record or is unlinked (undo in the toast). At most 50 rows
 * ("50 / N", "View all"). A list of cards below 640 px (board "Chi tiết
 * record trên mobile"). Lazy: the panel loads it with its first link field.
 */
export default function LinkedSubTable(props: LinkedSubTableProps) {
  const options = props.field.link;
  if (options === undefined) return null;
  const refs = linkRefsOf(props.record.fields[props.field.field.id]);
  // The linked table is in the trash (T421a): no rows, no "Add" / "Link existing".
  if (linkTargetDeleted(props.field.field)) return <TrashedLinks field={props.field} />;
  if (!canPickLinks(props.base.access, options.link_table)) {
    return <LockedLinks baseId={props.base.id} field={props.field} count={refs.length} />;
  }
  const render = (columns: ColumnsState) => <SubTable {...props} columns={columns} />;
  return props.view === undefined ? (
    <LocalColumns>{render}</LocalColumns>
  ) : (
    <ViewColumns
      view={props.view}
      base={props.base}
      tableId={props.tableId}
      fieldId={props.field.field.id}
    >
      {render}
    </ViewColumns>
  );
}

const noop = () => undefined;

/** The ids of a comma-joined key (a stable dependency for the query). */
function splitIds(key: string): string[] {
  return key === '' ? [] : key.split(',');
}

/**
 * The row number and the primary column stay put when the sub-table scrolls
 * sideways (T421a): sticky cells over an opaque background (the row's hover
 * tint is drawn on them too).
 */
const STICKY_NUMBER = 'sticky left-0 z-[1]';
const STICKY_PRIMARY = 'sticky left-9 z-[1] shadow-[1px_0_0_var(--color-line)]';
const STICKY_ROW_BG = 'bg-surface group-hover:bg-surface-sunken';

/** Buttons under the cards on phones: two columns of 44 px. */
const PHONE_BUTTON = 'h-control w-full justify-center text-body';

function SubTable({
  base,
  tableId,
  field,
  record,
  recordTitle,
  editing,
  locale,
  narrow,
  fullScreen,
  Link,
  userId,
  columns,
}: LinkedSubTableProps & { readonly columns: ColumnsState }) {
  const { t } = useTranslation(['subtable', 'record']);
  const format = useFormatters();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  const linkButton = useRef<HTMLButtonElement>(null);
  const options = field.link;
  const linkTable = options?.link_table ?? '';
  const fieldId = field.field.id;

  const targetFieldsQuery = useQuery(fieldsQuery(linkTable));
  const tables = useQuery(tablesQuery(base.id));
  const tableName =
    tables.data?.items.find((table) => table.id === linkTable)?.name ?? field.field.name;
  const targetFields = useMemo(
    () =>
      targetFieldsQuery.data === undefined ? [] : orderGridFields(targetFieldsQuery.data.items),
    [targetFieldsQuery.data],
  );
  const reverseId = options?.symmetric_field_id ?? null;
  const shown = useMemo(
    () => resolveColumns(columns.saved, targetFields, reverseId),
    [columns.saved, targetFields, reverseId],
  );
  const targetEditing = usePanelEditing({
    base,
    tableId: linkTable,
    fields: targetFields,
    locale,
    onGone: noop,
  });

  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [autoEdit, setAutoEdit] = useState<string | null>(null);

  const refs = linkRefsOf(record.fields[fieldId]);
  // The "Unlinked … Undo" toast goes once the link is back another way (Ctrl+Z, toolbar undo,
  // another tab): its undo has nothing left to do (T421a).
  const undoToast = useRef<{ readonly id: number; readonly recordId: string } | null>(null);
  const linkedKey = refs.map((ref) => ref.id).join(',');
  useEffect(() => {
    const pending = undoToast.current;
    if (pending === null || !linkedKey.split(',').includes(pending.recordId)) return;
    dismissToast(pending.id);
    undoToast.current = null;
  }, [linkedKey]);
  const cap = expanded ? SUBTABLE_EXPANDED_CAP : SUBTABLE_ROW_CAP;
  const idsKey = readableIds(refs, cap).join(',');
  const ids = splitIds(idsKey);
  const linked = useLinkedRecords({
    linkTable,
    fieldId,
    recordId: record.id,
    ids,
    permissionVersion: base.permission_version,
    enabled: linkTable !== '',
  });
  const { rows, total, capped } = subTableRows(refs, linked.data?.records, cap);

  const canLink = editing.canEdit(field);
  const canPick = canLink && Link !== undefined;
  const canAdd = canLink && canAddRecord(base.access, linkTable);
  // "View all" filters the linked table on its reverse link field, when the viewer reads it.
  const reverseField =
    reverseId === null ? undefined : targetFields.find((item) => item.field.id === reverseId);
  const reverseReadable = reverseField !== undefined;
  const primary = shown[0];

  const writeLinks = (next: readonly LinkRef[]) => {
    editing.commit(record.id, fieldId, {
      value: linkWriteValue(next),
      display: linkDisplayValue(next),
      typecast: false,
    });
  };
  /** The cell as it is now (the toast's undo may come after other changes). */
  const currentRefs = () =>
    linkRefsOf((cachedRecord(queryClient, tableId, record.id) ?? record).fields[fieldId]);

  const titleOf = (row: SubTableRow): string => {
    if (row.locked) return t('noAccess');
    const value = primary === undefined ? undefined : row.record?.fields[primary.field.id];
    const text = primary === undefined ? '' : cardText(primary, value, locale);
    if (text !== '') return text;
    return row.ref.title !== null && row.ref.title !== '' ? row.ref.title : t('untitled');
  };

  const unlink = (row: SubTableRow) => {
    const before = currentRefs();
    const index = before.findIndex((ref) => ref.id === row.ref.id);
    writeLinks(withoutLink(before, row.ref.id));
    if (undoToast.current !== null) dismissToast(undoToast.current.id);
    const id = showToast({
      message: t('unlinked', { title: titleOf(row) }),
      actions: [
        {
          label: t('undo'),
          primary: true,
          onClick: () => {
            undoToast.current = null;
            writeLinks(restoreLink(currentRefs(), row.ref, index));
          },
        },
      ],
    });
    undoToast.current = { id, recordId: row.ref.id };
  };

  const openRecord = (recordId: string) => {
    void navigate(
      `/b/${encodeURIComponent(base.id)}/t/${encodeURIComponent(linkTable)}?${RECORD_PARAM}=${encodeURIComponent(recordId)}`,
    );
  };

  const viewAll = () => {
    if (reverseField !== undefined) {
      const param = linkedSearchParam({ fieldId: reverseField.field.id, recordId: record.id });
      void navigate(
        `/b/${encodeURIComponent(base.id)}/t/${encodeURIComponent(linkTable)}?${param}`,
      );
      return;
    }
    // One-way link: no field of the linked table to filter on; every link shows here.
    setExpanded(true);
  };

  /**
   * "Add" (FRONTEND §10.2): the record is created in the linked table, then
   * linked; when linking fails it goes to the trash and a toast says so.
   */
  const add = async () => {
    if (adding) return;
    setAdding(true);
    let created: RecordDto | undefined;
    try {
      created = (await api.records.create(linkTable, [{ fields: {} }])).records[0];
    } catch (error) {
      setAdding(false);
      showErrorToast(error);
      return;
    }
    if (created === undefined) {
      setAdding(false);
      return;
    }
    const link = async (retry: boolean): Promise<void> => {
      const current = cachedRecord(queryClient, tableId, record.id) ?? record;
      const next = [...linkRefsOf(current.fields[fieldId]), { id: created.id, title: '' }];
      try {
        const updated = await api.records.updateOne(tableId, record.id, {
          version: current.version,
          fields: { [fieldId]: linkWriteValue(next) },
        });
        if (updated !== null) putCachedRecord(queryClient, tableId, updated);
      } catch (error) {
        if (retry && isApiError(error) && error.status === 409) {
          // Someone changed the record meanwhile: read it again, link once more.
          putCachedRecord(queryClient, tableId, await api.records.get(tableId, record.id));
          await link(false);
          return;
        }
        throw error;
      }
    };
    try {
      await link(true);
      setAutoEdit(created.id);
    } catch (error) {
      await api.records.remove(linkTable, [created.id]).catch(noop);
      showToast({ variant: 'error', message: t('addFailed'), error });
    } finally {
      setAdding(false);
    }
  };

  const picker =
    picking && Link !== undefined && options !== undefined ? (
      <Suspense fallback={null}>
        <Link.Picker
          access={base.access}
          baseId={base.id}
          orgId={base.organization_id}
          userId={userId}
          field={field.field}
          options={options}
          recordId={record.id}
          recordLabel={recordTitle}
          value={refs}
          anchor={null}
          fullScreen={fullScreen}
          locale={locale}
          onCommit={writeLinks}
          onClose={() => {
            setPicking(false);
            linkButton.current?.focus();
          }}
        />
      </Suspense>
    ) : null;

  const countText = capped
    ? t('capped', { shown: rows.length, total })
    : t('rows', { count: total });
  // Phones show the bare number next to the name (board "Chi tiết record trên mobile").
  const headerCount = narrow && !capped ? format.number(total) : countText;
  const countLabel = capped
    ? t('cappedLabel', { shown: rows.length, total })
    : narrow
      ? countText
      : undefined;
  const loading = ids.length > 0 && linked.data === undefined && !linked.isError;
  const addLabel = t('addRow', { table: tableName });

  const pickButton = (className?: string) =>
    canPick ? (
      <Button
        ref={linkButton}
        variant="secondary"
        size="sm"
        data-testid="subtable-link-existing"
        className={cn('max-lg:h-control', className)}
        onClick={() => {
          setPicking(true);
        }}
      >
        <Link2 aria-hidden="true" />
        {t('linkExisting')}
      </Button>
    ) : null;
  const addButton = (label: string, className?: string) =>
    canAdd ? (
      <Button
        variant="secondary"
        size="sm"
        data-testid="subtable-add"
        className={cn('max-lg:h-control', className)}
        disabled={adding}
        onClick={() => {
          void add();
        }}
      >
        <Plus aria-hidden="true" />
        {adding ? t('adding') : label}
      </Button>
    ) : null;

  const empty = (
    <div
      data-testid="subtable-empty"
      className="flex flex-col items-center gap-1 rounded-lg border border-line px-4 py-6 text-center"
    >
      <Link2 aria-hidden="true" className="mb-1 size-5 text-fg-muted" />
      <p className="text-body font-medium">{t('emptyTitle', { table: tableName })}</p>
      <p className="text-label font-normal text-fg-muted">{t('emptyHint')}</p>
      {canAdd || canPick ? (
        <span className="mt-2 flex flex-wrap justify-center gap-1.5">
          {addButton(t('add'))}
          {canPick ? (
            <Button
              ref={linkButton}
              variant="ghost"
              size="sm"
              className="max-lg:h-control"
              onClick={() => {
                setPicking(true);
              }}
            >
              <Link2 aria-hidden="true" />
              {t('linkExisting')}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );

  const failed = linked.isError ? (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 rounded-lg border border-line px-4 py-6 text-center"
    >
      <AlertTriangle aria-hidden="true" className="size-5 text-fg-muted" />
      <p className="text-body">{t('loadError')}</p>
      <Button
        variant="secondary"
        size="sm"
        className="max-lg:h-control"
        onClick={() => {
          void linked.refetch();
        }}
      >
        <RefreshCw aria-hidden="true" />
        {t('retry')}
      </Button>
    </div>
  ) : null;

  const viewAllButton = capped ? (
    <Tooltip
      content={reverseReadable ? t('viewAllHint', { table: tableName }) : t('showAll', { total })}
    >
      <Button
        variant="link"
        size="sm"
        data-testid="subtable-view-all"
        className="max-lg:min-h-control"
        onClick={viewAll}
      >
        {t('viewAll')}
      </Button>
    </Tooltip>
  ) : null;

  const header = (
    <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5">
      <Link2 aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      <h3
        id={headingId}
        className={cn(
          'min-w-0 truncate',
          narrow ? 'text-label font-normal text-fg-muted' : 'text-body font-semibold',
        )}
      >
        {field.field.name}
      </h3>
      <span
        data-testid="subtable-count"
        aria-label={countLabel}
        className="text-label font-normal text-fg-muted tabular-nums"
      >
        {headerCount}
      </span>
      {narrow || total === 0 ? null : (
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {targetFields.length > 0 ? (
            <ColumnPicker
              fields={targetFields}
              shown={shown}
              savedIn={columns.savedIn}
              onChange={columns.set}
            />
          ) : null}
          {pickButton()}
          {addButton(t('add'))}
        </span>
      )}
    </div>
  );

  let body: ReactNode;
  if (failed !== null) body = failed;
  else if (total === 0) body = empty;
  else if (loading || targetFieldsQuery.data === undefined) {
    body = (
      <div
        aria-busy="true"
        className="flex flex-col gap-2 rounded-lg border border-line p-3"
        data-testid="subtable-loading"
      >
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  } else if (narrow) {
    body = (
      <Cards
        rows={rows}
        shown={shown}
        locale={locale}
        titleOf={titleOf}
        canUnlink={canLink}
        onOpen={openRecord}
        onUnlink={unlink}
      />
    );
  } else {
    body = (
      <Grid
        headingId={headingId}
        rows={rows}
        shown={shown}
        editing={targetEditing}
        locale={locale}
        titleOf={titleOf}
        canUnlink={canLink}
        onOpen={openRecord}
        onUnlink={unlink}
        autoEdit={autoEdit}
        onAutoOpened={() => {
          setAutoEdit(null);
        }}
        footer={
          <>
            {canAdd ? (
              <tr>
                <td colSpan={shown.length + 2} className="border-t border-line p-0">
                  <button
                    type="button"
                    data-testid="subtable-add-row"
                    disabled={adding}
                    className="flex h-9 w-full items-center gap-1.5 px-3 text-label font-normal text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed max-lg:h-11"
                    onClick={() => {
                      void add();
                    }}
                  >
                    <Plus aria-hidden="true" className="size-3.5" />
                    {adding ? t('adding') : addLabel}
                  </button>
                </td>
              </tr>
            ) : null}
            <tr
              data-testid="subtable-summary"
              className="h-[34px] border-t border-line bg-canvas text-label font-normal"
            >
              <td className={cn(STICKY_NUMBER, 'bg-canvas')} />
              <td className={cn('px-2.5 text-fg-muted', STICKY_PRIMARY, 'bg-canvas')}>
                {capped ? (
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{countText}</span>
                    {viewAllButton}
                  </span>
                ) : (
                  t('total', { count: total })
                )}
              </td>
              {shown.slice(1).map((column) => {
                const sum = !capped && summedColumn(column) ? columnTotal(column, rows) : null;
                return (
                  <td
                    key={column.field.id}
                    className="px-2.5 text-right text-body font-semibold tabular-nums"
                  >
                    {sum === null ? null : (
                      <CellValue field={column} value={sum} locale={locale} compact />
                    )}
                  </td>
                );
              })}
              <td />
            </tr>
          </>
        }
      />
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="subtable"
      data-field-id={fieldId}
      className={cn('flex min-w-0 flex-col', narrow ? 'gap-2' : 'gap-2.5 py-3')}
    >
      {header}
      {body}
      {narrow && total > 0 ? (
        <>
          {capped ? (
            <div className="flex items-center gap-2 text-label font-normal text-fg-muted">
              <span className="tabular-nums">{countText}</span>
              {viewAllButton}
            </div>
          ) : null}
          {canAdd || canPick ? (
            <div className="grid grid-cols-2 gap-2">
              {addButton(addLabel, PHONE_BUTTON)}
              {pickButton(PHONE_BUTTON)}
            </div>
          ) : null}
        </>
      ) : null}
      {picker}
    </section>
  );
}

interface RowsProps {
  readonly rows: readonly SubTableRow[];
  readonly shown: readonly GridField[];
  readonly locale: LocaleContext;
  readonly titleOf: (row: SubTableRow) => string;
  readonly canUnlink: boolean;
  readonly onOpen: (recordId: string) => void;
  readonly onUnlink: (row: SubTableRow) => void;
}

/** Arrow keys move between the editable cells (`data-cell="row,column"`), not the panel's records. */
function moveBetweenCells(event: KeyboardEvent<HTMLTableElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return;
  const at = target.dataset['cell'];
  if (at === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
  const [row = 0, column = 0] = at.split(',').map(Number);
  const step: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const delta = step[event.key];
  if (delta === undefined) return;
  // The panel must not move to another record, nor the page scroll.
  event.preventDefault();
  const table = event.currentTarget;
  const cells = [...table.querySelectorAll<HTMLElement>('[data-cell]')].map((element) => {
    const [r = 0, c = 0] = (element.dataset['cell'] ?? '').split(',').map(Number);
    return { element, r, c };
  });
  const candidates = cells.filter(({ r, c }) =>
    delta[0] !== 0
      ? c === column && Math.sign(r - row) === delta[0]
      : r === row && Math.sign(c - column) === delta[1],
  );
  candidates.sort((a, b) =>
    delta[0] !== 0
      ? Math.abs(a.r - row) - Math.abs(b.r - row)
      : Math.abs(a.c - column) - Math.abs(b.c - column),
  );
  candidates[0]?.element.focus();
}

function Grid({
  headingId,
  rows,
  shown,
  editing,
  locale,
  titleOf,
  canUnlink,
  onOpen,
  onUnlink,
  autoEdit,
  onAutoOpened,
  footer,
}: RowsProps & {
  readonly headingId: string;
  readonly editing: PanelEditing;
  readonly autoEdit: string | null;
  /** The new row's editor opened: not again. */
  readonly onAutoOpened: () => void;
  readonly footer: ReactNode;
}) {
  const { t } = useTranslation('subtable');
  const widths = shown.map((column, index) =>
    index === 0 ? 200 : isNumericField(column) ? 124 : 148,
  );
  const minWidth = 36 + widths.reduce((sum, width) => sum + width, 0) + 64;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="overflow-x-auto">
        <table
          aria-labelledby={headingId}
          data-testid="subtable-table"
          className="w-full table-fixed border-collapse text-body"
          style={{ minWidth }}
          onKeyDown={moveBetweenCells}
        >
          <colgroup>
            <col style={{ width: 36 }} />
            {shown.map((column, index) => (
              <col
                key={column.field.id}
                style={index === 0 ? undefined : { width: widths[index] }}
              />
            ))}
            <col style={{ width: 64 }} />
          </colgroup>
          <thead>
            <tr className="h-8 bg-surface-sunken text-label text-fg-muted">
              <th scope="col" className={cn('font-medium', STICKY_NUMBER, 'bg-surface-sunken')}>
                <span className="sr-only">{t('rowNumber')}</span>
              </th>
              {shown.map((column, index) => (
                <th
                  key={column.field.id}
                  scope="col"
                  className={cn(
                    'truncate px-2.5 font-medium',
                    isNumericField(column) ? 'text-right' : 'text-left',
                    index === 0 && cn(STICKY_PRIMARY, 'bg-surface-sunken'),
                  )}
                >
                  <span className="inline-flex max-w-full items-center gap-1.5">
                    {column.link === undefined ? null : (
                      <Link2 aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{column.field.name}</span>
                  </span>
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">{t('actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const title = titleOf(row);
              return (
                <tr
                  key={row.ref.id}
                  data-testid="subtable-row"
                  data-record-id={row.ref.id}
                  className="group h-9 border-t border-line hover:bg-surface-sunken/60 max-lg:h-11"
                >
                  <td
                    className={cn(
                      'text-center text-label font-normal text-fg-muted tabular-nums',
                      STICKY_NUMBER,
                      STICKY_ROW_BG,
                    )}
                  >
                    {rowIndex + 1}
                  </td>
                  {row.locked ? (
                    <td colSpan={shown.length} className="px-2.5">
                      <span
                        data-testid="subtable-locked-row"
                        className="inline-flex items-center gap-1.5 text-fg-muted"
                      >
                        <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                        {t('noAccessRow')}
                      </span>
                    </td>
                  ) : row.record === null ? (
                    <td colSpan={shown.length} className="truncate px-2.5 text-fg-muted">
                      {title}
                    </td>
                  ) : (
                    shown.map((column, columnIndex) => (
                      <SubTableCell
                        key={column.field.id}
                        field={column}
                        record={row.record as RecordDto}
                        editing={editing}
                        locale={locale}
                        row={rowIndex}
                        column={columnIndex}
                        autoOpen={columnIndex === 0 && autoEdit === row.ref.id}
                        className={
                          columnIndex === 0 ? cn(STICKY_PRIMARY, STICKY_ROW_BG) : undefined
                        }
                        onAutoOpened={onAutoOpened}
                      />
                    ))
                  )}
                  <td className="pr-1.5">
                    <span className="flex justify-end gap-0.5 opacity-0 max-lg:gap-2 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      {row.locked ? null : (
                        <Tooltip content={t('openShort')}>
                          <Button
                            variant="ghost"
                            size={null}
                            data-testid="subtable-open"
                            aria-label={t('open', { title })}
                            className="relative size-[26px] text-fg-muted before:absolute before:-inset-2 max-lg:before:-inset-[9px] [&_svg]:size-3.5"
                            onClick={() => {
                              onOpen(row.ref.id);
                            }}
                          >
                            <Maximize2 aria-hidden="true" />
                          </Button>
                        </Tooltip>
                      )}
                      {canUnlink ? (
                        <Tooltip content={t('unlinkShort')}>
                          <Button
                            variant="ghost"
                            size={null}
                            data-testid="subtable-unlink"
                            aria-label={t('unlink', { title })}
                            className="relative size-[26px] text-fg-muted before:absolute before:-inset-2 max-lg:before:-inset-[9px] [&_svg]:size-3.5"
                            onClick={() => {
                              onUnlink(row);
                            }}
                          >
                            <Unlink aria-hidden="true" />
                          </Button>
                        </Tooltip>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>{footer}</tfoot>
        </table>
      </div>
    </div>
  );
}

/** Below 640 px (board "Chi tiết record trên mobile"): one card per linked record. */
function Cards({ rows, shown, locale, titleOf, canUnlink, onOpen, onUnlink }: RowsProps) {
  const { t } = useTranslation('subtable');
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="subtable-cards">
      {rows.map((row) => {
        const title = titleOf(row);
        const details = row.locked
          ? []
          : shown.slice(1).flatMap((column) => {
              const text = cardText(column, row.record?.fields[column.field.id], locale);
              return text === ''
                ? []
                : [{ id: column.field.id, text, mono: column.config?.type === 'auto_number' }];
            });
        return (
          <li
            key={row.ref.id}
            data-testid="subtable-card"
            data-record-id={row.ref.id}
            className="flex items-center gap-2.5 rounded-lg border border-line py-1 pr-1 pl-3"
          >
            {row.locked ? (
              <span className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 text-fg-muted">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                {t('noAccessRow')}
              </span>
            ) : (
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center gap-0.5 py-1.5 text-left"
                onClick={() => {
                  onOpen(row.ref.id);
                }}
              >
                <span className="w-full truncate text-[15px] leading-5 font-medium">{title}</span>
                {details.length === 0 ? null : (
                  <span className="w-full truncate text-label font-normal text-fg-muted">
                    {details.map((detail, index) => (
                      <span key={detail.id}>
                        {index === 0 ? null : ' · '}
                        <span className={detail.mono ? 'font-mono text-mono' : undefined}>
                          {detail.text}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
              </button>
            )}
            {row.locked && !canUnlink ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    data-testid="subtable-card-menu"
                    aria-label={t('rowActions', { title })}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {row.locked ? null : (
                    <DropdownMenuItem
                      onSelect={() => {
                        onOpen(row.ref.id);
                      }}
                    >
                      <Maximize2 aria-hidden="true" />
                      {t('openShort')}
                    </DropdownMenuItem>
                  )}
                  {canUnlink ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        onUnlink(row);
                      }}
                    >
                      <Unlink aria-hidden="true" />
                      {t('unlinkShort')}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        );
      })}
    </ul>
  );
}
