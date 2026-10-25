import {
  Button,
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
} from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { orderGridFields, type GridField } from '../../../grid/types';
import { isApiError } from '../../../lib/api/client';
import { recordTreeApi } from '../../../lib/api/record-tree';
import { cellFilesOf } from '../../../lib/attachments/value';
import { useButtonClicks } from '../../../lib/buttons/use-button-clicks';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { linkDisplayValue, linkRefsOf, linkWriteValue } from '../../../lib/links/values';
import {
  canAddRecord,
  canDownloadFile,
  canEditField,
  canManageAutomations,
} from '../../../lib/permissions/access';
import { keys } from '../../../lib/query/keys';
import { recordQuery } from '../../../lib/query/queries';
import { RECORD_PARAM, type AnchorRect, type RecordPanelProps } from '../../../lib/records/detail';
import { ParentPickerDialog } from '../../../lib/records/ParentPickerDialog';
import { newerRecord } from '../../../lib/records/record-sync';
import { meQuery } from '../../../lib/session/session';
import { showToast } from '../../../lib/toast/toast';
import { FollowButton } from '../follow/FollowButton';
import {
  ancestorsQuery,
  childCountOf,
  childrenKey,
  childrenQuery,
  MAX_TREE_LEVELS,
  parentIdOf,
} from '../tree';
import { usePanelEditing } from '../use-panel-editing';

import { ButtonFieldRow } from './ButtonFieldRow';
import { ComputedExpression } from './ComputedExpression';
import { FieldRow, type OpenLinkPicker } from './FieldRow';
import { ParentPath } from './ParentPath';
import { SubrecordsSection } from './SubrecordsSection';

import type { SubrecordDeleteMode } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/**
 * At this width the history sits next to the fields instead of in a tab
 * (design board). From 1280 px the panel is a side panel of half the
 * window (T322a, like Lark), wide enough for both columns from 1920 px.
 */
const WIDE_QUERY = '(min-width: 1920px)';
/** Phones: attachment sections in two columns, with "Take photo" (T418, board "Tệp trên mobile"). */
const PHONE_QUERY = '(max-width: 639.98px)';

function subscribePhone(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

function subscribeWide(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isWide(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;
}

/** Keys typed into a control stay there (↑/↓ move a caret or a list, not the record). */
function isTypingTarget(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return (target as HTMLInputElement).type !== 'checkbox';
  return target.closest('[role="listbox"], [role="combobox"], [role="tablist"], dialog') !== null;
}

/** The link to this record (FRONTEND §2 `?record=`), shareable inside the organization. */
function recordLink(recordId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set(RECORD_PARAM, recordId);
  url.hash = '';
  return url.toString();
}

type Tab = 'details' | 'history';

/** What happens to the sub-records of a deleted record (T417), the default first. */
const DELETE_MODES: readonly SubrecordDeleteMode[] = ['promote', 'delete'];

/** Sub-tables of link fields (T416, FRONTEND §10.2): a chunk of their own, loaded with the first one. */
const LinkedSubTable = lazy(() => import('../embedded/LinkedSubTable'));

interface FieldListProps {
  readonly fields: readonly GridField[];
  readonly hidden: readonly GridField[];
  readonly render: (field: GridField) => ReactNode;
}

function FieldList({ fields, hidden, render }: FieldListProps) {
  const { t } = useTranslation('record');
  const [showHidden, setShowHidden] = useState(false);
  const hiddenId = useId();
  return (
    <div className="flex flex-col">
      {/* Phones: fields further apart than a name from its value (proximity, T322a). */}
      <div className="flex flex-col gap-4 sm:gap-0">{fields.map(render)}</div>
      {/* S4 (FRONTEND §10.2): sub-grids of link fields render under their field (FieldRow `below`). */}
      {hidden.length === 0 ? null : (
        <div className="mt-3 border-t border-line pt-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showHidden}
            aria-controls={hiddenId}
            onClick={() => {
              setShowHidden((open) => !open);
            }}
          >
            {showHidden ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {t('hiddenFields', { count: hidden.length })}
          </Button>
          <div id={hiddenId} hidden={!showHidden} className="flex flex-col gap-4 sm:gap-0">
            {showHidden ? hidden.map(render) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Record detail panel (FRONTEND §10.1, design "Chi tiết record và lịch
 * sử"): header with the record code and title, previous / next (↑/↓ while
 * the panel has the focus), copy link, a "⋯" menu (copy link, delete) and
 * close (Escape); the fields in the view's order with the hidden ones
 * grouped and collapsed; each field edited through the grid's edit flow;
 * the history next to the fields on wide screens, in a tab otherwise.
 * Below 768 px it covers the screen; from 1280 px it is a side panel of
 * half the window without a backdrop, the grid visible beside it (T322a).
 */
export function RecordPanel({
  base,
  tableId,
  tableName,
  recordId,
  fields,
  hiddenFieldIds,
  initialRecord,
  neighbors,
  onNavigate,
  onClose,
  fullScreen,
  onCommand,
  onDelete,
  History,
  CellHistory,
  Link,
  Attachments,
  view,
}: RecordPanelProps) {
  const { t } = useTranslation(['record', 'grid', 'history']);
  const queryClient = useQueryClient();
  const format = useFormatters();
  const locale = useMemo<LocaleContext>(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const titleId = useId();
  const tabsId = useId();
  const panel = useRef<HTMLElement>(null);
  const wide = useSyncExternalStore(subscribeWide, isWide) && !fullScreen;
  const phone = useSyncExternalStore(subscribePhone, isPhone);
  const [tab, setTab] = useState<Tab>('details');
  const [cellHistory, setCellHistory] = useState<{ fieldId: string; anchor: AnchorRect } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMode, setDeleteMode] = useState<SubrecordDeleteMode>('promote');
  const [pickParent, setPickParent] = useState(false);

  const ordered = useMemo(() => orderGridFields(fields), [fields]);
  const hiddenSet = useMemo(() => new Set(hiddenFieldIds), [hiddenFieldIds]);
  const shown = ordered.filter((field) => field.field.is_primary || !hiddenSet.has(field.field.id));
  const hidden = ordered.filter(
    (field) => !field.field.is_primary && hiddenSet.has(field.field.id),
  );

  const query = useQuery({ ...recordQuery(tableId, recordId), retry: false });
  const record = newerRecord(query.data, initialRecord);

  // Sub-records (T417): the parent path, the children, the parent picker.
  const parentField = ordered.find((field) => field.field.type === 'parent');
  const parentId =
    parentField === undefined ? null : parentIdOf(record?.fields[parentField.field.id]);
  const ancestors = useQuery({
    ...ancestorsQuery(tableId, recordId, parentId, record?.version),
    enabled: parentId !== null,
  });
  const children = useQuery({
    ...childrenQuery(tableId, recordId),
    enabled: parentField !== undefined,
  });
  const childCount = children.data === undefined ? 0 : childCountOf(children.data);
  const level = parentId === null ? 1 : (ancestors.data?.items.length ?? 0) + 1;

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  const gone = useCallback(() => {
    closeRef.current();
  }, []);
  // Button fields (T525): pressed here as in the grid (same running clicks, same toasts).
  const buttonFieldIds = useMemo(
    () => ordered.filter((field) => field.button !== undefined).map((field) => field.field.id),
    [ordered],
  );
  const buttonClicks = useButtonClicks({
    tableId,
    baseId: base.id,
    buttonFieldIds,
    canSeeRuns: canManageAutomations(base.access, tableId),
  });
  const editing = usePanelEditing({
    base,
    tableId,
    fields: ordered,
    locale,
    onGone: gone,
    onCommand,
  });

  // 404: the record was deleted or is out of reach (FRONTEND §7): close and say so.
  const notFound = isApiError(query.error) && query.error.status === 404;
  useEffect(() => {
    if (!notFound) return;
    showToast({ message: t('record:notFound') });
    closeRef.current();
  }, [notFound, t]);

  // A follow toggle answered 404 (T553): gone like a failed load.
  const followGone = () => {
    showToast({ message: t('record:notFound') });
    closeRef.current();
  };

  // A new version (edit here or in the grid, revert) is a new history entry.
  const version = record?.version;
  const seenVersion = useRef(version);
  useEffect(() => {
    if (version === undefined || seenVersion.current === version) return;
    const first = seenVersion.current === undefined;
    seenVersion.current = version;
    if (first) return;
    void queryClient.invalidateQueries({ queryKey: keys.recordHistory(recordId) });
    // Being assigned to the record (T544) may have started a follow (T553).
    void queryClient.invalidateQueries({ queryKey: keys.recordFollow(tableId, recordId) });
  }, [version, tableId, recordId, queryClient]);

  // Focus the panel when it opens; give the focus back when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => {
      if (previous?.isConnected === true) previous.focus();
    };
  }, []);

  const copyLink = () => {
    const link = recordLink(recordId);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      showToast({ variant: 'error', message: t('record:copyFailed') });
      return;
    }
    clipboard.writeText(link).then(
      () => {
        showToast({ variant: 'success', message: t('record:linkCopied') });
      },
      () => {
        showToast({ variant: 'error', message: t('record:copyFailed') });
      },
    );
  };

  const deleteRecord = () => {
    if (onDelete === undefined) return;
    setDeleting(true);
    void onDelete(recordId, childCount > 0 ? deleteMode : undefined).then(
      (count) => {
        setDeleting(false);
        setConfirmDelete(false);
        // In the trash now: nothing left to show.
        if (count > 0) closeRef.current();
      },
      () => {
        setDeleting(false);
        setConfirmDelete(false);
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    // Keys of a popover of the panel (cell history) stay there.
    const owner = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
    if (owner !== panel.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target =
      event.key === 'ArrowUp'
        ? neighbors.previous
        : event.key === 'ArrowDown'
          ? neighbors.next
          : undefined;
    if (target === undefined) return;
    event.preventDefault();
    if (target !== null) onNavigate(target);
  };

  const primary = ordered.find((field) => field.field.is_primary);
  const codeField = ordered.find((field) => field.field.type === 'auto_number');
  const titleValue = primary === undefined ? undefined : record?.fields[primary.field.id];
  const code = codeField === undefined ? undefined : record?.fields[codeField.field.id];
  const title =
    typeof titleValue === 'string' && titleValue !== ''
      ? titleValue
      : typeof titleValue === 'number'
        ? String(titleValue)
        : t('record:untitled');

  const canMoveParent =
    parentField !== undefined &&
    editing.lockedReason === null &&
    canEditField(base.access, tableId, parentField.field.id);
  const changeParent = async (next: string | null) => {
    await recordTreeApi.setParent(tableId, recordId, next);
    const lists = [parentId, next].filter((id): id is string => id !== null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.record(tableId, recordId) }),
      queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) }),
      ...lists.map((id) => queryClient.invalidateQueries({ queryKey: childrenKey(tableId, id) })),
    ]);
  };
  const me = useQuery(meQuery());
  // Link fields (T413): the picker (a sheet below 768 px), written like any field.
  const openLinks: OpenLinkPicker | undefined =
    Link === undefined
      ? undefined
      : (field, current, anchor, close) =>
          field.link === undefined ? null : (
            <Suspense fallback={null}>
              <Link.Picker
                access={base.access}
                baseId={base.id}
                orgId={base.organization_id}
                userId={me.data?.user.id ?? null}
                field={field.field}
                options={field.link}
                recordId={current.id}
                recordLabel={title}
                value={linkRefsOf(current.fields[field.field.id])}
                anchor={fullScreen ? null : anchor}
                fullScreen={fullScreen}
                locale={locale}
                onCommit={(refs) => {
                  editing.commit(current.id, field.field.id, {
                    value: linkWriteValue(refs),
                    display: linkDisplayValue(refs),
                    typecast: false,
                  });
                }}
                onClose={close}
              />
            </Suspense>
          );
  const renderField = (field: GridField) => {
    if (record === undefined) return null;
    if (field.field.type === 'parent') {
      return (
        <FieldRow
          key={field.field.id}
          field={field}
          record={record}
          editing={editing}
          locale={locale}
          readOnly={!canMoveParent}
          onHistory={(fieldId, anchor) => {
            setCellHistory({ fieldId, anchor });
          }}
          below={
            canMoveParent ? (
              <Button
                variant="ghost"
                size="sm"
                className="mx-2 mt-0.5 text-accent"
                data-testid="change-parent"
                onClick={() => {
                  setPickParent(true);
                }}
              >
                {t('record:tree.changeParent')}
              </Button>
            ) : null
          }
        />
      );
    }
    if (field.button !== undefined) {
      return (
        <ButtonFieldRow
          key={field.field.id}
          field={field}
          record={record}
          recordTitle={title}
          clicks={buttonClicks}
          narrow={phone}
        />
      );
    }
    const config = field.config;
    if (config?.type === 'attachment' && Attachments !== undefined) {
      // Attachment fields: a section of files across the panel (T418, board "Tệp trong chi tiết record").
      const Section = Attachments.Section;
      const fieldId = field.field.id;
      return (
        <div key={fieldId} className="py-1 sm:py-2">
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <Section
              tableId={tableId}
              recordId={record.id}
              field={field.field}
              options={config.options}
              files={cellFilesOf(record.fields[fieldId])}
              canEdit={editing.canEdit(field)}
              canDownload={canDownloadFile(base.access, tableId, fieldId)}
              recordTitle={title}
              write={(files) => {
                editing.files.write(record.id, fieldId, files);
              }}
              host={editing.files.host(record.id, fieldId)}
              state={editing.fieldState(record.id, fieldId)}
              narrow={phone}
            />
          </Suspense>
        </div>
      );
    }
    if (field.link?.allow_multiple === true) {
      // Links to several records: the embedded sub-table across the panel (T416).
      return (
        <div key={field.field.id} className="py-1 sm:py-0">
          <Suspense fallback={<Skeleton className="my-3 h-24 w-full" />}>
            <LinkedSubTable
              base={base}
              tableId={tableId}
              field={field}
              record={record}
              recordTitle={title}
              editing={editing}
              locale={locale}
              view={view}
              narrow={phone}
              fullScreen={fullScreen}
              Link={Link}
              userId={me.data?.user.id ?? null}
            />
          </Suspense>
        </div>
      );
    }
    return (
      <FieldRow
        openLinks={openLinks}
        key={field.field.id}
        field={field}
        record={record}
        editing={editing}
        locale={locale}
        onHistory={(fieldId, anchor) => {
          setCellHistory({ fieldId, anchor });
        }}
        // A formula shows its expression to schema managers (T468).
        below={
          field.computed?.expression == null ? undefined : (
            <ComputedExpression expression={field.computed.expression} />
          )
        }
      />
    );
  };

  const historyScope = { base, tableId, recordId, fields };
  const details =
    record === undefined ? (
      query.isError && !notFound ? (
        <ErrorAlert error={query.error} className="my-4" />
      ) : (
        <div className="flex flex-col gap-3 py-4" aria-busy="true">
          <span className="sr-only">{t('record:loading')}</span>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      )
    ) : (
      <>
        {editing.lockedReason === null ? null : (
          <p
            role="status"
            className="my-2 rounded-md bg-surface-sunken px-3 py-2 text-label font-normal text-fg-muted"
          >
            {t(
              editing.lockedReason === 'offline' ? 'grid:edit.offlineHint' : 'grid:edit.lockedHint',
            )}
          </p>
        )}
        <FieldList key={recordId} fields={shown} hidden={hidden} render={renderField} />
        {parentField === undefined ? null : (
          <SubrecordsSection
            key={`subrecords-${recordId}`}
            tableId={tableId}
            recordId={recordId}
            primary={primary}
            locale={locale}
            canAdd={editing.lockedReason === null && canAddRecord(base.access, tableId)}
            atMaxDepth={level >= MAX_TREE_LEVELS}
            onNavigate={onNavigate}
          />
        )}
      </>
    );
  const history = (
    <Suspense fallback={<Skeleton className="my-3 h-24 w-full" />}>
      <History {...historyScope} />
    </Suspense>
  );

  const tabButton = (value: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${tabsId}-${value}`}
      aria-selected={tab === value}
      aria-controls={tab === value ? `${tabsId}-${value}-panel` : undefined}
      tabIndex={tab === value ? 0 : -1}
      className={cn(
        // 44 px touch targets below 1024 px (T322a).
        '-mb-px min-h-control border-b-2 px-3 py-2 text-body font-medium',
        tab === value ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
      )}
      onClick={() => {
        setTab(value);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next: Tab = value === 'details' ? 'history' : 'details';
        setTab(next);
        document.getElementById(`${tabsId}-${next}`)?.focus();
      }}
    >
      {label}
    </button>
  );

  const created = record === undefined ? null : format.dateTime(record.created_at);
  return (
    <>
      {/*
        Dim backdrop over the whole app, sidebar included (design board); a click
        closes. From 1280 px the panel sits beside the grid without one (T322a, Lark).
      */}
      {fullScreen ? null : (
        <div
          aria-hidden="true"
          data-testid="record-panel-backdrop"
          className="fixed inset-0 z-40 bg-overlay xl:hidden"
          onClick={onClose}
        />
      )}
      <section
        ref={panel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="record-panel"
        // The summary bar leaves the cells under the panel out (T470, `markSlivers`).
        data-covers-grid=""
        className={cn(
          'fixed z-50 flex flex-col bg-surface text-fg outline-none',
          fullScreen
            ? 'inset-0'
            : 'top-0 right-0 bottom-0 w-[min(1080px,100vw)] border-l border-line shadow-popover xl:w-[clamp(40rem,50vw,67.5rem)]',
        )}
        onKeyDown={onKeyDown}
      >
        {/*
          Phones (T322a): the buttons on the first row with the record code only
          (no table name, no date), the title on its own row, up to two lines.
        */}
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-line py-2 pr-2 pl-4 sm:py-3 sm:pr-3 sm:pl-6">
          {/* "Tickets · TK-0391 · Created 22/09 08:14" (design board). */}
          <p
            data-testid="record-panel-meta"
            className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 truncate text-label font-normal text-fg-muted"
          >
            <span className="truncate max-sm:hidden">{tableName}</span>
            {typeof code === 'string' && code !== '' ? (
              <>
                <span aria-hidden="true" className="max-sm:hidden">
                  ·
                </span>
                <span className="truncate font-mono text-mono text-fg">{code}</span>
              </>
            ) : null}
            {created === null ? null : (
              <>
                <span aria-hidden="true" className="max-sm:hidden">
                  ·
                </span>
                <span className="truncate max-sm:hidden">
                  {t('record:created', { date: created })}
                </span>
              </>
            )}
          </p>
          {parentId === null ? null : (
            <ParentPath
              tableId={tableId}
              recordId={recordId}
              parentId={parentId}
              version={record?.version}
              onNavigate={onNavigate}
              className="col-span-2 row-start-2 min-w-0 sm:col-span-1"
            />
          )}
          <h2
            id={titleId}
            className={cn(
              parentId === null ? 'row-start-2' : 'row-start-3',
              'col-span-2 line-clamp-2 text-heading break-words sm:col-span-1 sm:truncate sm:text-title',
            )}
          >
            {title}
          </h2>
          <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-1.5 sm:row-span-2">
            <Tooltip content={t('record:previousHint')}>
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('record:previous')}
                disabled={neighbors.previous === null}
                onClick={() => {
                  if (neighbors.previous !== null) onNavigate(neighbors.previous);
                }}
              >
                <ChevronUp aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content={t('record:nextHint')}>
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('record:next')}
                disabled={neighbors.next === null}
                onClick={() => {
                  if (neighbors.next !== null) onNavigate(neighbors.next);
                }}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </Tooltip>
            <FollowButton
              key={recordId}
              tableId={tableId}
              recordId={recordId}
              onGone={followGone}
            />
            <Button
              variant="secondary"
              size="toolbar"
              className="px-2.5 max-sm:hidden"
              aria-label={t('record:copyLink')}
              onClick={copyLink}
            >
              <LinkIcon aria-hidden="true" />
              {t('record:copyLinkShort')}
            </Button>
            <DropdownMenu>
              <Tooltip content={t('record:more')}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="record-panel-more"
                    aria-label={t('record:more')}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={copyLink}>
                  <LinkIcon aria-hidden="true" />
                  {t('record:copyLinkShort')}
                </DropdownMenuItem>
                {onDelete === undefined ? null : (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-danger [&_svg]:text-danger"
                      disabled={record === undefined}
                      onSelect={() => {
                        setConfirmDelete(true);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {t('record:delete')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content={t('record:close')}>
              <Button variant="ghost" size="icon" aria-label={t('record:close')} onClick={onClose}>
                <X aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </header>
        {wide ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
            <div className="min-h-0 overflow-y-auto px-6 py-4">{details}</div>
            <aside
              aria-labelledby={`${tabsId}-history-heading`}
              className="min-h-0 overflow-y-auto border-l border-line bg-canvas px-5 py-3"
            >
              <h3 id={`${tabsId}-history-heading`} className="text-heading">
                {t('record:history')}
              </h3>
              {history}
            </aside>
          </div>
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t('record:tabs')}
              className="flex gap-1 border-b border-line px-4"
            >
              {tabButton('details', t('record:details'))}
              {tabButton('history', t('record:history'))}
            </div>
            <div
              role="tabpanel"
              id={`${tabsId}-${tab}-panel`}
              aria-labelledby={`${tabsId}-${tab}`}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6"
            >
              {tab === 'details' ? details : history}
            </div>
          </>
        )}
        {buttonClicks.dialog}
        {onDelete === undefined ? null : (
          <Dialog
            open={confirmDelete}
            onOpenChange={(open) => {
              if (!open && !deleting) setConfirmDelete(false);
            }}
            title={t('record:deleteTitle')}
            description={t('record:deleteDescription', { title, table: tableName })}
            closeLabel={t('record:deleteCancel')}
          >
            {childCount > 0 ? (
              <fieldset className="mb-4 flex flex-col gap-2" data-testid="panel-delete-choice">
                <legend className="mb-2 text-body font-medium">
                  {t('record:tree.deleteLegend', { count: childCount })}
                </legend>
                {DELETE_MODES.map((mode) => (
                  <label
                    key={mode}
                    className={cn(
                      'flex min-h-control cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
                      deleteMode === mode
                        ? 'border-accent bg-accent-soft'
                        : 'border-line hover:bg-surface-sunken',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${tabsId}-delete`}
                      value={mode}
                      checked={deleteMode === mode}
                      className="mt-0.5 size-4 shrink-0 accent-accent"
                      onChange={() => {
                        setDeleteMode(mode);
                      }}
                    />
                    <span className="text-body">
                      {mode === 'promote'
                        ? t('record:tree.deletePromote')
                        : t('record:tree.deleteBranch', { count: childCount })}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmDelete(false);
                }}
              >
                {t('record:deleteCancel')}
              </Button>
              <Button variant="danger" disabled={deleting} onClick={deleteRecord}>
                {t('record:deleteConfirm')}
              </Button>
            </div>
          </Dialog>
        )}
        {pickParent && primary !== undefined ? (
          <ParentPickerDialog
            open
            tableId={tableId}
            recordId={recordId}
            recordTitle={title}
            primaryFieldId={primary.field.id}
            currentParentId={parentId}
            onSelect={changeParent}
            onClose={() => {
              setPickParent(false);
            }}
          />
        ) : null}
        {cellHistory === null ? null : (
          <Suspense fallback={null}>
            <CellHistory
              {...historyScope}
              fieldId={cellHistory.fieldId}
              anchor={cellHistory.anchor}
              onClose={() => {
                setCellHistory(null);
              }}
            />
          </Suspense>
        )}
      </section>
    </>
  );
}

export default RecordPanel;
