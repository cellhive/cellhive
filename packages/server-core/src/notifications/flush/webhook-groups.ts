import { isId, type Id } from '@cellhive/contracts';

/**
 * Buffer groups of the writes of an incoming webhook's runs (ADR-35 §6,
 * BACKLOG T608): a single `record.created|updated` with
 * `via.incoming_webhook_id` goes to the group of (hook, table) of its kind —
 * never to the single path (`record.assigned`) nor to the group of its record
 * (`record.followed_changed`) — and the group is flushed
 * `NOTIFICATION_WEBHOOK_WINDOW_MS` after its first row. Bulk writes of those
 * runs keep the S5b grouping (`batch.id`).
 */
const PREFIX = 'webhook:';

/** The buffer `group_key` of (hook, table): `webhook:<hok>:<tbl>`. */
export function webhookNotificationGroupKey(
  incomingWebhookId: Id<'hok'>,
  tableId: Id<'tbl'>,
): string {
  return `${PREFIX}${incomingWebhookId}:${tableId}`;
}

export interface WebhookNotificationGroup {
  readonly incomingWebhookId: Id<'hok'>;
  readonly tableId: Id<'tbl'>;
}

/**
 * The (hook, table) of a buffer `group_key`, or `null` for any other group (a
 * `batch.id`, a record id: neither starts with `webhook:`).
 */
export function parseWebhookNotificationGroupKey(
  groupKey: string,
): WebhookNotificationGroup | null {
  if (!groupKey.startsWith(PREFIX)) return null;
  const [hook, table, ...rest] = groupKey.slice(PREFIX.length).split(':');
  if (rest.length > 0 || hook === undefined || table === undefined) return null;
  if (!isId('hok', hook) || !isId('tbl', table)) return null;
  return { incomingWebhookId: hook, tableId: table };
}

/**
 * The notification `group_key` of one flush of a webhook group: the buffer
 * key and the id of the window's first buffer row. A re-run of the same
 * flush writes nothing twice; the next window (new rows) gets its own.
 */
export function webhookNotificationKey(groupKey: string, firstRowId: string): string {
  return `${groupKey}:${firstRowId}`;
}
