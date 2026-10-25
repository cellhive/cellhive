import { Button, cn, Select, Skeleton, Tooltip } from '@cellhive/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertCircle, BellOff, CheckCheck, CheckCircle2, Settings, X } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { notificationListQuery, type ListFilter } from '../api';
import { basesOf, groupRows } from '../model/items';
import { unreadCountQuery } from '../shell/unread';

import { NotificationGroup, NotificationItem } from './NotificationItem';
import { useMarkRead } from './use-mark-read';
import { useRefreshOnOpen } from './use-refresh-on-open';

import type { NotificationDto } from '@cellhive/contracts';

type NotificationId = NotificationDto['id'];
type BaseId = NonNullable<NotificationDto['base']>['id'];

/** Width of the popover (board "S5 · Notification center"). */
const PANEL_WIDTH = 420;
const GAP = 8;
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

/** Popover position next to the bell, kept inside the window. */
function usePosition(anchor: RefObject<HTMLElement | null>, narrow: boolean) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (narrow) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - GAP));
      setPosition({ top: rect.bottom + GAP, left });
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  }, [anchor, narrow]);
  return position;
}

function LoadingRows() {
  const { t } = useTranslation('notifications');
  return (
    <div role="status" aria-busy="true" aria-label={t('panel.loading')} data-testid="panel-loading">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-2.5 border-t border-line px-4 py-3">
          <Skeleton className="size-8 rounded-lg" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-[70%]" />
            <Skeleton className="h-2.5 w-[45%]" />
          </span>
        </div>
      ))}
    </div>
  );
}

function FilterTabs({
  unread,
  unreadCount,
  onChange,
}: {
  readonly unread: boolean;
  readonly unreadCount: number;
  readonly onChange: (unread: boolean) => void;
}) {
  const { t, i18n } = useTranslation('notifications');
  const options = [false, true] as const;
  return (
    <div
      role="radiogroup"
      aria-label={t('panel.filter')}
      className="inline-flex h-control items-center gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5 lg:h-8"
    >
      {options.map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={unread === value}
          tabIndex={unread === value ? 0 : -1}
          data-testid={value ? 'filter-unread' : 'filter-all'}
          className={cn(
            'inline-flex h-full items-center gap-1.5 rounded-sm px-3 text-label font-normal whitespace-nowrap text-fg-muted',
            unread === value && 'bg-surface font-medium text-fg shadow-sm',
          )}
          onClick={() => {
            onChange(value);
          }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            onChange(!value);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(
                `[data-testid="filter-${value ? 'all' : 'unread'}"]`,
              )
              ?.focus();
          }}
        >
          {value ? t('panel.unread') : t('panel.all')}
          {value && unreadCount > 0 ? (
            <span className="tabular-nums">
              {new Intl.NumberFormat(i18n.language).format(unreadCount)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export interface NotificationPanelProps {
  readonly org: { readonly id: string; readonly slug: string };
  readonly anchor: RefObject<HTMLButtonElement | null>;
  /** `restoreFocus`: back to the bell (Escape, close button), not after a click outside. */
  readonly onClose: (restoreFocus: boolean) => void;
}

/**
 * The notification center (T524, FRONTEND §14; boards "S5 · Notification
 * center", "… - 375 px"): a non-modal popover next to the bell from 768 px,
 * the whole screen below. All | Unread, a base filter, "Mark all as read",
 * cursor pages ("Load more"), bursts of automation messages grouped,
 * loading / empty / error states. Escape and the close button give the
 * focus back to the bell; a click outside closes.
 */
export function NotificationPanel({ org, anchor, onClose }: NotificationPanelProps) {
  const { t } = useTranslation('notifications');
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const position = usePosition(anchor, narrow);
  const panel = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState<ListFilter>({ unread: false, baseId: null });
  const list = useInfiniteQuery(notificationListQuery(org.id, filter));
  const count = useQuery(unreadCountQuery(org.id)).data?.count ?? 0;
  const markRead = useMarkRead(org.id);
  // T556 (QA S5 L2): the count and lists are fetched again once per opening.
  useRefreshOnOpen(org.id);
  // The page behind the full-screen panel (below): released before `onClose`,
  // which gives the focus back to the bell at once.
  const releaseBehind = useRef<() => void>(() => undefined);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = (restoreFocus) => {
      releaseBehind.current();
      onClose(restoreFocus);
    };
  });

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const rows = useMemo(() => groupRows(items), [items]);
  // The base filter offers the bases the list has mentioned so far (no org-wide base list API).
  const [knownBases, setKnownBases] = useState<readonly { id: string; name: string }[]>([]);
  const merged = basesOf([...knownBases.map((base) => ({ base })), ...items]);
  if (merged.length !== knownBases.length) setKnownBases(merged);

  // Focus moves into the panel; Escape closes; a click outside closes.
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target) === true || anchor.current?.contains(target) === true) {
        return;
      }
      closeRef.current(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [anchor]);

  // Below 768 px the panel covers the whole screen: the page behind it leaves
  // the accessibility tree and the tab order until it closes (T527: axe
  // target-size on the grid's controls "obscured" by the panel).
  useEffect(() => {
    const node = panel.current;
    if (!narrow || node === null) return;
    const behind = [...document.body.children].filter(
      (element) => element !== node && !element.hasAttribute('inert'),
    );
    for (const element of behind) element.setAttribute('inert', '');
    const release = () => {
      for (const element of behind) element.removeAttribute('inert');
      releaseBehind.current = () => undefined;
    };
    releaseBehind.current = release;
    return release;
  }, [narrow]);

  const onOpen = (item: NotificationDto) => {
    if (item.read_at === null) markRead.mutate({ ids: [item.id] });
    closeRef.current(false);
  };
  const onMarkRead = (ids: readonly [NotificationId, ...NotificationId[]]) => {
    markRead.mutate({ ids });
  };
  const settingsPath = `/o/${encodeURIComponent(org.slug)}/settings/notifications`;
  const anyUnread =
    filter.baseId === null ? count > 0 : items.some((item) => item.read_at === null);

  const body = list.isPending ? (
    <LoadingRows />
  ) : list.isError ? (
    <div role="alert" data-testid="panel-error" className="flex gap-3 border-t border-line p-4">
      <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex flex-col items-start gap-1">
        <strong className="text-body font-semibold">{t('panel.errorTitle')}</strong>
        <span className="text-label font-normal text-fg-muted">{t('panel.errorBody')}</span>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2 max-lg:h-control"
          onClick={() => {
            void list.refetch();
          }}
        >
          {t('panel.retry')}
        </Button>
      </div>
    </div>
  ) : rows.length === 0 ? (
    <div
      data-testid="panel-empty"
      className="flex flex-col items-center gap-2 border-t border-line px-6 py-10 text-center"
    >
      {filter.unread ? (
        <CheckCircle2 aria-hidden="true" className="size-8 text-accent" />
      ) : (
        <BellOff aria-hidden="true" className="size-8 text-fg-muted" />
      )}
      <span className="text-body font-medium">
        {filter.unread ? t('panel.emptyUnread') : t('panel.empty')}
      </span>
      <span className="text-label font-normal text-fg-muted">{t('panel.emptyHint')}</span>
    </div>
  ) : (
    <>
      <ul className="list-none" data-testid="notification-list">
        {rows.map((row) =>
          row.kind === 'item' ? (
            <NotificationItem
              key={row.item.id}
              item={row.item}
              onOpen={onOpen}
              onMarkRead={onMarkRead}
            />
          ) : (
            <NotificationGroup
              key={row.key}
              items={row.items}
              onOpen={onOpen}
              onMarkRead={onMarkRead}
            />
          ),
        )}
      </ul>
      {list.hasNextPage ? (
        <div className="border-t border-line p-2 text-center">
          <Button
            variant="ghost"
            size="sm"
            className="max-lg:h-control"
            disabled={list.isFetchingNextPage}
            aria-busy={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage ? t('panel.loadingMore') : t('panel.loadMore')}
          </Button>
        </div>
      ) : null}
    </>
  );

  const content = (
    <section
      ref={panel}
      role="dialog"
      aria-label={t('panel.title')}
      aria-modal={narrow || undefined}
      tabIndex={-1}
      data-testid="notification-panel"
      className={cn(
        'z-50 flex flex-col overflow-hidden bg-surface text-fg outline-none',
        narrow
          ? 'fixed inset-0'
          : 'fixed max-h-[min(640px,calc(100dvh-4rem))] rounded-lg border border-line shadow-popover animate-pop-in',
      )}
      style={
        narrow
          ? undefined
          : {
              width: `min(${String(PANEL_WIDTH)}px, calc(100vw - ${String(2 * GAP)}px))`,
              top: position?.top ?? 48,
              left: position?.left ?? GAP,
            }
      }
    >
      {narrow ? (
        <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('panel.close')}
            onClick={() => {
              closeRef.current(true);
            }}
          >
            <X aria-hidden="true" />
          </Button>
          <span className="text-heading">{t('panel.title')}</span>
        </header>
      ) : null}
      <div className="flex items-center gap-2 pt-3 pr-3 pb-2 pl-4">
        <h2 className="text-heading">{t('panel.title')}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto max-lg:h-control"
          data-testid="mark-all-read"
          disabled={!anyUnread || markRead.isPending}
          onClick={() => {
            markRead.mutate({ all: true, baseId: filter.baseId as BaseId | null });
          }}
        >
          <CheckCheck aria-hidden="true" />
          {t('panel.markAllRead')}
        </Button>
        <Tooltip content={t('panel.settings')}>
          <Link
            to={settingsPath}
            aria-label={t('panel.settings')}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg max-lg:size-control"
            onClick={() => {
              closeRef.current(false);
            }}
          >
            <Settings aria-hidden="true" className="size-4" />
          </Link>
        </Tooltip>
      </div>
      <div className="flex items-center gap-2 px-4 pb-2.5">
        <FilterTabs
          unread={filter.unread}
          unreadCount={count}
          onChange={(unread) => {
            setFilter((current) => ({ ...current, unread }));
          }}
        />
        <Select
          aria-label={t('panel.baseFilter')}
          data-testid="base-filter"
          className="ml-auto w-40"
          value={filter.baseId ?? ''}
          onChange={(event) => {
            const baseId = event.target.value;
            setFilter((current) => ({ ...current, baseId: baseId === '' ? null : baseId }));
          }}
        >
          <option value="">{t('panel.allBases')}</option>
          {knownBases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.name}
            </option>
          ))}
        </Select>
      </div>
      <span role="status" aria-atomic="true" className="sr-only">
        {count === 0 ? t('panel.noneUnread') : t('panel.unreadStatus', { count })}
      </span>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <div className="flex border-t border-line px-4 py-2.5 text-label font-normal">
        <Link
          to={settingsPath}
          className="ml-auto text-accent underline-offset-4 hover:underline max-lg:py-3"
          onClick={() => {
            closeRef.current(false);
          }}
        >
          {t('panel.settingsLink')}
        </Link>
      </div>
    </section>
  );
  return createPortal(content, document.body);
}

export default NotificationPanel;
