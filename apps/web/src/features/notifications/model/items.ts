import type { EmailFrequency, NotificationDto, NotificationType } from '@cellhive/contracts';

/**
 * Pure model of the notification panel (T524, FRONTEND §14): where an item
 * opens, whether the caller lost access to what it is about, and the
 * grouping of bursts of automation messages.
 */

const enc = encodeURIComponent;

/*
 * Copies of two small catalogues of CONTRACTS §22 (a test keeps them equal to
 * `MANDATORY_NOTIFICATION_TYPES` and `EMAIL_FREQUENCIES`): importing values of
 * the contract's notification module into these lazy chunks moves the whole
 * module out of the app shell's realtime chunk into a chunk of its own, which
 * costs the shell ~300 B gzip (T524 budget: +2 KB).
 */
/** Types that cannot be turned off in-app and ignore base mutes ("Always sent"). */
export const MANDATORY_TYPES: readonly NotificationType[] = [
  'automation.disabled',
  'approval.task_assigned',
];
/** Email frequencies in the order of the settings page. */
export const EMAIL_FREQUENCY_OPTIONS = [
  'immediate',
  'daily',
  'off',
] as const satisfies readonly EmailFrequency[];

/**
 * What the item looks like (icon, tone): one per type, `import.finished`
 * by status (T552). Chosen by the renderer of each type (`model/types/*`).
 */
export type ItemKind =
  | 'message'
  | 'disabled'
  | 'overflow'
  | 'assigned'
  | 'followed'
  | 'reminder'
  | 'importSucceeded'
  | 'importFailed'
  | 'importCancelled'
  | 'other';

/**
 * Where the item opens, or `null` without a link (CONTRACTS §22.3: a `null`
 * title means the caller cannot read the entity any more; no base, no
 * link). Automations open their builder (T521); a job (`import.finished`,
 * T552) opens the table it was about, when there is one.
 */
export function linkOf(
  notification: Pick<NotificationDto, 'base' | 'table_id' | 'entity'>,
): string | null {
  const { base, entity } = notification;
  // Jobs never have a title (CONTRACTS §22.3); everything else without one is out of reach.
  if (base === null || (entity.title === null && entity.type !== 'job')) return null;
  const root = `/b/${enc(base.id)}`;
  switch (entity.type) {
    case 'record':
      return notification.table_id === null
        ? null
        : `${root}/t/${enc(notification.table_id)}?record=${enc(entity.id)}`;
    case 'automation':
      return `${root}/automations/${enc(entity.id)}`;
    case 'table':
      return `${root}/t/${enc(entity.id)}`;
    case 'base':
      return root;
    case 'job':
      return notification.table_id === null ? null : `${root}/t/${enc(notification.table_id)}`;
    default:
      return null;
  }
}

/**
 * The caller lost access to what the item is about: shown with a lock and
 * "No longer allowed to view …", without a link (BACKLOG T524). `job`
 * entities have no title by design (CONTRACTS §22.3): only a base the
 * caller cannot open any more counts.
 */
export function lostAccess(notification: Pick<NotificationDto, 'base' | 'entity'>): boolean {
  if (notification.entity.type === 'job') return notification.base === null;
  return notification.entity.title === null || notification.base === null;
}

/** The type cannot be turned off in-app (CONTRACTS §22.1): "Always sent". */
export function isMandatory(notification: Pick<NotificationDto, 'type'>): boolean {
  return MANDATORY_TYPES.includes(notification.type);
}

/** A string field of `data` (stored parameters, CONTRACTS §22.1), else `null`. */
export function dataString(
  notification: Pick<NotificationDto, 'data'>,
  key: string,
): string | null {
  const value = notification.data[key];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Grouping

/** At least this many messages of one automation in a row form a group. */
export const GROUP_MIN = 3;
/** …all within this window of the newest one. */
export const GROUP_WINDOW_MS = 60 * 60_000;

export type PanelRow =
  | { readonly kind: 'item'; readonly item: NotificationDto }
  | {
      readonly kind: 'group';
      /** Stable: the newest item's id. */
      readonly key: string;
      readonly automationId: string;
      /** Newest first, as listed. */
      readonly items: readonly NotificationDto[];
    };

function automationOf(notification: NotificationDto): string | null {
  return notification.type === 'automation.message'
    ? dataString(notification, 'automation_id')
    : null;
}

/**
 * Rows of the panel: a run of {@link GROUP_MIN}+ consecutive
 * `automation.message` items of the same automation within
 * {@link GROUP_WINDOW_MS} of the newest becomes one expandable group
 * ("14 messages from automation «X»", board "S5 · Notification center");
 * everything else stays one row per notification, in the server's order.
 */
export function groupRows(items: readonly NotificationDto[]): PanelRow[] {
  const rows: PanelRow[] = [];
  let index = 0;
  while (index < items.length) {
    const first = items[index] as NotificationDto;
    const automationId = automationOf(first);
    let end = index + 1;
    if (automationId !== null) {
      const newest = Date.parse(first.created_at);
      while (end < items.length) {
        const next = items[end] as NotificationDto;
        if (automationOf(next) !== automationId) break;
        if (newest - Date.parse(next.created_at) > GROUP_WINDOW_MS) break;
        end += 1;
      }
    }
    if (automationId !== null && end - index >= GROUP_MIN) {
      rows.push({
        kind: 'group',
        key: first.id,
        automationId,
        items: items.slice(index, end),
      });
    } else {
      for (let at = index; at < end; at += 1) {
        rows.push({ kind: 'item', item: items[at] as NotificationDto });
      }
    }
    index = end;
  }
  return rows;
}

/** Bases the list mentions, by first appearance (the panel's base filter). */
export function basesOf(
  items: readonly { readonly base: { readonly id: string; readonly name: string } | null }[],
): { readonly id: string; readonly name: string }[] {
  const seen = new Map<string, string>();
  for (const { base } of items) {
    if (base !== null && !seen.has(base.id)) seen.set(base.id, base.name);
  }
  return [...seen].map(([baseId, name]) => ({ id: baseId, name }));
}
