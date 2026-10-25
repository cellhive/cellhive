import { VIEW_TYPES, type EffectiveAccess, type ViewDto, type ViewType } from '@cellhive/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ClipboardList,
  Copy,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  SquareKanban,
  Table2,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router';

import {
  canEditView,
  canEditViews,
  canLockViews,
  canSaveViewConfig,
} from '../../../lib/permissions/access';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { useViewConfig } from '../../../lib/views/use-view-config';
import { useCreateView, useDuplicateView, useMoveView, useUpdateView } from '../mutations';
import { uniqueViewName } from '../names';

import { DeleteViewDialog } from './DeleteViewDialog';
import { RenameViewDialog } from './RenameViewDialog';
import { UnsavedChanges } from './UnsavedChanges';
import {
  GROUP_SEPARATOR_WIDTH,
  isClick,
  planTabs,
  TAB_GAP,
  tabCapacity,
  tabMinWidth,
} from './view-tabs';

let measureContext: OffscreenCanvasRenderingContext2D | null | undefined;

/** Width of a tab name at 13 px/500 (the open tab's weight) in the UI font (a rough estimate without canvas, e.g. tests). */
function nameWidth(name: string): number {
  if (measureContext === undefined) {
    measureContext =
      typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
    if (measureContext !== null) {
      const family = getComputedStyle(document.documentElement).getPropertyValue('--font-ui');
      measureContext.font = `500 13px ${family.trim() === '' ? 'sans-serif' : family}`;
    }
  }
  return measureContext === null ? name.length * 7 : measureContext.measureText(name).width;
}

/** CSS `min-width` of a view's tab (without the open tab's "…"). */
function tabMinWidthOf(view: ViewDto): number {
  return tabMinWidth(nameWidth(view.name), Number(view.is_personal) + Number(view.locked));
}

const TYPE_ICONS: Record<ViewType, typeof Table2> = {
  grid: Table2,
  kanban: SquareKanban,
  form: ClipboardList,
};

export interface ViewBarProps {
  readonly baseId: string;
  readonly tableId: string;
  readonly tableName: string;
  /** Views the caller sees: shared by position, then personal (CONTRACTS §15). */
  readonly views: readonly ViewDto[];
  readonly active: ViewDto;
  readonly access: EffectiveAccess | null | undefined;
  /** Actions of the open view from other features (e.g. "Share", T316), after the tabs. */
  readonly extra?: ReactNode;
}

type Dialog = { kind: 'rename' | 'delete'; view: ViewDto } | null;

/** Below this width the tabs give way to a view switcher (a menu of every view). */
const NARROW_QUERY = '(max-width: 639.98px)';

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

/** Width of an element, followed as it changes (0 before layout or without ResizeObserver). */
function useWidth(): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return;
    // The observer reports the first size as soon as it observes.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [node]);
  return [setNode, width];
}

/**
 * The tab to focus once its view is open: a view opened from the bar
 * (created, duplicated), or `*` for whichever view opens next (the open view
 * was deleted). Module state: the bar of a deleted view unmounts before the
 * next view's bar mounts.
 */
let focusOnOpen: string | null = null;

function focusTabWhenOpen(viewId: string) {
  focusOnOpen = viewId;
}

/** Whether the tab of `activeId` should take the focus now (once). */
function takeTabFocus(activeId: string): boolean {
  if (focusOnOpen === null || (focusOnOpen !== activeId && focusOnOpen !== '*')) return false;
  focusOnOpen = null;
  return true;
}

/** Focuses the tab (or the narrow-screen switcher) of the open view once it is rendered. */
function focusActiveTab(viewId: string) {
  window.setTimeout(() => {
    const target =
      document.querySelector<HTMLElement>(`[data-testid="view-tab-${viewId}"] a`) ??
      document.querySelector<HTMLElement>('[data-testid="view-switcher"]');
    target?.focus();
  }, 0);
}

/**
 * The views of a table (T310, FRONTEND §2, §7): a tab per view — shared
 * ones, then the user's personal ones — with create, rename, duplicate,
 * reorder (drag, or "Move left/right" from the keyboard), lock and delete,
 * each offered only to those allowed (`view_rule.allow_edit` or schema
 * rights for shared views; the owner for personal ones; locking needs
 * schema rights). The server decides anyway. T320b: the tabs shrink to a
 * minimum width and the rest go into a "⋯ N views" menu (the open view
 * always keeps its tab); below 640 px a switcher lists every view. The
 * open view's unsaved changes follow the tabs as a pill (like Lark), the
 * view actions (export, share) sit at the end.
 */
export function ViewBar({
  baseId,
  tableId,
  tableName,
  views,
  active,
  access,
  extra,
}: ViewBarProps) {
  const { t } = useTranslation('view');
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const shared = views.filter((view) => !view.is_personal);
  const personal = views.filter((view) => view.is_personal);
  const editShared = canEditViews(access, tableId);
  const state = useViewConfig(active, canSaveViewConfig(access, tableId, active));
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
  const [stripRef, stripWidth] = useWidth();
  const [newViewRef, newViewWidth] = useWidth();

  const pathOf = (viewId: string) =>
    `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}/v/${encodeURIComponent(viewId)}`;
  const open = (viewId: string, focus = false) => {
    if (focus) focusTabWhenOpen(viewId);
    void navigate(pathOf(viewId));
  };
  useEffect(() => {
    if (takeTabFocus(active.id)) focusActiveTab(active.id);
  }, [active.id]);

  const create = useCreateView(tableId);
  const duplicate = useDuplicateView(tableId);
  const update = useUpdateView(tableId);
  const move = useMoveView(tableId);

  const createView = (type: ViewType, isPersonal: boolean) => {
    const group = isPersonal ? personal : shared;
    const name = uniqueViewName(
      t(`defaultName.${type}`),
      group.map((view) => view.name),
    );
    create.mutate(
      { name, type, is_personal: isPersonal },
      {
        onSuccess: (view) => {
          open(view.id, true);
        },
        onError: (error) => showErrorToast(error),
      },
    );
  };

  const actions: TabActions = {
    rename: (view) => {
      setDialog({ kind: 'rename', view });
    },
    remove: (view) => {
      setDialog({ kind: 'delete', view });
    },
    duplicate: (view) => {
      duplicate.mutate(
        // Without rights on shared views, a copy of a shared view is personal.
        { viewId: view.id, ...(!view.is_personal && !editShared ? { personal: true } : {}) },
        {
          onSuccess: (copy) => {
            open(copy.id, true);
          },
          onError: (error) => showErrorToast(error),
        },
      );
    },
    move: (view, index) => {
      move.mutate({ viewId: view.id, index }, { onError: (error) => showErrorToast(error) });
    },
    lock: (view, locked) => {
      update.mutate(
        { viewId: view.id, body: { locked } },
        {
          onSuccess: () => {
            showToast({
              message: t(locked ? 'lock.locked' : 'lock.unlocked', { name: view.name }),
            });
          },
          onError: (error) => showErrorToast(error),
        },
      );
    },
  };

  const permissions = {
    editShared,
    lock: canLockViews(access, tableId),
    sharedCount: shared.length,
    canEdit: (view: ViewDto) => canEditView(access, tableId, view),
  };

  // A closed dialog is unmounted: the focus goes back to the open view's tab
  // (after a delete of the open view, to the tab of the view that replaces it).
  const closeDialog = (deleted?: ViewDto) => {
    setDialog(null);
    if (deleted?.id === active.id) focusTabWhenOpen('*');
    else focusActiveTab(active.id);
  };

  const ordered = [...shared, ...personal];
  // The strip also holds "New view" (measured) and, with personal views, their separator.
  const reserved =
    newViewWidth + TAB_GAP + (shared.length > 0 && personal.length > 0 ? GROUP_SEPARATOR_WIDTH : 0);
  const mins = ordered.map((view) => tabMinWidthOf(view));
  const plan = planTabs(
    ordered,
    active.id,
    tabCapacity(
      stripWidth,
      ordered.length,
      reserved,
      mins,
      ordered.findIndex((view) => view.id === active.id),
    ),
  );
  const shown = new Set(plan.visible.map((view) => view.id));

  const newViewTrigger = (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size={narrow ? 'icon' : 'toolbar'}
        className="shrink-0 text-fg-muted"
        disabled={create.isPending}
        aria-label={narrow ? t('create.button') : undefined}
      >
        <Plus aria-hidden="true" />
        {narrow ? null : t('create.button')}
      </Button>
    </DropdownMenuTrigger>
  );
  const newView = (
    <DropdownMenu>
      {/* Narrow screens: the icon alone, named by its tooltip. */}
      {narrow ? <Tooltip content={t('create.button')}>{newViewTrigger}</Tooltip> : newViewTrigger}
      <DropdownMenuContent align="start">
        {editShared ? (
          <>
            <DropdownMenuLabel>{t('create.shared')}</DropdownMenuLabel>
            <TypeItems
              onSelect={(type) => {
                createView(type, false);
              }}
            />
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{t('create.personal')}</DropdownMenuLabel>
        <TypeItems
          personal
          onSelect={(type) => {
            createView(type, true);
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    // 40 px on desktop; touch-sized screens get 44 px controls (FRONTEND §9.3).
    <div className="flex min-h-10 shrink-0 items-stretch gap-2 border-b border-line bg-surface px-3 lg:px-4">
      <nav
        aria-label={t('bar.label', { table: tableName })}
        className="flex min-w-0 flex-1 items-stretch gap-1"
      >
        {narrow ? (
          <ViewSwitcher
            shared={shared}
            personal={personal}
            active={active}
            pathOf={pathOf}
            actions={actions}
            permissions={permissions}
          />
        ) : (
          <div ref={stripRef} className="flex min-w-0 flex-1 items-stretch gap-1">
            <div className="flex min-w-0 items-stretch gap-1">
              <TabGroup
                label={t('bar.shared')}
                views={shared}
                shown={shown}
                active={active}
                pathOf={pathOf}
                sortable={editShared}
                actions={actions}
                permissions={permissions}
              />
              {personal.some((view) => shown.has(view.id)) ? (
                <>
                  <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 self-center bg-line" />
                  <TabGroup
                    label={t('bar.personal')}
                    views={personal}
                    shown={shown}
                    active={active}
                    pathOf={pathOf}
                    sortable
                    actions={actions}
                    permissions={permissions}
                  />
                </>
              ) : null}
            </div>
            {plan.overflow.length > 0 ? (
              <OverflowViews views={plan.overflow} pathOf={pathOf} />
            ) : null}
            <div ref={newViewRef} className="flex shrink-0 items-center">
              {newView}
            </div>
          </div>
        )}
        {narrow ? <div className="flex shrink-0 items-center">{newView}</div> : null}
      </nav>
      <UnsavedChanges
        view={active}
        state={state}
        onOpenView={(viewId) => {
          open(viewId, true);
        }}
        compact={narrow}
      />
      {extra === undefined || extra === null ? null : (
        // Export and share (other features): labels hidden on narrow screens (their names
        // stay); touch-sized screens: 44 px targets (T322a).
        <div className="flex shrink-0 items-center gap-1 max-lg:[&_button]:h-control max-lg:[&_button]:min-w-control max-sm:[&_button]:gap-0 max-sm:[&_button]:text-[0px]">
          {extra}
        </div>
      )}
      {dialog?.kind === 'rename' ? (
        <RenameViewDialog
          view={dialog.view}
          onClose={() => {
            closeDialog();
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteViewDialog
          view={dialog.view}
          onClose={(deleted) => {
            closeDialog(deleted === true ? dialog.view : undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** "⋯ N views": the views whose tabs do not fit, in bar order. */
function OverflowViews({
  views,
  pathOf,
}: {
  views: readonly ViewDto[];
  pathOf: (viewId: string) => string;
}) {
  const { t } = useTranslation('view');
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="toolbar"
          className="shrink-0 self-center text-fg-muted"
          data-testid="view-overflow"
          aria-label={t('bar.moreLabel', { count: views.length })}
        >
          <MoreHorizontal aria-hidden="true" />
          {t('bar.more', { count: views.length })}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        {views.map((view) => (
          <ViewMenuItem
            key={view.id}
            view={view}
            onSelect={() => {
              void navigate(pathOf(view.id));
            }}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenuItem({
  view,
  current = false,
  onSelect,
}: {
  view: ViewDto;
  current?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('view');
  const Icon = TYPE_ICONS[view.type];
  return (
    <DropdownMenuItem
      aria-current={current ? 'page' : undefined}
      className={cn(current && 'font-medium text-accent')}
      onSelect={onSelect}
    >
      <Icon aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{view.name}</span>
      {view.is_personal ? (
        <UserRound aria-label={t('tab.personal')} role="img" className="size-3.5 shrink-0" />
      ) : null}
      {view.locked ? (
        <Lock aria-label={t('tab.locked')} role="img" className="size-3.5 shrink-0" />
      ) : null}
    </DropdownMenuItem>
  );
}

/**
 * Narrow screens (T320b, QA S3 at 390 px): the open view's name opens a
 * menu of every view; its options sit next to it.
 */
function ViewSwitcher({
  shared,
  personal,
  active,
  pathOf,
  actions,
  permissions,
}: {
  shared: readonly ViewDto[];
  personal: readonly ViewDto[];
  active: ViewDto;
  pathOf: (viewId: string) => string;
  actions: TabActions;
  permissions: TabPermissions;
}) {
  const { t } = useTranslation('view');
  const navigate = useNavigate();
  const Icon = TYPE_ICONS[active.type];
  const group = active.is_personal ? personal : shared;
  const item = (view: ViewDto) => (
    <ViewMenuItem
      key={view.id}
      view={view}
      current={view.id === active.id}
      onSelect={() => {
        void navigate(pathOf(view.id));
      }}
    />
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="toolbar"
            data-testid="view-switcher"
            aria-label={t('bar.switch', { name: active.name })}
            className="min-w-0 justify-start font-medium text-fg"
          >
            <Icon aria-hidden="true" />
            <span className="min-w-0 truncate">{active.name}</span>
            <ChevronDown aria-hidden="true" className="text-fg-muted" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>{t('bar.shared')}</DropdownMenuLabel>
          {shared.map(item)}
          {personal.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('bar.personal')}</DropdownMenuLabel>
              {personal.map(item)}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ViewOptionsMenu
        view={active}
        index={group.findIndex((view) => view.id === active.id)}
        count={group.length}
        sortable={active.is_personal || permissions.editShared}
        actions={actions}
        permissions={permissions}
        alwaysVisible
      />
    </div>
  );
}

function TypeItems({
  onSelect,
  personal = false,
}: {
  onSelect: (type: ViewType) => void;
  personal?: boolean;
}) {
  const { t } = useTranslation('view');
  return VIEW_TYPES.map((type) => {
    const Icon = TYPE_ICONS[type];
    return (
      <DropdownMenuItem
        key={type}
        data-testid={`create-view-${personal ? 'personal' : 'shared'}-${type}`}
        onSelect={() => {
          onSelect(type);
        }}
      >
        <Icon aria-hidden="true" />
        {t(`types.${type}`)}
      </DropdownMenuItem>
    );
  });
}

interface TabActions {
  readonly rename: (view: ViewDto) => void;
  readonly remove: (view: ViewDto) => void;
  readonly duplicate: (view: ViewDto) => void;
  readonly move: (view: ViewDto, index: number) => void;
  readonly lock: (view: ViewDto, locked: boolean) => void;
}

interface TabPermissions {
  readonly editShared: boolean;
  readonly lock: boolean;
  readonly sharedCount: number;
  readonly canEdit: (view: ViewDto) => boolean;
}

interface TabGroupProps {
  readonly label: string;
  /** Every view of the group, in order (indexes of "Move left/right" are in this list). */
  readonly views: readonly ViewDto[];
  /** Views whose tab is shown (the others are in the overflow menu). */
  readonly shown: ReadonlySet<string>;
  readonly active: ViewDto;
  readonly pathOf: (viewId: string) => string;
  /** Whether the user may reorder this group. */
  readonly sortable: boolean;
  readonly actions: TabActions;
  readonly permissions: TabPermissions;
}

/** One group of tabs (shared or personal), reordered by dragging within the group. */
function TabGroup({
  label,
  views,
  shown,
  active,
  pathOf,
  sortable,
  actions,
  permissions,
}: TabGroupProps) {
  const { t } = useTranslation('view');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // A click that ends a drag must not open the view.
  const dragged = useRef(false);
  const nameOf = (id: string | number) => views.find((view) => view.id === id)?.name ?? '';
  const announcements: Announcements = {
    onDragStart: ({ active: item }) => t('dnd.start', { name: nameOf(item.id) }),
    onDragOver: ({ active: item, over }) =>
      over === null ? undefined : t('dnd.over', { name: nameOf(item.id), over: nameOf(over.id) }),
    onDragEnd: ({ active: item, over }) =>
      over === null
        ? t('dnd.cancel', { name: nameOf(item.id) })
        : t('dnd.end', { name: nameOf(item.id) }),
    onDragCancel: ({ active: item }) => t('dnd.cancel', { name: nameOf(item.id) }),
  };
  const visible = views.filter((view) => shown.has(view.id));
  const canDrag = sortable && visible.length > 1;
  // dnd-kit stops the propagation of the click that ends a drag (a window
  // capture listener), so React never sees it — but its default action, the
  // tab link, still ran: a full page load of the dragged view (QA S3). The
  // drag cancels that default itself, until just after it ends.
  const blockClick = useRef<((event: Event) => void) | null>(null);
  useEffect(
    () => () => {
      if (blockClick.current !== null) {
        window.removeEventListener('click', blockClick.current, { capture: true });
      }
    },
    [],
  );
  const onDragStart = () => {
    if (blockClick.current !== null) return;
    const listener = (event: Event) => {
      event.preventDefault();
    };
    blockClick.current = listener;
    window.addEventListener('click', listener, { capture: true });
  };
  const markDragged = () => {
    dragged.current = true;
    const listener = blockClick.current;
    window.setTimeout(() => {
      dragged.current = false;
      if (listener !== null) window.removeEventListener('click', listener, { capture: true });
      if (blockClick.current === listener) blockClick.current = null;
    }, 0);
  };
  const onDragEnd = ({ active: item, over }: DragEndEvent) => {
    markDragged();
    if (over === null || item.id === over.id) return;
    const view = views.find((candidate) => candidate.id === item.id);
    const index = views.findIndex((candidate) => candidate.id === over.id);
    if (view !== undefined && index >= 0) actions.move(view, index);
  };
  if (visible.length === 0) return null;
  const list = (
    <ul aria-label={label} className="flex min-w-0 items-stretch gap-1">
      {visible.map((view) => {
        const index = views.indexOf(view);
        const props = {
          view,
          index,
          count: views.length,
          active: view.id === active.id,
          href: pathOf(view.id),
          sortable,
          actions,
          permissions,
        };
        return canDrag ? (
          <SortableViewTab key={view.id} {...props} dragged={dragged} />
        ) : (
          <ViewTab key={view.id} {...props} />
        );
      })}
    </ul>
  );
  // Nothing to drag: no drag-and-drop (and no live region) at all.
  if (!canDrag) return list;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={markDragged}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('dnd.instructions') },
      }}
    >
      <SortableContext
        items={visible.map((view) => view.id)}
        strategy={horizontalListSortingStrategy}
      >
        {list}
      </SortableContext>
    </DndContext>
  );
}

interface ViewTabProps {
  readonly view: ViewDto;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
  readonly href: string;
  /** The group may be reordered (drag, "Move left/right"). */
  readonly sortable: boolean;
  readonly actions: TabActions;
  readonly permissions: TabPermissions;
  /** Drag wiring of {@link SortableViewTab}. */
  readonly drag?: {
    readonly setNodeRef: (node: HTMLElement | null) => void;
    readonly listeners: Record<string, unknown> | undefined;
    readonly style: CSSProperties;
    readonly isDragging: boolean;
    readonly dragged: { readonly current: boolean };
  };
}

function SortableViewTab({
  dragged,
  ...props
}: ViewTabProps & { readonly dragged: { readonly current: boolean } }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: props.view.id,
  });
  return (
    <ViewTab
      {...props}
      drag={{
        setNodeRef,
        listeners,
        style: { transform: CSS.Translate.toString(transform), transition },
        isDragging,
        dragged,
      }}
    />
  );
}

function ViewTab({
  view,
  index,
  count,
  active,
  href,
  sortable,
  actions,
  permissions,
  drag,
}: ViewTabProps) {
  const { t } = useTranslation('view');
  const [menuOpen, setMenuOpen] = useState(false);
  // Only a click opens the view: the release of a drag (the pointer moved) does not (QA S3).
  const pressed = useRef<{ x: number; y: number } | null>(null);
  const Icon = TYPE_ICONS[view.type];
  const canEdit = permissions.canEdit(view);
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    setMenuOpen(true);
  };
  const dragPointerDown = drag?.listeners?.['onPointerDown'] as
    ((event: PointerEvent) => void) | undefined;
  return (
    <li
      ref={drag?.setNodeRef}
      // Tabs shrink to TAB_MIN_WIDTH (about 12 characters) with an ellipsis, never
      // below: the bar sends the tabs that do not fit to the overflow menu (T322a).
      style={{
        ...drag?.style,
        // The open tab's "…" button is a control (`--control-height` wide).
        minWidth: active
          ? `calc(${String(tabMinWidthOf(view))}px + var(--control-height))`
          : tabMinWidthOf(view),
      }}
      className={cn(
        'group relative flex max-w-60 items-stretch',
        // The open tab gives up its room last.
        active ? 'shrink-[0.2] text-fg' : 'shrink text-fg-muted hover:text-fg',
        drag?.isDragging === true && 'z-10 rounded-md bg-surface shadow-popover',
      )}
      data-testid={`view-tab-${view.id}`}
      onContextMenu={onContextMenu}
    >
      <NavLink
        to={href}
        aria-current={active ? 'page' : undefined}
        title={view.name}
        draggable={false}
        className={cn(
          '-mb-px flex min-w-0 flex-1 items-center gap-1.5 border-b-2 pr-1 pl-2 text-body whitespace-nowrap',
          active ? 'border-accent font-medium' : 'border-transparent',
        )}
        {...drag?.listeners}
        onPointerDown={(event: PointerEvent) => {
          pressed.current = { x: event.clientX, y: event.clientY };
          dragPointerDown?.(event);
        }}
        onClickCapture={(event) => {
          const moved = !isClick(pressed.current, { x: event.clientX, y: event.clientY });
          pressed.current = null;
          // A keyboard click (Enter) has no pointer press and always opens the view.
          if (drag?.dragged.current === true || (event.detail > 0 && moved)) {
            event.preventDefault();
          }
        }}
        onDoubleClick={() => {
          if (canEdit) actions.rename(view);
        }}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{view.name}</span>
        {view.is_personal ? (
          <UserRound aria-label={t('tab.personal')} role="img" className="size-3.5 shrink-0" />
        ) : null}
        {view.locked ? (
          <Lock aria-label={t('tab.locked')} role="img" className="size-3.5 shrink-0" />
        ) : null}
      </NavLink>
      <ViewOptionsMenu
        view={view}
        index={index}
        count={count}
        sortable={sortable}
        actions={actions}
        permissions={permissions}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        alwaysVisible={active}
        // Other tabs: over the end of the name, so a hidden button takes no room.
        className={active ? undefined : 'absolute top-1/2 right-0 -translate-y-1/2 bg-surface'}
      />
    </li>
  );
}

/** The "…" menu of a view (tab, or the switcher on narrow screens); right-click opens it too. */
function ViewOptionsMenu({
  view,
  index,
  count,
  sortable,
  actions,
  permissions,
  open,
  onOpenChange,
  alwaysVisible = false,
  className,
}: {
  view: ViewDto;
  index: number;
  count: number;
  sortable: boolean;
  actions: TabActions;
  permissions: TabPermissions;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown without hover (the open view). */
  alwaysVisible?: boolean;
  className?: string | undefined;
}) {
  const { t } = useTranslation('view');
  const [ownOpen, setOwnOpen] = useState(false);
  const menuOpen = open ?? ownOpen;
  const setMenuOpen = onOpenChange ?? setOwnOpen;
  const canEdit = permissions.canEdit(view);
  const lastShared = !view.is_personal && permissions.sharedCount <= 1;
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip content={t('tab.options', { name: view.name })}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('tab.options', { name: view.name })}
            className={cn(
              'shrink-0 self-center text-current',
              alwaysVisible || menuOpen
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              className,
            )}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" aria-label={t('tab.options', { name: view.name })}>
        {canEdit ? (
          <DropdownMenuItem
            onSelect={() => {
              actions.rename(view);
            }}
          >
            <Pencil aria-hidden="true" />
            {t('menu.rename')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            actions.duplicate(view);
          }}
        >
          <Copy aria-hidden="true" />
          {!view.is_personal && !permissions.editShared
            ? t('menu.duplicatePersonal')
            : t('menu.duplicate')}
        </DropdownMenuItem>
        {sortable && count > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={index <= 0}
              onSelect={() => {
                actions.move(view, index - 1);
              }}
            >
              <ArrowLeft aria-hidden="true" />
              {t('menu.moveLeft')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === count - 1}
              onSelect={() => {
                actions.move(view, index + 1);
              }}
            >
              <ArrowRight aria-hidden="true" />
              {t('menu.moveRight')}
            </DropdownMenuItem>
          </>
        ) : null}
        {permissions.lock && !view.is_personal ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                actions.lock(view, !view.locked);
              }}
            >
              {view.locked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
              {view.locked ? t('menu.unlock') : t('menu.lock')}
            </DropdownMenuItem>
          </>
        ) : null}
        {canEdit ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={view.locked || lastShared}
              className="text-danger [&_svg]:text-danger"
              onSelect={() => {
                actions.remove(view);
              }}
            >
              <Trash2 aria-hidden="true" />
              {view.locked
                ? t('menu.deleteLocked')
                : lastShared
                  ? t('menu.deleteLast')
                  : t('menu.delete')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
