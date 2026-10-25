import { cn, Tooltip } from '@cellhive/ui';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Eye,
  FileCheck2,
  FileMinus2,
  FileX2,
  List,
  Lock,
  PauseCircle,
  UserPlus,
  XCircle,
  Zap,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '../../../lib/i18n/format';
import { dataString, isMandatory, linkOf, lostAccess, type ItemKind } from '../model/items';

import { AssignedRecords } from './AssignedRecords';
import { ImportReport } from './ImportReport';
import { useItemView } from './use-item-view';

import type { ItemPill } from '../model/types';
import type { NotificationDto } from '@cellhive/contracts';

type NotificationId = NotificationDto['id'];

const ICONS = {
  message: Zap,
  disabled: PauseCircle,
  overflow: AlertTriangle,
  assigned: UserPlus,
  followed: Eye,
  reminder: CalendarClock,
  importSucceeded: FileCheck2,
  importFailed: FileX2,
  importCancelled: FileMinus2,
  other: Bell,
} as const;

/**
 * Tones of the icon tile: data colors with ≥ 4.5:1 text (FRONTEND §9.3),
 * never the accent alone; the type is also in the text and the icon.
 */
const TONES: Record<ItemKind | 'group', string> = {
  message: 'bg-accent-soft text-accent',
  disabled: 'bg-option-4 text-on-option-4',
  overflow: 'bg-option-3 text-on-option-3',
  assigned: 'bg-option-1 text-on-option-1',
  followed: 'bg-option-7 text-on-option-7',
  reminder: 'bg-option-6 text-on-option-6',
  importSucceeded: 'bg-option-2 text-on-option-2',
  importFailed: 'bg-option-4 text-on-option-4',
  importCancelled: 'bg-option-0 text-on-option-0',
  other: 'bg-surface-sunken text-fg-muted',
  group: 'bg-surface-sunken text-fg-muted',
};

function IconTile({ kind }: { readonly kind: ItemKind | 'group' }) {
  const Icon = kind === 'group' ? List : ICONS[kind];
  return (
    <span
      aria-hidden="true"
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', TONES[kind])}
    >
      <Icon className="size-4" />
    </span>
  );
}

const PILL_ICONS = {
  neutral: Clock,
  warning: AlertTriangle,
  danger: XCircle,
  success: CheckCircle2,
} as const;
const PILL_TONES: Record<ItemPill['tone'], string> = {
  neutral: 'bg-option-0 text-on-option-0',
  warning: 'bg-option-3 text-on-option-3',
  danger: 'bg-option-4 text-on-option-4',
  success: 'bg-option-2 text-on-option-2',
};

/** A status chip (reminders: upcoming / due today / overdue): text + icon, never color alone. */
function StatusPill({ pill }: { readonly pill: ItemPill }) {
  const Icon = PILL_ICONS[pill.tone];
  return (
    <span
      data-testid="status-pill"
      className={cn(
        'inline-flex h-[18px] items-center gap-1 rounded-sm px-2 text-label font-medium whitespace-nowrap',
        PILL_TONES[pill.tone],
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {pill.label}
    </span>
  );
}

function UnreadMark({
  item,
  onMarkRead,
}: {
  readonly item: NotificationDto;
  readonly onMarkRead: (ids: readonly [NotificationId, ...NotificationId[]]) => void;
}) {
  const { t } = useTranslation('notifications');
  if (item.read_at !== null) return <span aria-hidden="true" className="w-8 shrink-0" />;
  return (
    <Tooltip content={t('item.markRead')}>
      <button
        type="button"
        aria-label={t('item.markRead')}
        data-testid={`mark-read-${item.id}`}
        className="-my-1 flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-sunken max-lg:size-control"
        onClick={() => {
          onMarkRead([item.id]);
        }}
      >
        <span className="size-2 rounded-full bg-accent" />
      </button>
    </Tooltip>
  );
}

export interface ItemProps {
  readonly item: NotificationDto;
  readonly onOpen: (item: NotificationDto) => void;
  readonly onMarkRead: (ids: readonly [NotificationId, ...NotificationId[]]) => void;
  /** Inside an expanded group: no icon tile, indented. */
  readonly nested?: boolean;
}

/**
 * One notification (board "S5 · Notification center"): icon by type, title
 * (bold while unread), body, "automation · base · time"; the title links to
 * what it is about. Lost access (CONTRACTS §22.3: `title = null`) shows a
 * lock and "No longer allowed to view…" without a link. Mandatory types
 * carry "Always sent". The dot marks it unread and is the "mark read" button.
 * Text per type comes from `model/types/*` (T552): S5b types add a status
 * chip (reminders), the records of a bulk assignment, the error report of
 * an import.
 */
export function NotificationItem({ item, onOpen, onMarkRead, nested = false }: ItemProps) {
  const { t } = useTranslation('notifications');
  const format = useFormatters();
  const view = useItemView(item);
  const { title, body, kind } = view;
  const link = linkOf(item);
  const lost = lostAccess(item);
  const unread = item.read_at === null;
  const context =
    item.type === 'automation.message' && item.entity.type === 'record' ? item.entity.title : null;
  return (
    <li
      data-testid={`notification-${item.id}`}
      data-unread={unread}
      className={cn('flex gap-2.5 border-t border-line px-4 py-3', nested && 'pl-14')}
    >
      {nested ? null : <IconTile kind={kind} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {link === null ? (
          <span className={cn('text-body break-words', unread ? 'font-semibold' : 'text-fg')}>
            {title}
          </span>
        ) : (
          <Link
            to={link}
            className={cn(
              'text-body break-words text-fg underline-offset-2 hover:underline',
              unread && 'font-semibold',
            )}
            onClick={() => {
              onOpen(item);
            }}
          >
            {title}
          </Link>
        )}
        {body === null ? null : (
          <span className="line-clamp-3 text-label font-normal whitespace-pre-line text-fg-muted">
            {body}
          </span>
        )}
        {view.records === null ? null : (
          <AssignedRecords
            item={item}
            ids={view.records.ids}
            count={view.records.count}
            onOpen={onOpen}
          />
        )}
        {view.report === null ? null : (
          <ImportReport
            jobId={view.report.jobId}
            onUsed={() => {
              if (unread) onMarkRead([item.id]);
            }}
          />
        )}
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label font-normal text-fg-muted">
          {[context, item.base?.name ?? null]
            .filter((part): part is string => part !== null && part !== '')
            .map((part) => (
              <span key={part} className="after:ml-1.5 after:content-['·']">
                {part}
              </span>
            ))}
          <time dateTime={item.created_at} title={format.dateTime(item.created_at)}>
            {format.relative(item.created_at)}
          </time>
          {view.pill === null ? null : <StatusPill pill={view.pill} />}
          {isMandatory(item) ? (
            <span className="inline-flex h-[18px] items-center gap-1 rounded-sm bg-surface-sunken px-2 text-label text-fg-muted">
              <Lock aria-hidden="true" className="size-3" />
              {t('item.alwaysSent')}
            </span>
          ) : null}
        </span>
        {lost ? (
          <span
            data-testid={`lost-access-${item.id}`}
            className="inline-flex items-center gap-1 text-label font-normal text-fg-muted"
          >
            <Lock aria-hidden="true" className="size-3" />
            {item.base === null
              ? t('item.lostBase')
              : item.entity.type === 'automation'
                ? t('item.lostAutomation')
                : item.entity.type === 'table'
                  ? t('item.lostTable')
                  : t('item.lostRecord')}
          </span>
        ) : null}
      </div>
      <UnreadMark item={item} onMarkRead={onMarkRead} />
    </li>
  );
}

export interface GroupProps {
  readonly items: readonly NotificationDto[];
  readonly onOpen: (item: NotificationDto) => void;
  readonly onMarkRead: (ids: readonly [NotificationId, ...NotificationId[]]) => void;
}

/**
 * A burst of messages of one automation (board: "14 messages from
 * automation «X»"): one row with the newest title; expanding lists them.
 */
export function NotificationGroup({ items, onOpen, onMarkRead }: GroupProps) {
  const { t, i18n } = useTranslation('notifications');
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const format = useFormatters();
  const newest = items[0] as NotificationDto;
  const unread = items.filter((item) => item.read_at === null).map((item) => item.id);
  const name = newest.entity.type === 'automation' ? newest.entity.title : null;
  const formatted = new Intl.NumberFormat(i18n.language).format(items.length);
  return (
    <li data-testid={`notification-group-${newest.id}`} data-unread={unread.length > 0}>
      <div className="flex gap-2.5 border-t border-line px-4 py-3">
        <IconTile kind="group" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            className={cn(
              'inline-flex items-start gap-1 text-left text-body text-fg hover:underline',
              unread.length > 0 && 'font-semibold',
            )}
            onClick={() => {
              setExpanded((value) => !value);
            }}
          >
            <span className="min-w-0 break-words">
              {name === null
                ? t('group.titleUnnamed', { count: items.length, formatted })
                : t('group.title', { count: items.length, formatted, name })}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'mt-0.5 size-4 shrink-0 transition-transform',
                expanded && 'rotate-180',
              )}
            />
          </button>
          <span className="truncate text-label font-normal text-fg-muted">
            {t('group.latest', { title: dataString(newest, 'title') ?? '' })}
          </span>
          <span className="flex flex-wrap gap-x-1.5 text-label font-normal text-fg-muted">
            {newest.base === null ? null : (
              <span className="after:ml-1.5 after:content-['·']">{newest.base.name}</span>
            )}
            <time dateTime={newest.created_at} title={format.dateTime(newest.created_at)}>
              {format.relative(newest.created_at)}
            </time>
          </span>
        </div>
        {unread.length === 0 ? (
          <span aria-hidden="true" className="w-8 shrink-0" />
        ) : (
          <Tooltip content={t('group.markRead')}>
            <button
              type="button"
              aria-label={t('group.markRead')}
              className="-my-1 flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-sunken max-lg:size-control"
              onClick={() => {
                onMarkRead(unread as [NotificationId, ...NotificationId[]]);
              }}
            >
              <span className="size-2 rounded-full bg-accent" />
            </button>
          </Tooltip>
        )}
      </div>
      {expanded ? (
        <ul id={listId} className="list-none">
          {items.map((item) => (
            <NotificationItem
              key={item.id}
              item={item}
              nested
              onOpen={onOpen}
              onMarkRead={onMarkRead}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
