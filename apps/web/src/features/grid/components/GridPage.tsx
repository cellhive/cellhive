import { Button, DropdownMenuItem, Tooltip } from '@cellhive/ui';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Info, Keyboard, Plus, Redo2, RefreshCw, Undo2, X } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import {
  cellClipboardText,
  GridView,
  isEditableField,
  orderGridFields,
  type GridDensity,
  type GridInteractionHooks,
  type GridSelectionRange,
  type GridViewHandle,
  type CellAddress,
  type GridViewport,
  type HeaderMenuAnchor,
  type LinkChipHover,
  type LinkPickerOpen,
  type GridField,
  useRulePainter,
} from '../../../grid';
import { isTextTarget, pageShortcut } from '../../../grid/undo/keys';
import { tableUndo, useGridUndo } from '../../../grid/undo/table-undo';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { prefetchLinkCandidates } from '../../../lib/links/candidates';
import {
  linkDisplayValue,
  linkRefsOf,
  linkTargetDeleted,
  linkWriteValue,
} from '../../../lib/links/values';
import {
  canDownloadFile,
  canEditField,
  canManageSchema,
  canPickLinks,
  canSaveViewConfig,
} from '../../../lib/permissions/access';
import { recordQueryHash, type EffectiveRecordQuery } from '../../../lib/query/keys';
import {
  baseQuery,
  fieldsQuery,
  tableQuery,
  tableRecordCountQuery,
} from '../../../lib/query/queries';
import { toWriteValue } from '../../../lib/records/commands';
import {
  RECORD_PARAM,
  type AnchorRect,
  type RecordDetailComponents,
} from '../../../lib/records/detail';
import { FollowMenuItem, type FollowMenuMessages } from '../../../lib/records/FollowMenuItem';
import {
  daysLeft,
  isFieldConverting,
  locksFieldValues,
  revertibleConversion,
} from '../../../lib/schema/conversion';
import { reminderHeaderHints } from '../../../lib/schema/date-reminder';
import {
  serverFieldIndex,
  type FieldToolRequest,
  type FieldToolsProps,
} from '../../../lib/schema/field-tools';
import { meQuery } from '../../../lib/session/session';
import { showToast } from '../../../lib/toast/toast';
import { countConditions, viewRecordQuery } from '../../../lib/views/query';
import { shortCount } from '../../../lib/views/summary/format';
import { useGridRealtime } from '../blocks/use-grid-realtime';
import { useRecordBlocks } from '../blocks/use-record-blocks';
import { useGridClipboard } from '../bulk/use-grid-clipboard';
import { useGridButtons } from '../buttons/use-grid-buttons';
import { useColorRulesRefetch } from '../colors/use-color-rules-refetch';
import { ComputedErrorPopover } from '../computed/ComputedErrorPopover';
import { RecomputeBanner } from '../computed/RecomputeBanner';
import { useComputedColumns } from '../computed/use-computed-columns';
import { ConversionBanners, conversionBannerId } from '../conversion/ConversionBanners';
import { AddRecordButton, DeleteRecordsButton } from '../editing/RecordActions';
import { SchemaLockedBanner } from '../editing/SchemaLockedBanner';
import { useGridEditing } from '../editing/use-grid-editing';
import { mayHaveCollapsed } from '../groups/collapse';
import { isEmptyGroupValue, type GroupHeader } from '../groups/group-model';
import { useGridGroups } from '../groups/use-grid-groups';
import { densityOf, frozenCount, visibleColumns } from '../layout/column-layout';
import { useViewLayout } from '../layout/use-view-layout';
import { useGridSummaries } from '../summary/use-grid-summaries';
import { TreeOverlays } from '../tree/TreeOverlays';
import { useGridTree } from '../tree/use-grid-tree';
import { useTreeRows } from '../tree/use-tree-rows';

import { AddRowsDialog } from './AddRowsDialog';
import { CellMenu } from './CellMenu';
import { columnComputed, ColumnHeaderMenu, type ColumnMenuAction } from './ColumnHeaderMenu';
import { GridEmptyState } from './GridEmptyState';
import { GridFooter, GridFooterText, useGridFooterTexts } from './GridFooter';
import { GridToolbar } from './GridToolbar';
import { GroupHeaderMenu, type GroupMenuAction } from './GroupHeaderMenu';
import { HiddenFieldsMenu } from './HiddenFieldsMenu';
import { RecordCardList } from './RecordCardList';
import { ShortcutsDialog } from './ShortcutsDialog';
import { UndoRedoButtons } from './UndoRedoButtons';

import type { LinkComponents } from '../../../lib/links/picker';
import type { ChannelMessage } from '../../../lib/realtime/socket';
import type { SummaryBarLayout } from '../../../lib/views/summary/types';
import type { ViewToolbarComponents } from '../../../lib/views/toolbar';
import type { ViewDto } from '@cellhive/contracts';

/** Skeleton rows shown until the first block answers. */
const LOADING_ROWS = 12;
/** Marked when the first rows are on screen (FRONTEND §11.1 "first data"; read by the E2E perf test). */
export const FIRST_DATA_MARK = 'app:grid:first-data';
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

/** Rows looked at for the records of a selection (a larger selection is cut here). */
const MAX_SELECTED_ROWS = 10_000;

/** How long a record added in a group is looked for to select it (its rows load meanwhile). */
const FOCUS_NEW_RECORD_MS = 5_000;

/** Records of the selected rows that are loaded, in row order, without repeats. */
export function selectedRecordIds(
  ranges: readonly GridSelectionRange[],
  loader: { getRecord: (row: number) => { readonly id: string } | undefined },
): string[] {
  const ids = new Set<string>();
  let seen = 0;
  for (const range of ranges) {
    for (let row = range.firstRow; row <= range.lastRow && seen < MAX_SELECTED_ROWS; row += 1) {
      seen += 1;
      const record = loader.getRecord(row);
      if (record !== undefined) ids.add(record.id);
    }
  }
  return [...ids];
}

/** Ctrl/⌘ + Shift + Enter adds a record (FRONTEND §6.2). */
function isAddShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey);
}

export interface GridPageProps {
  /** The grid view on screen (T310): its config gives the column layout and the query. */
  readonly view: ViewDto;
  /**
   * Field configuration dialogs (T207, `features/field`), given by the route
   * because features do not import each other (FRONTEND §1.2).
   */
  readonly FieldTools?: ComponentType<FieldToolsProps> | undefined;
  /**
   * Record panel and history (T206, `features/record`, `features/history`),
   * lazy components given by the route for the same reason.
   */
  readonly RecordDetail?: RecordDetailComponents | undefined;
  /**
   * Filter, sort and search of the view (T311, `features/view/toolbar`),
   * given by the route for the same reason.
   */
  readonly ViewToolbar?: ViewToolbarComponents | undefined;
  /**
   * Link picker and hover card of link cells (T413, `features/link`), lazy
   * components given by the route for the same reason.
   */
  readonly Link?: LinkComponents | undefined;
}

/** How long the pointer rests on a chip before its card shows, and the grace to reach the card. */
const HOVER_CARD_DELAY_MS = 400;
const HOVER_CARD_HIDE_MS = 200;

/**
 * The grid of a grid view (`/b/:baseId/t/:tableId/v/:viewId`, FRONTEND §2),
 * below the table header and view bar of `features/view`. The route guard
 * has loaded the base, the table, its fields and views. Rows are loaded in
 * blocks through the view (`view_id`, FRONTEND §3.3); the column layout
 * (hidden, order, frozen, widths, sort, row height) is the view's config,
 * saved when the user may, else kept on this device as unsaved changes.
 */
export function GridPage({ view, FieldTools, RecordDetail, ViewToolbar, Link }: GridPageProps) {
  const { t } = useTranslation(['grid', 'tree']);
  const { baseId = '', tableId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const { data: table } = useSuspenseQuery(tableQuery(tableId));
  const { data: fieldList } = useSuspenseQuery(fieldsQuery(tableId));

  const serverFields = useMemo(() => orderGridFields(fieldList.items), [fieldList]);
  const {
    layout,
    ordered: allFields,
    actions: layoutActions,
    view: viewState,
  } = useViewLayout(view, serverFields, canSaveViewConfig(base.access, tableId, view));
  const { saved: savedConfig, config: effectiveConfig } = viewState;
  // Sub-records (T417): the view shows a tree when it asks and the table has a `parent` field.
  const parentField = fieldList.items.find((field) => field.type === 'parent');
  const treeShown = effectiveConfig.tree.enabled && parentField !== undefined;
  const fields = useMemo(
    () =>
      visibleColumns(allFields, layout.hidden).filter(
        // The tree itself shows the parent: its column would repeat it.
        (field) => !treeShown || field.field.type !== 'parent',
      ),
    [allFields, layout.hidden, treeShown],
  );
  const frozen = frozenCount(layout, fields.length);
  // Through the view (T302): its saved filter/sort/group apply on the server; temporary
  // changes replace them for this user (T311, `viewRecordQuery`), plus the search box.
  const sort = layout.sort;
  const [search, setSearch] = useState('');
  const query = useMemo<EffectiveRecordQuery>(
    () => viewRecordQuery(view.id, savedConfig, { ...effectiveConfig, sort: [...sort] }, search),
    [view.id, savedConfig, effectiveConfig, sort, search],
  );
  const canManage = canManageSchema(base.access, tableId);
  // (T554) Date reminders: alarm icon + hint on the header (a warning for schema managers).
  const reminderHints = useMemo(
    () => reminderHeaderHints(fieldList.items, canManage, t),
    [fieldList.items, canManage, t],
  );

  const [menu, setMenu] = useState<{ fieldId: string; anchor: HeaderMenuAnchor } | null>(null);
  const [toolRequest, setToolRequest] = useState<FieldToolRequest | null>(null);
  const { resize, move } = layoutActions;
  // Formula / lookup columns (T468): header badges, error popover and its actions.
  const computed = useComputedColumns({
    tableId,
    baseId,
    columns: fields,
    fields: fieldList.items,
    canManage: canManage && FieldTools !== undefined,
  });
  const { openError } = computed;
  const columnHooks = useMemo<GridInteractionHooks>(
    () => ({
      headerMenu: {
        onHeaderMenu: (fieldId, anchor) => {
          setMenu({ fieldId, anchor });
        },
        onHeaderBadge: (fieldId, anchor) => {
          openError({ fieldId, anchor });
        },
      },
      columns: {
        onColumnResize: resize,
        // The view's `field_order` (T310), not the fields' `position`: everyone may, and
        // those who cannot save the view keep the order on this device.
        onColumnMove: move,
      },
    }),
    [resize, move, openError],
  );

  const onColumnAction = (fieldId: string, action: ColumnMenuAction) => {
    const anchor = menu?.anchor ?? { x: 0, y: 0, width: 0, height: 0 };
    setMenu(null);
    const index = serverFieldIndex(fieldList.items, fieldId);
    switch (action) {
      case 'edit':
      case 'rename':
      case 'delete':
        setToolRequest({ kind: action, fieldId });
        return;
      case 'insertLeft':
        setToolRequest({ kind: 'create', index });
        return;
      case 'insertRight':
        setToolRequest({ kind: 'create', index: index + 1 });
        return;
      case 'sortAsc':
      case 'sortDesc':
        layoutActions.sortBy({ field: fieldId, direction: action === 'sortAsc' ? 'asc' : 'desc' });
        return;
      case 'freeze':
        layoutActions.freezeThrough(fields.findIndex((field) => field.field.id === fieldId));
        return;
      case 'hide':
        layoutActions.hide(fieldId);
        return;
      case 'revert':
        setToolRequest({ kind: 'revert', fieldId });
        return;
      case 'formula':
        // The formula popover under the column header (T468, S4b decision #12).
        setToolRequest({ kind: 'formula', fieldId, anchor });
        return;
      case 'computedError':
        openError({ fieldId, anchor });
        return;
      case 'progress':
        // The column's conversion banner (T414) takes the focus: its progress is announced.
        document.getElementById(conversionBannerId(fieldId))?.focus();
        return;
    }
  };
  const menuField =
    menu === null ? undefined : fieldList.items.find((field) => field.id === menu.fieldId);
  const firstSort = sort[0];
  const sortField =
    firstSort === undefined
      ? undefined
      : fieldList.items.find((field) => field.id === firstSort.field);
  // Group levels (T312): fields the user reads, in the view's effective config.
  const readable = useMemo(
    () => new Set<string>(fieldList.items.map((field) => field.id)),
    [fieldList],
  );
  const groupLevels = useMemo(
    // A tree is never grouped (CONTRACTS §15 `TREE_WITH_GROUP`).
    () => (treeShown ? [] : effectiveConfig.group.filter((item) => readable.has(item.field))),
    [effectiveConfig.group, readable, treeShown],
  );
  const { data: me } = useQuery(meQuery());
  const treeRows = useTreeRows({
    active: treeShown,
    tableId,
    viewId: view.id,
    userId: me?.user.id ?? null,
    query,
    showAncestors: effectiveConfig.tree.show_ancestors,
    permissionVersion: base.permission_version,
    parentFieldId: parentField?.id ?? null,
  });
  const { loader, snapshot: flatSnapshot } = useRecordBlocks(
    tableId,
    query,
    base.permission_version,
    {
      // Grouped with some group collapsed: nothing loads before the counts say
      // which rows are shown. Nothing collapsed: the first rows are the first
      // server rows, block 0 loads alongside the counts.
      // A tree (T417) reads its own levels: the flat rows never load then.
      waitForViewport:
        treeShown || (groupLevels.length > 0 && mayHaveCollapsed(me?.user.id ?? null, view.id)),
    },
  );
  // A tree reads its own levels (T417): the flat rows stay idle meanwhile.
  useEffect(() => {
    if (!treeRows.active) return;
    loader.detach();
    return () => {
      loader.attach();
    };
  }, [loader, treeRows.active]);
  /** The rows on screen: the tree's levels (T417) or the loader's blocks. */
  const source = treeRows.rows ?? loader;
  // (T816) Row/cell colors: the server names the rule in `record.meta.color`; new saved
  // rules refetch the rows on screen (their colors are computed with the saved rules).
  const colors = useRulePainter(effectiveConfig.color_rules);
  useColorRulesRefetch(savedConfig.color_rules, source);
  const snapshot = treeRows.active ? treeRows.snapshot : flatSnapshot;
  const treeData = useMemo(
    () =>
      treeRows.rows === null
        ? null
        : {
            getRecord: treeRows.rows.getRecord.bind(treeRows.rows),
            rowOf: treeRows.rows.rowOf.bind(treeRows.rows),
            loadRows: treeRows.rows.loadRows.bind(treeRows.rows),
            findRecord: treeRows.rows.findRecord.bind(treeRows.rows),
          },
    [treeRows.rows],
  );

  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  // T472: the summary bar (and the summaries of group headers), injected like the toolbar.
  const SummaryBar = ViewToolbar?.SummaryBar;
  const summaries = useGridSummaries({
    tableId,
    state: viewState,
    query,
    permissionVersion: base.permission_version,
    fields: fieldList.items,
    locale,
    enabled: SummaryBar !== undefined,
  });
  const [columnLayout, setColumnLayout] = useState<SummaryBarLayout | null>(null);

  // Fields whose values are being converted (T414): old values, read-only until the job ends.
  const convertingIds = useMemo(
    () => new Set<string>(fieldList.items.filter(locksFieldValues).map((field) => field.id)),
    [fieldList],
  );
  const editing = useGridEditing({
    base,
    tableId,
    fields,
    loader,
    locale,
    undo: tableUndo(tableId).hooks,
    cache: treeRows.rows?.cache,
    attachments: RecordDetail?.Attachments,
    lockedFields: convertingIds,
    lockedFieldHint: t('conversion.lockedHint'),
  });

  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  // Images of attachment cells load only for fields the user may download (T418, CONTRACTS §20).
  const access = base.access;
  const fileAccess = useMemo(
    () => ({ canView: (fieldId: string) => canDownloadFile(access, tableId, fieldId) }),
    [access, tableId],
  );
  const groups = useGridGroups({
    tableId,
    viewId: view.id,
    userId: me?.user.id ?? null,
    query,
    permissionVersion: base.permission_version,
    levels: groupLevels,
    fields: serverFields,
    loader,
    snapshot: flatSnapshot,
    ignoreCollapse: narrow,
    // A "+" row ends every group when the user may add records (T320a).
    addRows: editing.canAdd && !narrow,
  });
  const groupModel = groups.model;
  const grouped = groupModel !== null;
  /** Rows in data rows: the grouped layout, or the loader's rows as they are. */
  const rows = treeData ?? (grouped ? groups.rows : loader);
  // Row height is a view setting (`row_height`); narrow screens always use the touch height.
  const density: GridDensity = narrow ? 'comfortable' : densityOf(layout.rowHeight);
  const changeDensity = layoutActions.setDensity;

  const ready = treeRows.active
    ? snapshot.status === 'ready'
    : grouped
      ? true
      : groups.active && groups.status !== 'ready'
        ? false
        : snapshot.status === 'ready';
  const rowCount = groupModel?.dataCount ?? snapshot.rowCount;
  const getRecord = useCallback(
    (row: number) => (ready ? rows.getRecord(row) : undefined),
    [rows, ready],
  );
  const { setViewport } = groups;
  const treeSource = treeRows.rows;
  const onViewportChange = useCallback(
    (viewport: GridViewport) => {
      if (treeSource !== null) {
        treeSource.setViewport(viewport.firstRow, viewport.lastRow, viewport.dragging);
      } else {
        setViewport(viewport);
      }
    },
    [setViewport, treeSource],
  );

  // Back to the first row when rows change meaning; a change of `fields` only keeps the position,
  // and so does a new `permission_version` (the loader keeps the rows until the new ones arrive).
  const scrollResetKey = recordQueryHash({ ...query, fields: null });

  const marked = useRef(false);
  useEffect(() => {
    if (!marked.current && ready && (rowCount === 0 || rows.getRecord(0) !== undefined)) {
      marked.current = true;
      performance.mark(FIRST_DATA_MARK);
    }
  }, [ready, snapshot.version, rowCount, rows]);

  const gridUndo = useGridUndo(tableId, editing.controller);
  // Below 768 px the grid is read-only; records are edited in the panel (FRONTEND §9.4).
  const editHooks = narrow ? undefined : editing.hooks;
  const clipboard = useGridClipboard({
    access: base.access,
    fields,
    rows,
    rowCount: ready ? rowCount : 0,
    locale,
    controller: editing.controller,
    edit: editHooks,
    // Grouped: new rows would land in the empty group, far from the paste (T312).
    canAdd: editing.canAdd && ready && !grouped && !treeRows.active,
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [ranges, setRanges] = useState<readonly GridSelectionRange[]>([]);
  const selectedIds = useMemo(
    () => selectedRecordIds(ranges, rows),
    // A new block version may bring records of selected rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranges, rows, snapshot.version],
  );
  // "Delete N records" acts on whole rows only (row markers), not on a cell range (T322a).
  const selectedRowIds = useMemo(
    () =>
      selectedRecordIds(
        ranges.filter((range) => range.wholeRows === true),
        rows,
      ),
    // A new block version may bring records of selected rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ranges, rows, snapshot.version],
  );
  const gridHandle = useRef<GridViewHandle>(null);

  // Record panel (FRONTEND §10.1): `?record=rec_…` is the open record (deep link).
  const [searchParams, setSearchParams] = useSearchParams();
  const openRecordId = RecordDetail === undefined ? null : searchParams.get(RECORD_PARAM);
  const setOpenRecord = useCallback(
    (recordId: string | null, replace: boolean) => {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          if (recordId === null) next.delete(RECORD_PARAM);
          else next.set(RECORD_PARAM, recordId);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );
  const openRecord = useCallback(
    (recordId: string) => {
      setOpenRecord(recordId, openRecordId !== null);
    },
    [setOpenRecord, openRecordId],
  );

  // Realtime (FRONTEND §5): rows follow the other tabs; the open record
  // leaving (deleted, out of reach) closes the panel with a notice.
  const openRecordRef = useRef(openRecordId);
  useEffect(() => {
    openRecordRef.current = openRecordId;
  });
  // The panel covers the grid: a cell editor still open is closed first (its
  // last draft is written, like a click outside), never drawn over the panel (T322a).
  useEffect(() => {
    if (openRecordId !== null) gridHandle.current?.closeEditor();
  }, [openRecordId]);
  const onRecordsGone = useCallback(
    (recordIds: readonly string[]) => {
      const open = openRecordRef.current;
      if (open === null || !recordIds.includes(open)) return;
      showToast({ message: t('realtime.recordGone') });
      setOpenRecord(null, true);
    },
    [setOpenRecord, t],
  );
  // Record messages follow the view (T313); the temporary filter and search are checked by `ids`.
  const primaryFieldId = fieldList.items.find((field) => field.is_primary)?.id ?? null;
  const { onMessage: onGroupMessage } = groups;
  const { onMessage: onSummaryMessage } = summaries;
  const onTableMessage = useCallback(
    (message: ChannelMessage) => {
      onGroupMessage(message);
      // T472: record changes and recomputed values refresh the summaries (500 ms window).
      onSummaryMessage(message);
    },
    [onGroupMessage, onSummaryMessage],
  );
  useGridRealtime(tableId, query, source, {
    onRecordsGone,
    primaryFieldId,
    group: effectiveConfig.group,
    userId: me?.user.id ?? null,
    onMessage: onTableMessage,
  });
  // The sub-record tree (T417): rows, moves, adds and deletes of its records.
  const tree = useGridTree({
    state: treeRows,
    tableId,
    fields: serverFields,
    parentFieldId: parentField?.id ?? null,
    locale,
    controller: editing.controller,
    undo: tableUndo(tableId).hooks.push,
    gridHandle,
    canAdd: editing.canAdd && !narrow,
    canDelete: editing.canDelete,
    canMove:
      !narrow &&
      editing.hooks !== undefined &&
      parentField !== undefined &&
      canEditField(base.access, tableId, parentField.id),
    onRecordsGone,
  });
  const [cellMenu, setCellMenu] = useState<{ cell: CellAddress; anchor: AnchorRect } | null>(null);
  const [cellHistory, setCellHistory] = useState<{
    cell: CellAddress;
    anchor: AnchorRect;
  } | null>(null);
  const detailHooks = useMemo<GridInteractionHooks>(
    () =>
      RecordDetail === undefined
        ? {}
        : {
            recordDetail: {
              onOpenRecord: openRecord,
              onCellMenu: (cell, anchor) => {
                setCellMenu({ cell, anchor });
              },
            },
          },
    [RecordDetail, openRecord, setCellMenu],
  );
  // Link cells (T413): the picker of a cell, the hover card of a chip.
  const [linkPicker, setLinkPicker] = useState<{
    readonly open: LinkPickerOpen;
    readonly field: GridField;
  } | null>(null);
  const [chipCard, setChipCard] = useState<LinkChipHover | null>(null);
  const queryClient = useQueryClient();
  const chipTimer = useRef<number | undefined>(undefined);
  const onCard = useRef(false);
  useEffect(
    () => () => {
      window.clearTimeout(chipTimer.current);
    },
    [],
  );
  const hasLinks = fields.some((field) => field.link !== undefined);
  useEffect(() => {
    // The picker chunk loads while the grid shows: it then opens at once (< 300 ms, T413).
    if (hasLinks) Link?.preload?.();
  }, [hasLinks, Link]);
  const linkHooks = useMemo<GridInteractionHooks>(
    () =>
      Link === undefined
        ? {}
        : {
            link: {
              onOpenPicker: (open) => {
                const field = fields.find((item) => item.field.id === open.cell.fieldId);
                if (field?.link === undefined) return;
                // The first candidates load while the picker's component mounts.
                prefetchLinkCandidates(
                  queryClient,
                  field.field.id,
                  field.link.link_table,
                  open.record.id,
                  open.search,
                );
                window.clearTimeout(chipTimer.current);
                setChipCard(null);
                // Keys typed on the cell before the picker's search box has the focus
                // (its chunk may still load) go on in its search.
                setLinkPicker((current) =>
                  current !== null &&
                  current.open.cell.recordId === open.cell.recordId &&
                  current.open.cell.fieldId === open.cell.fieldId
                    ? {
                        ...current,
                        open: {
                          ...current.open,
                          search: (current.open.search ?? '') + (open.search ?? ''),
                        },
                      }
                    : { open, field },
                );
              },
              onChipHover: (next) => {
                window.clearTimeout(chipTimer.current);
                if (next === null) {
                  chipTimer.current = window.setTimeout(() => {
                    if (!onCard.current) setChipCard(null);
                  }, HOVER_CARD_HIDE_MS);
                  return;
                }
                chipTimer.current = window.setTimeout(
                  () => {
                    setChipCard(next);
                  },
                  next.pinned ? 0 : HOVER_CARD_DELAY_MS,
                );
              },
              readOnlyHint: (fieldId) => {
                const field = fields.find((item) => item.field.id === fieldId);
                if (field?.link === undefined) return undefined;
                // The linked table is in the trash (T421a): no new links until it is restored.
                if (linkTargetDeleted(field.field)) return t('link.targetDeletedHint');
                return canPickLinks(base.access, field.link.link_table)
                  ? undefined
                  : t('link.lockedHint');
              },
            },
          },
    [Link, fields, base.access, t, setChipCard, setLinkPicker, queryClient],
  );
  const primaryGridField = serverFields.find((field) => field.field.is_primary);
  const recordLabel = (record: { fields: Readonly<Record<string, unknown>> }) => {
    const text =
      primaryGridField === undefined
        ? ''
        : cellClipboardText(
            primaryGridField,
            record.fields[primaryGridField.field.id] ?? null,
            locale,
          );
    return text === '' ? table.name : text;
  };
  // Button cells (T525): press, confirmation, "Running…" until the run ends.
  const gridButtons = useGridButtons({
    tableId,
    baseId,
    fields: serverFields,
    canSeeRuns: canManage,
    recordTitle: recordLabel,
  });
  const buttonHooks = gridButtons.hooks;
  // "Follow" / "Unfollow" of the cell and tree row menus (T553).
  const followItem = (recordId: string) => {
    const row = rows.rowOf(recordId);
    const record = row === undefined ? undefined : rows.getRecord(row);
    const title = record === undefined ? table.name : recordLabel(record);
    const messages: FollowMenuMessages = {
      follow: t('cellMenu.follow'),
      unfollow: t('cellMenu.unfollow'),
      followed: t('cellMenu.followed', { title }),
      unfollowed: t('cellMenu.unfollowed', { title }),
      undo: t('cellMenu.undo'),
      gone: t('edit.recordGone'),
    };
    return <FollowMenuItem tableId={tableId} recordId={recordId} messages={messages} />;
  };
  const openRow = openRecordId === null ? undefined : rows.rowOf(openRecordId);
  const neighbors = {
    previous:
      openRow === undefined || openRow === 0 ? null : (rows.getRecord(openRow - 1)?.id ?? null),
    next: openRow === undefined ? null : (rows.getRecord(openRow + 1)?.id ?? null),
  };
  const navigateRecord = (recordId: string) => {
    setOpenRecord(recordId, true);
    const row = rows.rowOf(recordId);
    // Keeps the rows around the record loaded (and the grid where the panel is).
    if (row !== undefined) gridHandle.current?.scrollToRow(row);
  };
  const clipboardHooks = clipboard.hooks;
  const { addRecord: add, canAdd, controller } = editing;

  // Grouped (T312): a new record goes where the server's order puts it; it
  // is selected once its rows are loaded (the grid scrolls to its group).
  const focusTarget = useRef<{
    recordId: string;
    column: number;
    groupKey: string | null;
    since: number;
  } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const addGrouped = useCallback(
    (group: GroupHeader | undefined, column = 0) => {
      // The group's values, on fields the user may set on creation (like Lark).
      const fields: Record<string, unknown> = {};
      if (group !== undefined) {
        group.fieldIds.forEach((fieldId, index) => {
          const value = group.values[index];
          const field = serverFields.find((item) => item.field.id === fieldId);
          if (
            field === undefined ||
            isEmptyGroupValue(value) ||
            !isEditableField(field) ||
            !canEditField(base.access, tableId, fieldId, 'create')
          ) {
            return;
          }
          fields[fieldId] = toWriteValue(value);
        });
        if (group.collapsed) groups.collapse.setCollapsed(group.key, false);
      }
      void controller.create(fields).then((created) => {
        if (created === null) return;
        focusTarget.current = {
          recordId: created.record.id,
          column,
          groupKey: group?.key ?? null,
          since: Date.now(),
        };
        setFocusTick((tick) => tick + 1);
      });
    },
    [serverFields, base.access, tableId, groups.collapse, controller],
  );
  useEffect(() => {
    const target = focusTarget.current;
    if (target === null || groupModel === null) return;
    const row = groups.rows.rowOf(target.recordId);
    // Only once the counts include the record: before that its offset belongs
    // to the next group in the old layout (S3 QA: the next header got selected).
    const placed =
      row !== undefined &&
      (target.groupKey === null || groupModel.groupOf(row)?.key === target.groupKey);
    if (row !== undefined && placed) {
      gridHandle.current?.focusCell(row, target.column);
      focusTarget.current = null;
      return;
    }
    if (Date.now() - target.since > FOCUS_NEW_RECORD_MS) {
      focusTarget.current = null;
      return;
    }
    // Its group's last rows (a record without sort comes last in its group) load.
    const header = target.groupKey === null ? undefined : groupModel.header(target.groupKey);
    const last =
      header === undefined ? undefined : groupModel.dataRowOf(header.offset + header.count - 1);
    if (last !== undefined) gridHandle.current?.scrollToRow(last);
  }, [focusTick, groupModel, groups.rows, snapshot.version]);

  const addRecord = useCallback(
    (column = 0) => {
      if (tree.active) {
        tree.addRoot(column);
        return;
      }
      if (grouped) {
        addGrouped(undefined, column);
        return;
      }
      void add().then((row) => {
        if (row !== null) gridHandle.current?.focusCell(row, column);
      });
    },
    [add, grouped, addGrouped, tree],
  );
  const rowHooks = useMemo<GridInteractionHooks>(
    () =>
      editHooks === undefined || !canAdd
        ? {}
        : {
            // Shift+Enter (T311): a new record; it lands where the view's order puts it.
            // Grouped (T312): in the group of the row, its values filled in.
            rows: {
              onAddRow: (row, column) => {
                // A tree (T417): a record at the same level as the row.
                if (tree.active) tree.addSibling(row, column);
                else if (groupModel !== null) addGrouped(groupModel.groupOf(row), column);
                else addRecord(column);
              },
            },
          },
    [editHooks, canAdd, addRecord, groupModel, addGrouped, tree],
  );
  const { toggle: toggleGroup } = groups.collapse;
  // The menu of a group header (T320a): right click, "▾", Shift+F10.
  const [groupMenu, setGroupMenu] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  const { groupSummaries } = summaries;
  const groupHooks = useMemo<GridInteractionHooks>(
    () =>
      groupModel === null
        ? {}
        : {
            groups: {
              onToggle: toggleGroup,
              ...(editHooks === undefined && !canAdd
                ? {}
                : {
                    onAdd: (key: string) => {
                      const header = groupModel.header(key);
                      if (header !== undefined) addGrouped(header);
                    },
                  }),
              canAdd: (group) => canAdd && !narrow && !group.rest,
              onMenu: (key, anchor) => {
                setGroupMenu({ key, anchor });
              },
              summaries: groupSummaries,
            },
          },
    [groupModel, toggleGroup, editHooks, canAdd, narrow, addGrouped, groupSummaries],
  );
  const menuGroup = groupMenu === null ? undefined : groupModel?.header(groupMenu.key);
  const groupMenuLabel = (group: GroupHeader) => {
    if (group.rest || group.field === undefined) return t('group.rest');
    const value = cellClipboardText(group.field, group.value, locale);
    return `${group.field.field.name}: ${value === '' ? t('group.empty') : value}`;
  };
  const onGroupMenuAction = (action: GroupMenuAction) => {
    const group = menuGroup;
    setGroupMenu(null);
    if (group === undefined || groupModel === null) return;
    const { collapse } = groups;
    switch (action) {
      case 'toggle':
        collapse.toggle(group.key);
        return;
      case 'collapseAll':
        collapse.collapseAll();
        return;
      case 'expandAll':
        collapse.expandAll();
        return;
      case 'collapseSubgroups':
      case 'expandSubgroups': {
        const collapsed = action === 'collapseSubgroups';
        // Expanding the subgroups of a collapsed group opens it too.
        const keys = groupModel.descendants(group.key);
        collapse.setManyCollapsed(collapsed ? keys : [group.key, ...keys], collapsed);
        return;
      }
      case 'add':
        addGrouped(group);
        return;
    }
  };
  const hooks = useMemo<GridInteractionHooks>(
    () => ({
      ...columnHooks,
      ...detailHooks,
      ...linkHooks,
      ...rowHooks,
      ...groupHooks,
      ...buttonHooks,
      ...(editHooks === undefined ? {} : { edit: editHooks }),
      // Files dropped on or pasted into attachment cells (T418).
      ...(editHooks === undefined || editing.fileHooks === undefined
        ? {}
        : { files: editing.fileHooks }),
      // A read-only table (reader) still says why Enter or typing opens nothing.
      readOnlyHint: t('edit.readOnlyHint'),
      selection: { onSelectionChange: setRanges, ...clipboardHooks },
    }),
    [
      columnHooks,
      detailHooks,
      linkHooks,
      rowHooks,
      groupHooks,
      buttonHooks,
      editHooks,
      clipboardHooks,
      t,
      editing.fileHooks,
    ],
  );
  const { undo, redo } = gridUndo;
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (!isAddShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (canAdd) addRecord();
  };
  // Undo, redo and "?" anywhere on the page (FRONTEND §6.2), also once the
  // focus has left the grid (a toolbar button that got disabled). Captured
  // before the grid sees them: "?" must not start editing a cell. Text
  // fields and dialogs keep these keys.
  const pageKeys = useRef({ undo, redo });
  useLayoutEffect(() => {
    pageKeys.current = { undo, redo };
  });
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcut = pageShortcut(event);
      if (
        shortcut === null ||
        event.defaultPrevented ||
        isTextTarget(event.target) ||
        (event.target instanceof Element && event.target.closest('dialog') !== null)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (shortcut === 'undo') pageKeys.current.undo();
      else if (shortcut === 'redo') pageKeys.current.redo();
      else setShortcutsOpen(true);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  const empty =
    ready && (groupModel === null ? snapshot.rowCount === 0 : groupModel.displayCount === 0);
  // Grouped: the count is the sum of the groups' (exact even above 100 000 rows).
  const footer =
    groupModel === null
      ? snapshot
      : {
          ...snapshot,
          status: 'ready' as const,
          rowCount: groupModel.total,
          estimated: false,
        };
  const groupCount = groupModel?.groupCount;
  const failure =
    groups.status === 'error' ? groups.error : snapshot.status === 'error' ? snapshot.error : null;
  const undoable = editHooks !== undefined || editing.canAdd || editing.canDelete;
  // T320b: what narrows the rows (the footer's "N / M", the empty state's "Clear filter").
  const searching = query.search !== undefined && query.search !== null && query.search !== '';
  const narrowedBy: 'filter' | 'search' | null =
    countConditions(effectiveConfig.filter) > 0 ? 'filter' : searching ? 'search' : null;
  // "M" of the footer: one count of the table (read rule only), asked only while narrowed
  // or shown as a tree (T421b: every record, then the rows the open branches show).
  const tableCount = useQuery({
    ...tableRecordCountQuery(tableId),
    enabled: narrowedBy !== null || tree.active,
    staleTime: 30_000,
  });
  // The record count (T320b), in the summary bar's gutter when there is one (T472).
  const footerProps = {
    snapshot: footer,
    narrowedBy,
    total: tableCount.data,
    selected: selectedIds.length,
    tree: tree.active,
    ...(groupCount === undefined ? {} : { groups: groupCount }),
  };
  const footerTexts = useGridFooterTexts(footerProps);
  const fieldsById = useMemo(
    () => new Map(fieldList.items.map((field) => [field.id as string, field])),
    [fieldList],
  );
  // The card list (< 768 px) has no columns: the bar lists the fields shown and scrolls alone.
  const barLayout = useMemo<SummaryBarLayout | null>(
    () =>
      narrow
        ? {
            gutter: 40,
            columns: fields.map((field) => ({ fieldId: field.field.id, width: 140 })),
            frozen: 0,
            scroller: () => null,
          }
        : columnLayout,
    [narrow, fields, columnLayout],
  );
  // Some rows are dimmed ancestors of filter matches (T417): the legend says why.
  const hasDimmed = useMemo(
    () => treeRows.rows?.hasAncestorOnly() ?? false,
    // A new version may bring (or drop) such rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [treeRows.rows, snapshot.version],
  );
  const dimmedShown = hasDimmed && narrowedBy !== null && !empty;
  const clearFilter = () => {
    if (countConditions(effectiveConfig.filter) > 0) {
      viewState.change({ filter: null }, { temporary: true });
    }
    setSearch('');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onKeyDownCapture}>
      <GridToolbar
        density={density}
        onDensityChange={changeDensity}
        densityLocked={narrow}
        search={
          ViewToolbar === undefined ? undefined : (
            <ViewToolbar.Search
              fields={fieldList.items}
              search={search}
              onSearchChange={setSearch}
              onLeaveSearch={() => {
                gridHandle.current?.focus();
              }}
            />
          )
        }
        assist={
          ViewToolbar?.AskAi === undefined ? undefined : (
            <ViewToolbar.AskAi
              table={table}
              fields={fieldList.items}
              orgId={base.organization_id}
            />
          )
        }
        leading={
          <UndoRedoButtons
            editable={undoable}
            canUndo={gridUndo.canUndo}
            canRedo={gridUndo.canRedo}
            busy={gridUndo.busy}
            onUndo={undo}
            onRedo={redo}
            progress={clipboard.progress}
          />
        }
        menu={
          <>
            {undoable ? (
              <>
                <DropdownMenuItem
                  disabled={!gridUndo.canUndo || gridUndo.busy}
                  onSelect={() => {
                    undo();
                  }}
                >
                  <Undo2 aria-hidden="true" />
                  {t('undo.undo')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!gridUndo.canRedo || gridUndo.busy}
                  onSelect={() => {
                    redo();
                  }}
                >
                  <Redo2 aria-hidden="true" />
                  {t('undo.redo')}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem
              aria-keyshortcuts="?"
              onSelect={() => {
                setShortcutsOpen(true);
              }}
            >
              <Keyboard aria-hidden="true" />
              {t('shortcuts.open')}
            </DropdownMenuItem>
            {canManage && FieldTools !== undefined ? (
              <DropdownMenuItem
                onSelect={() => {
                  setToolRequest({ kind: 'create' });
                }}
              >
                <Plus aria-hidden="true" />
                {t('addField')}
              </DropdownMenuItem>
            ) : null}
          </>
        }
        selection={
          editing.canDelete ? (
            <DeleteRecordsButton
              tableName={table.name}
              selectedIds={selectedRowIds}
              // A tree asks about the sub-records in its own dialog (T417).
              onDelete={tree.active ? tree.requestDelete : editing.deleteRecords}
              confirm={!tree.active}
            />
          ) : undefined
        }
        primary={
          editing.canAdd && ready ? (
            <AddRecordButton
              onAdd={() => {
                addRecord();
              }}
            />
          ) : undefined
        }
      >
        {ViewToolbar === undefined ? null : (
          <ViewToolbar.Controls
            view={view}
            fields={fieldList.items}
            orgId={base.organization_id}
            state={viewState}
            queryError={snapshot.error}
            colorRules
            treeActions={{
              levels: treeRows.expand.state.levels,
              openLevels: treeRows.expand.openLevels,
              canEnable: canManage,
            }}
            {...(groupModel === null || narrow
              ? {}
              : {
                  groupActions: {
                    collapseAll: groups.collapse.collapseAll,
                    expandAll: groups.collapse.expandAll,
                  },
                })}
          />
        )}
        {ViewToolbar === undefined && firstSort !== undefined && sortField !== undefined ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-md bg-accent-soft pr-1 pl-2 text-label text-accent">
            {t(firstSort.direction === 'asc' ? 'sort.asc' : 'sort.desc', { name: sortField.name })}
            {sort.length > 1 ? ` +${String(sort.length - 1)}` : null}
            <Tooltip content={t('sort.clear')}>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-accent hover:bg-surface"
                aria-label={t('sort.clear')}
                onClick={() => {
                  layoutActions.sortBy(null);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </Tooltip>
          </span>
        ) : null}
        {/* Phones: the card list shows a few fields; hiding them stays for larger screens. */}
        <div className="flex max-md:hidden">
          <HiddenFieldsMenu
            fields={allFields}
            hidden={layout.hidden}
            onToggle={(fieldId, visible) => {
              if (visible) layoutActions.show(fieldId);
              else layoutActions.hide(fieldId);
            }}
            onSetAll={(hide) => {
              layoutActions.setAllHidden(
                hide,
                allFields.filter((field) => !field.field.is_primary).map((field) => field.field.id),
              );
            }}
            // Same as dragging a column header: the view's `field_order` (T310).
            onMove={move}
          />
        </div>
      </GridToolbar>
      <ConversionBanners
        tableId={tableId}
        fields={fieldList.items}
        userId={me?.user.id ?? null}
        orgId={base.organization_id}
        canManage={canManage && FieldTools !== undefined}
        onRevert={(fieldId) => {
          setToolRequest({ kind: 'revert', fieldId });
        }}
        onRetry={(fieldId) => {
          setToolRequest({ kind: 'edit', fieldId });
        }}
      />
      <RecomputeBanner
        fields={allFields}
        filter={effectiveConfig.filter}
        sort={sort}
        group={groupLevels}
        onRefresh={() => {
          source.showNewRows();
        }}
      />
      {editing.schemaLocked ? <SchemaLockedBanner onRetry={editing.unlock} /> : null}
      {failure !== null ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorAlert error={failure} />
          <Button
            variant="secondary"
            onClick={() => {
              if (groups.status === 'error') groups.refresh();
              else source.retry();
            }}
          >
            {t('error.retry')}
          </Button>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={!ready}>
          {narrow && RecordDetail !== undefined ? (
            <RecordCardList
              fields={fields}
              rowCount={ready ? rowCount : LOADING_ROWS}
              getRecord={getRecord}
              dataVersion={snapshot.version}
              onViewportChange={onViewportChange}
              locale={locale}
              label={t('cards.label', { table: table.name })}
              onOpen={openRecord}
              scrollResetKey={scrollResetKey}
              treeOf={tree.active ? tree.cardPath : undefined}
            />
          ) : (
            <GridView
              fields={fields}
              rowCount={ready ? rowCount : LOADING_ROWS}
              getRecord={getRecord}
              dataVersion={snapshot.version}
              onViewportChange={onViewportChange}
              density={density}
              locale={locale}
              label={t('label', { table: table.name })}
              scrollResetKey={scrollResetKey}
              rowModel={ready && groupModel !== null ? groupModel : undefined}
              rowOf={grouped ? groups.rows.rowOf : undefined}
              hooks={hooks}
              handleRef={gridHandle}
              tree={ready ? tree.grid : undefined}
              widths={layout.widths}
              freezeColumns={frozen}
              fileAccess={fileAccess}
              colors={colors}
              headerBadges={computed.headerBadges}
              headerHints={reminderHints}
              onColumnLayout={SummaryBar === undefined ? undefined : setColumnLayout}
              // "+" at the end of the header adds a field (Lark, Airtable; T322a).
              onAddField={
                canManage && FieldTools !== undefined
                  ? () => {
                      setToolRequest({ kind: 'create' });
                    }
                  : undefined
              }
            />
          )}
          {dimmedShown ? (
            // Board "Sub-records dạng cây": why some rows are dimmed (T417).
            <p
              className="pointer-events-none absolute bottom-4 left-4 z-10 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-label font-normal text-fg-muted shadow-popover max-md:hidden"
              data-testid="tree-ancestors-legend"
            >
              <Info aria-hidden="true" className="size-3.5 shrink-0" />
              {t('tree:ancestorsLegend')}
            </p>
          ) : null}
          {empty ? (
            <GridEmptyState
              narrowedBy={narrowedBy}
              onClear={narrowedBy === null ? undefined : clearFilter}
            />
          ) : null}
          {snapshot.newRows > 0 || snapshot.stale ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <Button
                size="sm"
                className="pointer-events-auto rounded-full shadow-popover"
                data-testid={snapshot.newRows > 0 ? 'new-rows-pill' : 'rows-changed-pill'}
                onClick={() => {
                  source.showNewRows();
                }}
              >
                <RefreshCw aria-hidden="true" />
                {snapshot.newRows > 0
                  ? t('newRows', { count: snapshot.newRows })
                  : t('rowsChanged')}
              </Button>
            </div>
          ) : null}
          {snapshot.error !== null && ready ? (
            <div className="absolute inset-x-4 bottom-4 flex flex-col items-start gap-2">
              <ErrorAlert error={snapshot.error} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  source.retry();
                }}
              >
                {t('error.retry')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {barLayout === null || SummaryBar === undefined ? (
        <GridFooter {...footerProps} />
      ) : (
        <SummaryBar
          layout={barLayout}
          fields={fieldsById}
          config={summaries.config}
          result={summaries.result}
          busy={summaries.busy}
          error={summaries.error}
          onRetry={summaries.retry}
          onChange={summaries.onChange}
          locale={locale}
          narrow={narrow}
          count={{
            short: footer.status === 'ready' ? shortCount(footer.rowCount, locale.locale) : '…',
            full: [footerTexts.status, footerTexts.of, footerTexts.shown, footerTexts.selected]
              .filter((part) => part !== null)
              .join(' '),
            status: <GridFooterText texts={footerTexts} hidden />,
          }}
        />
      )}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AddRowsDialog request={clipboard.addRows} />
      {menu !== null && menuField !== undefined ? (
        <ColumnHeaderMenu
          field={menuField}
          anchor={menu.anchor}
          canManageSchema={canManage && FieldTools !== undefined}
          converting={isFieldConverting(menuField)}
          computed={columnComputed(menuField)}
          revertDays={(() => {
            const revertible = revertibleConversion(menuField);
            return revertible === null ? null : daysLeft(revertible.revertible_until);
          })()}
          onAction={(action) => {
            onColumnAction(menuField.id, action);
          }}
          onClose={() => {
            setMenu(null);
          }}
        />
      ) : null}
      {computed.errorOpen === null ||
      computed.openField === undefined ||
      computed.details === null ? null : (
        <ComputedErrorPopover
          fieldName={computed.openField.name}
          type={computed.openField.type === 'lookup' ? 'lookup' : 'formula'}
          details={computed.details}
          anchor={computed.errorOpen.anchor}
          canManage={canManage && FieldTools !== undefined}
          busy={computed.busy}
          onRestore={computed.restore}
          onEdit={() => {
            const open = computed.errorOpen;
            const field = computed.openField;
            computed.closeError();
            if (open === null || field === undefined) return;
            setToolRequest(
              field.type === 'formula'
                ? { kind: 'formula', fieldId: field.id, anchor: open.anchor }
                : { kind: 'edit', fieldId: field.id },
            );
          }}
          onRetry={computed.retry}
          onClose={computed.closeError}
        />
      )}
      {groupMenu === null || menuGroup === undefined ? null : (
        <GroupHeaderMenu
          label={groupMenuLabel(menuGroup)}
          anchor={groupMenu.anchor}
          collapsed={menuGroup.collapsed}
          nested={menuGroup.nested}
          canAdd={canAdd && !narrow && !menuGroup.rest}
          onAction={onGroupMenuAction}
          onClose={() => {
            setGroupMenu(null);
          }}
          onReturnFocus={() => {
            gridHandle.current?.focus();
          }}
        />
      )}
      {gridButtons.dialog}
      {cellMenu === null ? null : (
        <CellMenu
          fieldName={
            fieldList.items.find((field) => field.id === cellMenu.cell.fieldId)?.name ?? ''
          }
          anchor={cellMenu.anchor}
          followItem={followItem(cellMenu.cell.recordId)}
          onExpand={() => {
            setCellMenu(null);
            openRecord(cellMenu.cell.recordId);
          }}
          onHistory={() => {
            setCellMenu(null);
            setCellHistory(cellMenu);
          }}
          onClose={() => {
            setCellMenu(null);
          }}
        />
      )}
      {Link === undefined || linkPicker === null || linkPicker.field.link === undefined ? null : (
        <Suspense fallback={null}>
          <Link.Picker
            access={base.access}
            baseId={baseId}
            orgId={base.organization_id}
            userId={me?.user.id ?? null}
            field={linkPicker.field.field}
            options={linkPicker.field.link}
            recordId={linkPicker.open.record.id}
            recordLabel={recordLabel(linkPicker.open.record)}
            value={linkRefsOf(linkPicker.open.record.fields[linkPicker.field.field.id])}
            anchor={linkPicker.open.anchor}
            initialSearch={linkPicker.open.search}
            fullScreen={narrow}
            locale={locale}
            onCommit={(refs) => {
              const { cell, record } = linkPicker.open;
              editHooks?.onCommit(cell, linkWriteValue(refs), record, {
                display: linkDisplayValue(refs),
                baseVersion: record.version,
              });
            }}
            onClose={() => {
              setLinkPicker(null);
              gridHandle.current?.focus();
              // A native dialog (the expanded popover) gives the focus back to the
              // popover's search box, gone by then: the cell takes it (T421a).
              window.requestAnimationFrame(() => {
                const now = document.activeElement;
                if (now === null || now === document.body) gridHandle.current?.focus();
              });
            }}
          />
        </Suspense>
      )}
      {Link === undefined || chipCard === null || linkPicker !== null
        ? null
        : (() => {
            const field = fields.find((item) => item.field.id === chipCard.cell.fieldId);
            const record = loader.findRecord(chipCard.cell.recordId);
            if (field?.link === undefined || record === undefined) return null;
            const editable = editHooks?.canEdit(chipCard.cell, record) === true;
            const close = () => {
              onCard.current = false;
              setChipCard(null);
            };
            return (
              <Suspense fallback={null}>
                <Link.HoverCard
                  key={`${chipCard.cell.recordId}|${chipCard.recordId}`}
                  baseId={baseId}
                  field={field.field}
                  options={field.link}
                  recordId={chipCard.recordId}
                  anchor={chipCard.anchor}
                  locale={locale}
                  onUnlink={
                    editable
                      ? () => {
                          const refs = linkRefsOf(record.fields[field.field.id]).filter(
                            (ref) => ref.id !== chipCard.recordId,
                          );
                          editHooks.onCommit(chipCard.cell, linkWriteValue(refs), record, {
                            display: linkDisplayValue(refs),
                            baseVersion: record.version,
                          });
                        }
                      : undefined
                  }
                  onPointerEnter={() => {
                    onCard.current = true;
                    window.clearTimeout(chipTimer.current);
                  }}
                  onPointerLeave={close}
                  onClose={close}
                />
              </Suspense>
            );
          })()}
      {RecordDetail === undefined || cellHistory === null ? null : (
        <Suspense fallback={null}>
          <RecordDetail.CellHistory
            base={base}
            tableId={tableId}
            recordId={cellHistory.cell.recordId}
            fields={fieldList.items}
            fieldId={cellHistory.cell.fieldId}
            anchor={cellHistory.anchor}
            onClose={() => {
              setCellHistory(null);
            }}
          />
        </Suspense>
      )}
      {RecordDetail === undefined || openRecordId === null ? null : (
        <Suspense fallback={null}>
          <RecordDetail.Panel
            base={base}
            tableId={tableId}
            tableName={table.name}
            recordId={openRecordId}
            fields={fieldList.items}
            hiddenFieldIds={layout.hidden}
            initialRecord={source.findRecord(openRecordId)}
            neighbors={neighbors}
            onNavigate={navigateRecord}
            onClose={() => {
              setOpenRecord(null, true);
            }}
            fullScreen={narrow}
            onCommand={tableUndo(tableId).hooks.push}
            Link={Link}
            onDelete={
              editing.canDelete
                ? (recordId, children) =>
                    tree.active || children === 'delete'
                      ? tree.deleteRecords([recordId], children ?? 'promote')
                      : editing.deleteRecords([recordId])
                : undefined
            }
            History={RecordDetail.History}
            CellHistory={RecordDetail.CellHistory}
            Attachments={RecordDetail.Attachments}
            view={view}
          />
        </Suspense>
      )}
      {tree.active ? (
        <TreeOverlays
          tree={tree}
          tableId={tableId}
          tableName={table.name}
          primaryFieldId={primaryFieldId}
          parentFieldId={parentField?.id ?? null}
          onOpenRecord={openRecord}
          onCellHistory={(cell, anchor) => {
            setCellHistory({ cell, anchor });
          }}
          onReturnFocus={() => {
            gridHandle.current?.focus();
          }}
          followItem={followItem}
        />
      ) : null}
      {FieldTools !== undefined && toolRequest !== null ? (
        <Suspense fallback={null}>
          <FieldTools
            tableId={tableId}
            fields={fieldList.items}
            request={toolRequest}
            onClose={() => {
              setToolRequest(null);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export default GridPage;
