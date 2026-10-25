import { Button } from '@cellhive/ui';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { isTextTarget, pageShortcut } from '../../../grid/undo/keys';
import { useGridUndo } from '../../../grid/undo/table-undo';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { FollowMenuItem, type FollowMenuMessages } from '../../../lib/records/FollowMenuItem';
import { cachedRecord } from '../../../lib/records/record-sync';
import { columnKeyOf, shiftCount, type GroupFieldKind, type KanbanColumnDef } from '../board';
import { columnCollision, columnKeyboardCoordinates } from '../dnd';
import { Latest } from '../latest';
import { groupCountsQuery } from '../queries';
import { BoardRefresher } from '../refresh';
import { useKanbanData } from '../use-kanban-data';
import { useKanbanEditing } from '../use-kanban-editing';
import { useKanbanRealtime } from '../use-kanban-realtime';

import { CardBody, cardHeight as heightOf, type CardCover } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';
import { KanbanToolbar, UndoButtons } from './KanbanToolbar';

import type { GridField } from '../../../grid/types';
import type { BoardQuery } from '../queries';
import type { BaseDetail, RecordDto, RecordGroupCountsResponse } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** Width of a column with its gap, px (`w-68` + `gap-2`): columns on screen load their cards. */
const COLUMN_SLOT = 280;
/** Marked when the first cards are on screen (FRONTEND §11.1; read by the E2E perf test). */
export const FIRST_CARDS_MARK = 'app:kanban:first-cards';

export interface KanbanBoardProps {
  readonly base: BaseDetail;
  readonly query: BoardQuery;
  readonly groupField: GridField;
  readonly kind: GroupFieldKind;
  readonly fields: readonly GridField[];
  readonly primary: GridField | undefined;
  readonly cardFields: readonly GridField[];
  /** Cover image of the cards (`cover_field`, T418). */
  readonly cover?: CardCover | null | undefined;
  readonly hideEmpty: boolean;
  /** Changes "Hide empty columns" (column menus). */
  readonly onHideEmpty?: ((hide: boolean) => void) | undefined;
  readonly locale: LocaleContext;
  /** Below 768 px: read-only, one column per screen width (FRONTEND §9.4). */
  readonly narrow: boolean;
  readonly label: string;
  readonly onOpen: (recordId: string) => void;
  /** Records gone (deleted, out of reach): the panel closes if it shows one. */
  readonly onRecordsGone: (recordIds: readonly string[]) => void;
  /** Cards in board order, for previous/next in the record panel. */
  readonly onCardsChange: (order: readonly string[]) => void;
  /** Board settings of the page, shown in the toolbar after undo/redo. */
  readonly settings: ReactNode;
}

/**
 * The columns of a kanban view (T314) with drag and drop between them.
 * Cards come from `useKanbanData`, moves go through `useKanbanEditing`,
 * other tabs' changes arrive through `useKanbanRealtime`.
 */
export function KanbanBoard({
  base,
  query,
  groupField,
  kind,
  fields,
  primary,
  cardFields,
  cover,
  hideEmpty,
  onHideEmpty,
  locale,
  narrow,
  label,
  onOpen,
  onRecordsGone,
  onCardsChange,
  settings,
}: KanbanBoardProps) {
  const { t } = useTranslation('kanban');
  const queryClient = useQueryClient();

  // Columns in (or next to) the viewport load their cards.
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 1600 });
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () => {
      setViewport({ left: element.scrollLeft, width: element.clientWidth || 1600 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const [latestQuery] = useState(() => new Latest(query));
  useLayoutEffect(() => {
    latestQuery.set(query);
  });
  const refresher = useMemo(
    () => new BoardRefresher(queryClient, () => latestQuery.get()),
    [queryClient, latestQuery],
  );
  useEffect(() => {
    refresher.resume();
    return () => {
      refresher.dispose();
    };
  }, [refresher]);

  // Columns on screen (and one on each side) load their cards.
  const data = useKanbanData(query, groupField.field, {
    hideEmpty,
    first: Math.max(0, Math.floor(viewport.left / COLUMN_SLOT) - 1),
    last: Math.ceil((viewport.left + viewport.width) / COLUMN_SLOT) + 1,
  });
  const shown = data.shown;

  const editing = useKanbanEditing({
    base,
    query,
    groupField,
    fields,
    locale,
    refresher,
    columnOf: data.columnOf,
    onGone: onRecordsGone,
    readOnly: narrow,
  });
  const undo = useGridUndo(query.tableId, editing.controller);
  // Undo / redo anywhere on the page (FRONTEND §6.2), as on the grid; text fields and dialogs keep them.
  const undoKeys = useRef(undo);
  useEffect(() => {
    undoKeys.current = undo;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = pageShortcut(event);
      if (
        (shortcut !== 'undo' && shortcut !== 'redo') ||
        event.defaultPrevented ||
        isTextTarget(event.target) ||
        (event.target instanceof Element && event.target.closest('dialog') !== null)
      ) {
        return;
      }
      event.preventDefault();
      if (shortcut === 'undo') undoKeys.current.undo();
      else undoKeys.current.redo();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  const columnOfValue = useCallback(
    (value: unknown) => columnKeyOf(groupField.field, kind, value),
    [groupField.field, kind],
  );
  const defs = useMemo(() => data.columns.map((column) => column.def), [data.columns]);
  // A card moved by someone else: the counts of both columns follow at once (then refetch).
  const shiftCounts = useCallback(
    (from: string, to: string) => {
      const target = defs.find((column) => column.key === to);
      if (target === undefined) return;
      queryClient.setQueryData<RecordGroupCountsResponse>(
        groupCountsQuery(query).queryKey,
        (current) =>
          current === undefined
            ? current
            : shiftCount(current, groupField.field, kind, { from, to: target }),
      );
    },
    [defs, queryClient, query, groupField.field, kind],
  );
  useKanbanRealtime({
    query,
    refresher,
    columnOf: data.columnOf,
    columnOfValue,
    shiftCounts,
    onRecordsGone,
  });

  const order = useMemo(
    () => shown.flatMap((column) => column.cards.map((card) => card.id)),
    [shown],
  );
  useEffect(() => {
    onCardsChange(order);
  }, [order, onCardsChange]);
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || order.length === 0) return;
    marked.current = true;
    performance.mark(FIRST_CARDS_MARK);
  }, [order]);

  const columnName = useCallback(
    (column: KanbanColumnDef) => {
      if (column.kind === 'empty') return t('column.uncategorized');
      return column.name ?? t('column.formerMember');
    },
    [t],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );
  const [dragged, setDragged] = useState<RecordDto | null>(null);
  const titleOf = useCallback(
    (recordId: string) => {
      const record = cachedRecord(queryClient, query.tableId, recordId);
      const value = primary === undefined ? null : record?.fields[primary.field.id];
      return typeof value === 'string' && value !== '' ? value : t('card.untitled');
    },
    [queryClient, query.tableId, primary, t],
  );
  // "Follow" / "Unfollow" of the card menu (T553).
  const followItem = (recordId: string) => {
    const title = titleOf(recordId);
    const messages: FollowMenuMessages = {
      follow: t('card.follow'),
      unfollow: t('card.unfollow'),
      followed: t('card.followed', { title }),
      unfollowed: t('card.unfollowed', { title }),
      undo: t('card.undo'),
      gone: t('card.gone'),
    };
    return <FollowMenuItem tableId={query.tableId} recordId={recordId} messages={messages} />;
  };
  const nameOfKey = useCallback(
    (key: string | number) => {
      const def = defs.find((column) => column.key === key);
      return def === undefined ? '' : columnName(def);
    },
    [defs, columnName],
  );
  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active: item }) => t('dnd.start', { title: titleOf(String(item.id)) }),
      onDragOver: ({ active: item, over }) =>
        over === null
          ? t('dnd.outside', { title: titleOf(String(item.id)) })
          : t('dnd.over', { title: titleOf(String(item.id)), column: nameOfKey(over.id) }),
      onDragEnd: ({ active: item, over }) =>
        over === null
          ? t('dnd.cancel', { title: titleOf(String(item.id)) })
          : t('dnd.end', { title: titleOf(String(item.id)), column: nameOfKey(over.id) }),
      onDragCancel: ({ active: item }) => t('dnd.cancel', { title: titleOf(String(item.id)) }),
    }),
    [t, titleOf, nameOfKey],
  );
  const instructions = useMemo<ScreenReaderInstructions>(
    () => ({ draggable: t('dnd.instructions') }),
    [t],
  );

  const { move } = editing;
  const onDragStart = (event: DragStartEvent) => {
    setDragged(cachedRecord(queryClient, query.tableId, String(event.active.id)) ?? null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragged(null);
    const target = defs.find((column) => column.key === event.over?.id);
    if (target !== undefined) void move(String(event.active.id), target);
  };
  const onMove = useCallback(
    (recordId: string, to: KanbanColumnDef) => {
      void move(recordId, to);
    },
    [move],
  );
  const { create } = editing;
  const onAdd = useCallback(
    (column: KanbanColumnDef) => {
      void create(column).then((recordId) => {
        if (recordId !== null) onOpen(recordId);
      });
    },
    [create, onOpen],
  );

  const height = heightOf(cardFields, cover !== null && cover !== undefined);
  const toolbar = (
    <KanbanToolbar>
      <UndoButtons editable={editing.canMove || editing.canAdd} undo={undo} />
      {settings}
    </KanbanToolbar>
  );
  if (data.countsError !== null && data.columns.every((column) => column.count === null)) {
    return (
      <>
        {toolbar}
        <div className="flex flex-col items-start gap-3 p-4">
          <ErrorAlert error={data.countsError} />
          <Button variant="secondary" onClick={data.retry}>
            {t('error.retry')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      {toolbar}
      <DndContext
        sensors={sensors}
        collisionDetection={columnCollision}
        accessibility={{ announcements, screenReaderInstructions: instructions }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragged(null);
        }}
      >
        <div
          ref={scroller}
          role="region"
          aria-label={label}
          data-testid="kanban-board"
          className={
            narrow
              ? 'flex min-h-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto bg-canvas p-3'
              : 'flex min-h-0 flex-1 gap-2 overflow-x-auto bg-canvas p-3'
          }
          onScroll={(event) => {
            const element = event.currentTarget;
            setViewport({ left: element.scrollLeft, width: element.clientWidth || 1600 });
          }}
        >
          {shown.map((column) => (
            <KanbanColumn
              key={column.def.key}
              column={column}
              columns={defs}
              columnName={columnName}
              groupField={groupField}
              primary={primary}
              cardFields={cardFields}
              cover={cover}
              locale={locale}
              cardHeight={height}
              canMove={editing.canMove}
              moveBlocked={editing.moveBlocked}
              canAdd={editing.canAdd}
              hideEmpty={hideEmpty}
              onHideEmpty={onHideEmpty}
              narrow={narrow}
              isMoving={editing.isMoving}
              onOpen={onOpen}
              onMove={onMove}
              onAdd={onAdd}
              onLoadMore={data.loadMore}
              followItem={followItem}
            />
          ))}
          {shown.length === 0 ? (
            <p className="m-auto max-w-md text-center text-fg-muted">{t('board.allEmpty')}</p>
          ) : null}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged === null ? null : (
            <div className="flex w-64 rotate-1 flex-col overflow-hidden rounded-lg border border-accent bg-surface p-3 text-body shadow-popover motion-reduce:rotate-0">
              <CardBody
                record={dragged}
                primary={primary}
                cardFields={cardFields}
                locale={locale}
                cover={cover}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}
