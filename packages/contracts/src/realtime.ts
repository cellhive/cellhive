import { z } from 'zod';

import { aiFieldStateSchema } from './ai-fields.js';
import { errorCodeSchema, problemErrorItemSchema } from './errors.js';
import { idOf, isId, type Id } from './ids.js';
import { JOB_STATUSES } from './jobs.js';
import { notificationTypeSchema } from './notifications.js';
import { recordMetaSchema } from './record-meta.js';
import { userChannelKindSchema } from './user-channels.js';

/**
 * Realtime protocol on the WebSocket `/ws` (CONTRACTS §7, SPEC §15). Every
 * frame is one JSON text message. These schemas are not HTTP routes, so they
 * do not appear in OpenAPI; CONTRACTS §7 is their documentation.
 */

/** Path of the WebSocket endpoint, next to the HTTP API on the same port. */
export const REALTIME_PATH = '/ws';

/** Largest client → server message, in bytes; a larger frame closes the connection (1009). */
export const REALTIME_MAX_MESSAGE_BYTES = 16 * 1024;

/** WebSocket close codes used by the server (CONTRACTS §7). */
export const REALTIME_CLOSE_CODES = {
  /** The server is shutting down; reconnect with backoff. */
  goingAway: 1001,
  /** Too many invalid messages or too many messages in flight. */
  policyViolation: 1008,
  /** A message larger than `REALTIME_MAX_MESSAGE_BYTES`. */
  messageTooBig: 1009,
  /**
   * The session ended (logout, expiry, revocation): sign in again. On a
   * connection opened with an API token (CONTRACTS §26.5): the token was
   * revoked or expired, the organization turned tokens off, or its user left.
   */
  unauthenticated: 4401,
} as const;

/** Kinds of channel a client can subscribe to (`dashboard:{id}` since S7, T807). */
export const REALTIME_CHANNEL_KINDS = ['base', 'table', 'user', 'dashboard'] as const;
export type RealtimeChannelKind = (typeof REALTIME_CHANNEL_KINDS)[number];

const CHANNEL_ID_PREFIX = { base: 'bse', table: 'tbl', user: 'usr', dashboard: 'dsh' } as const;

export type RealtimeChannel =
  | { readonly kind: 'base'; readonly id: Id<'bse'> }
  | { readonly kind: 'table'; readonly id: Id<'tbl'> }
  | { readonly kind: 'user'; readonly id: Id<'usr'> }
  | { readonly kind: 'dashboard'; readonly id: Id<'dsh'> };

/** Longest channel name: `dashboard:` plus an ID. */
const MAX_CHANNEL_LENGTH = 64;

/** `base:bse_…`, `table:tbl_…`, `user:usr_…` or `dashboard:dsh_…`; `undefined` for anything else. */
export function parseRealtimeChannel(value: string): RealtimeChannel | undefined {
  if (value.length > MAX_CHANNEL_LENGTH) return undefined;
  const index = value.indexOf(':');
  if (index < 0) return undefined;
  const kind = value.slice(0, index);
  const id = value.slice(index + 1);
  switch (kind) {
    case 'base':
      return isId(CHANNEL_ID_PREFIX.base, id) ? { kind, id } : undefined;
    case 'table':
      return isId(CHANNEL_ID_PREFIX.table, id) ? { kind, id } : undefined;
    case 'user':
      return isId(CHANNEL_ID_PREFIX.user, id) ? { kind, id } : undefined;
    case 'dashboard':
      return isId(CHANNEL_ID_PREFIX.dashboard, id) ? { kind, id } : undefined;
    default:
      return undefined;
  }
}

export function baseChannel(id: Id<'bse'>): `base:${Id<'bse'>}` {
  return `base:${id}`;
}

export function tableChannel(id: Id<'tbl'>): `table:${Id<'tbl'>}` {
  return `table:${id}`;
}

export function userChannel(id: Id<'usr'>): `user:${Id<'usr'>}` {
  return `user:${id}`;
}

export function dashboardChannel(id: Id<'dsh'>): `dashboard:${Id<'dsh'>}` {
  return `dashboard:${id}`;
}

export const realtimeChannelSchema = z
  .string()
  .max(MAX_CHANNEL_LENGTH)
  .refine((value) => parseRealtimeChannel(value) !== undefined, {
    message: 'Expected base:<bse_…>, table:<tbl_…>, user:<usr_…> or dashboard:<dsh_…>',
  })
  .meta({ description: 'Realtime channel, e.g. `table:tbl_…`' });

/** Client-chosen correlation ID echoed in the reply. */
export const realtimeRequestIdSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// Client → server

/** How the view filter of a `table:` subscription is applied (CONTRACTS §7, T313). */
export const REALTIME_VIEW_FILTER_MODES = ['and', 'replace'] as const;
export type RealtimeViewFilterMode = (typeof REALTIME_VIEW_FILTER_MODES)[number];

/**
 * The view open on screen for a `table:` subscription (T313, ADR-0031):
 * record messages then follow the view's saved filter (conditions hidden
 * from the subscriber included) on top of the read rule. `filter_mode:
 * replace` mirrors `records/query` (CONTRACTS §1.4): the client shows a
 * temporary filter instead of the part of the view filter it sees, so only
 * the hidden part is applied by the server.
 */
export const realtimeSubscribeViewSchema = z.strictObject({
  id: idOf('viw'),
  filter_mode: z.enum(REALTIME_VIEW_FILTER_MODES).optional(),
});
export type RealtimeSubscribeView = z.infer<typeof realtimeSubscribeViewSchema>;

export const realtimeSubscribeSchema = z.strictObject({
  type: z.literal('subscribe'),
  channel: realtimeChannelSchema,
  req_id: realtimeRequestIdSchema,
  /** Only on `table:` channels (else `VALIDATION_FAILED` / `NOT_ALLOWED`, path `view`). */
  view: realtimeSubscribeViewSchema.optional(),
});

export const realtimeUnsubscribeSchema = z.strictObject({
  type: z.literal('unsubscribe'),
  channel: realtimeChannelSchema,
  req_id: realtimeRequestIdSchema.optional(),
});

export const realtimePingSchema = z.strictObject({
  type: z.literal('ping'),
  req_id: realtimeRequestIdSchema.optional(),
});

export const realtimeClientMessageSchema = z.discriminatedUnion('type', [
  realtimeSubscribeSchema,
  realtimeUnsubscribeSchema,
  realtimePingSchema,
]);
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;

/**
 * Parses one text frame from a client. `req_id` is recovered from invalid
 * messages when it is a valid string, so the error can be correlated.
 */
export function parseRealtimeClientMessage(
  text: string,
):
  | { readonly ok: true; readonly message: RealtimeClientMessage }
  | { readonly ok: false; readonly reqId: string | null; readonly errors: RealtimeErrorItem[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reqId: null,
      errors: [{ path: '', code: 'MALFORMED_JSON', message: 'The message is not valid JSON.' }],
    };
  }
  const parsed = realtimeClientMessageSchema.safeParse(json);
  if (parsed.success) {
    const message = parsed.data;
    if (
      message.type === 'subscribe' &&
      message.view !== undefined &&
      !message.channel.startsWith('table:')
    ) {
      return {
        ok: false,
        reqId: message.req_id,
        errors: [
          { path: 'view', code: 'NOT_ALLOWED', message: 'A view applies to table: channels only.' },
        ],
      };
    }
    return { ok: true, message };
  }
  const reqId =
    typeof json === 'object' && json !== null && 'req_id' in json
      ? realtimeRequestIdSchema.safeParse(json.req_id).data
      : undefined;
  return {
    ok: false,
    reqId: reqId ?? null,
    errors: parsed.error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code === 'invalid_union' ? 'UNKNOWN_TYPE' : issue.code.toUpperCase(),
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// Server → client

export type RealtimeErrorItem = z.infer<typeof problemErrorItemSchema>;

export const realtimeSubscribedSchema = z.strictObject({
  type: z.literal('subscribed'),
  req_id: realtimeRequestIdSchema,
  channel: realtimeChannelSchema,
});

/**
 * A refused request or a subscription the server removed. `req_id` is `null`
 * when the server acts on its own (access lost) or the request had none;
 * `channel` names the subscription concerned, when there is one.
 * `INSUFFICIENT_SCOPE` (T706, CONTRACTS §26.5): a connection opened with an
 * API token subscribed to a reachable `base:`/`table:` channel without
 * `records:read`; `errors[0].params.required = ["records:read"]`.
 */
export const realtimeErrorSchema = z.strictObject({
  type: z.literal('error'),
  req_id: realtimeRequestIdSchema.nullable(),
  code: errorCodeSchema,
  channel: realtimeChannelSchema.optional(),
  /**
   * `NOT_FOUND` about the view of a `table:` subscription (T313): the view
   * is gone or hidden from the subscriber; the table may still be readable.
   */
  view_id: idOf('viw').optional(),
  errors: z.array(problemErrorItemSchema).optional(),
});

export const realtimePongSchema = z.strictObject({
  type: z.literal('pong'),
  req_id: realtimeRequestIdSchema.optional(),
});

const fieldValuesSchema = z.record(idOf('fld'), z.unknown());

/**
 * Colors of the record after the change under the color rules of the
 * subscribed view that apply to the subscriber (T816, CONTRACTS §7): present
 * only when such rules exist; `color: {}` = none matches (clear).
 */
const recordMetaOfMessage = recordMetaSchema.optional();

export const realtimeRecordCreatedSchema = z.strictObject({
  type: z.literal('record.created'),
  channel: realtimeChannelSchema,
  record_id: idOf('rec'),
  version: z.int().min(1),
  fields: fieldValuesSchema,
  meta: recordMetaOfMessage,
  actor_id: z.string().nullable(),
  event_id: idOf('evt'),
});

/**
 * A patch of the fields the subscriber can read that changed. `event_id` is
 * `null` for values recomputed by the system (auto_number, formula/lookup
 * values — T459 —, link cells showing renamed records), which keep the
 * record's `version`: clients apply such a patch when `version` ≥ the one
 * they hold (CONTRACTS §7).
 */
export const realtimeRecordUpdatedSchema = z.strictObject({
  type: z.literal('record.updated'),
  channel: realtimeChannelSchema,
  record_id: idOf('rec'),
  version: z.int().min(1),
  fields: fieldValuesSchema,
  meta: recordMetaOfMessage,
  actor_id: z.string().nullable(),
  event_id: idOf('evt').nullable(),
});

export const realtimeRecordsDeletedSchema = z.strictObject({
  type: z.literal('record.deleted'),
  channel: realtimeChannelSchema,
  record_ids: z.array(idOf('rec')).min(1),
});

export const realtimeRecordsRestoredSchema = z.strictObject({
  type: z.literal('record.restored'),
  channel: realtimeChannelSchema,
  record_ids: z.array(idOf('rec')).min(1),
});

/**
 * Records permanently deleted from the trash (T408, CONTRACTS §7): sent to
 * subscribers who could read them, so open trash lists drop them.
 */
export const realtimeRecordsPurgedSchema = z.strictObject({
  type: z.literal('record.purged'),
  channel: realtimeChannelSchema,
  record_ids: z.array(idOf('rec')).min(1),
});

export const realtimeRecordAddedSchema = z.strictObject({
  type: z.literal('record.added'),
  channel: realtimeChannelSchema,
  record_id: idOf('rec'),
});

export const realtimeRecordRemovedFromViewSchema = z.strictObject({
  type: z.literal('record.removed_from_view'),
  channel: realtimeChannelSchema,
  record_id: idOf('rec'),
});

/**
 * Most per-record messages (`record.created|updated|added|removed_from_view|
 * deleted|restored`, one per record) one write sends a subscriber; above it
 * the subscriber gets one `record.batch` instead (T303, CONTRACTS §7).
 */
export const REALTIME_RECORD_BATCH_THRESHOLD = 100;

/** Kinds of per-record message a `record.batch` stands for. */
export const RECORD_BATCH_OPS = [
  'created',
  'updated',
  'added',
  'removed_from_view',
  'deleted',
  'restored',
] as const;
export type RecordBatchOp = (typeof RECORD_BATCH_OPS)[number];

const batchCountSchema = z.int().min(0);

/**
 * One write (bulk request, paste, import lot, job) changed more than
 * {@link REALTIME_RECORD_BATCH_THRESHOLD} records this subscriber can read
 * (before or after the write): one message replaces the per-record ones.
 * It carries no record id and no value; counts only include records the
 * subscriber can read. The client refetches what it shows (FRONTEND §5).
 */
export const realtimeRecordBatchSchema = z.strictObject({
  type: z.literal('record.batch'),
  channel: realtimeChannelSchema,
  actor_id: z.string().nullable(),
  /** Records the per-record messages would have named (sum of `ops`). */
  count: z.int().min(1),
  ops: z.strictObject({
    created: batchCountSchema,
    updated: batchCountSchema,
    added: batchCountSchema,
    removed_from_view: batchCountSchema,
    deleted: batchCountSchema,
    restored: batchCountSchema,
  }),
});
export type RealtimeRecordBatch = z.infer<typeof realtimeRecordBatchSchema>;

export const SCHEMA_CHANGE_ENTITIES = ['table', 'field', 'view'] as const;
/**
 * `converted` (T403): the type of a field changed and its values were
 * converted (end of the backfill job) or a conversion was reverted: clients
 * refetch the schema and the records they show.
 */
export const SCHEMA_CHANGE_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'restored',
  'converted',
] as const;

export const realtimeSchemaChangedSchema = z.strictObject({
  type: z.literal('schema.changed'),
  channel: realtimeChannelSchema,
  entity: z.enum(SCHEMA_CHANGE_ENTITIES),
  entity_id: z.string(),
  action: z.enum(SCHEMA_CHANGE_ACTIONS),
  /**
   * (T910) An AI field whose generation queue was paused or resumed as a
   * whole: its counts (never record ids). Absent on every other change.
   */
  ai_state: aiFieldStateSchema.optional(),
});

/** Statuses of a `computed.recomputing` message (T459). */
export const COMPUTED_RECOMPUTING_STATUSES = ['running', 'succeeded', 'failed'] as const;

/**
 * (T456/T459, CONTRACTS §7) Progress of the computation of a stored
 * formula/lookup field — the backfill of a new definition or the
 * incremental recompute job — for `table:` subscribers who see the field:
 * at the start (`progress` 0), after each batch, at the end (`succeeded`:
 * values are current; `failed`: the job will retry or the field shows its
 * error). Recomputed values themselves arrive as `record.updated`
 * (`event_id: null`) or `record.batch`.
 */
export const realtimeComputedRecomputingSchema = z.strictObject({
  type: z.literal('computed.recomputing'),
  channel: realtimeChannelSchema,
  field_id: idOf('fld'),
  progress: z.number().min(0).max(1),
  status: z.enum(COMPUTED_RECOMPUTING_STATUSES),
});

/** Statuses of a `field.converting` message (T403). */
export const FIELD_CONVERTING_STATUSES = ['running', 'succeeded', 'failed'] as const;

/**
 * (T403, BACKLOG S4 design decision #8) Progress of a field type conversion,
 * for everyone who has the base open and sees the field (`table:` and
 * `base:` channels): at the start (`progress` 0), after each batch, and at
 * the end (`succeeded`: the field has its new type, refetch; `failed`: the
 * field is unchanged). While `running` the field shows its old values,
 * read-only.
 */
export const realtimeFieldConvertingSchema = z.strictObject({
  type: z.literal('field.converting'),
  channel: realtimeChannelSchema,
  field_id: idOf('fld'),
  job_id: idOf('job'),
  status: z.enum(FIELD_CONVERTING_STATUSES),
  progress: z.number().min(0).max(1),
  from_type: z.string(),
  to_type: z.string(),
  /** Who started the conversion (`null`: the system). */
  actor_id: z.string().nullable(),
  /**
   * Link conversions (T404, ADR-28; the type stays `link`): `to_two_way`,
   * `to_one_way` or `to_single`. Sent for the converted field and for the
   * other side of the link (when it exists).
   */
  link_change: z.enum(['to_two_way', 'to_one_way', 'to_single']).optional(),
});

export const realtimePermissionChangedSchema = z.strictObject({
  type: z.literal('permission.changed'),
  channel: realtimeChannelSchema,
});

export const realtimeJobProgressSchema = z.strictObject({
  type: z.literal('job.progress'),
  channel: realtimeChannelSchema,
  job_id: idOf('job'),
  progress: z.number().min(0).max(1),
  status: z.enum(JOB_STATUSES),
});

/**
 * A new in-app notification for the subscriber (T511, CONTRACTS §7, §22),
 * on `user:<id>` only. Carries ids only: the client refetches the list or
 * the unread count of `organization_id` (`/orgs/:orgId/me/notifications`).
 */
export const realtimeNotificationCreatedSchema = z.strictObject({
  type: z.literal('notification.created'),
  channel: realtimeChannelSchema,
  notification_id: idOf('ntf'),
  organization_id: idOf('org'),
  notification_type: notificationTypeSchema,
  base_id: idOf('bse').nullable(),
});

/** Statuses a run ends in (`automation.run.finished`, T517). */
export const AUTOMATION_RUN_FINISHED_STATUSES = [
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

/**
 * A run started by the subscriber's button click ended (T517, ADR-32 §2,
 * CONTRACTS §7), on `user:<clicked_by>` only — nobody else learns about the
 * click. Ids and the status only: the grid refreshes the record, a run log
 * reader refetches.
 */
export const realtimeAutomationRunFinishedSchema = z.strictObject({
  type: z.literal('automation.run.finished'),
  channel: realtimeChannelSchema,
  run_id: idOf('run'),
  organization_id: idOf('org'),
  automation_id: idOf('aut'),
  table_id: idOf('tbl').nullable(),
  record_id: idOf('rec').nullable(),
  status: z.enum(AUTOMATION_RUN_FINISHED_STATUSES),
});

/** Statuses of `channel.changed`: `unlinked` = the channel is gone (unlinked, `/stop`). */
export const CHANNEL_CHANGED_STATUSES = ['linked', 'error', 'unlinked'] as const;

/**
 * A personal notification channel of the subscriber changed (T549,
 * CONTRACTS §7, §22.7), on `user:<id>` only: linked by `/start`, unlinked
 * (API, `/stop`) or put in `error` (bot changed). Kind and status only —
 * never a chat id or a Telegram name: the client refetches
 * `GET /orgs/:orgId/me/channels`.
 */
export const realtimeChannelChangedSchema = z.strictObject({
  type: z.literal('channel.changed'),
  channel: realtimeChannelSchema,
  organization_id: idOf('org'),
  kind: userChannelKindSchema,
  status: z.enum(CHANNEL_CHANGED_STATUSES),
});

/**
 * The first valid request of a "listen for a sample request" window was
 * captured (T603, CONTRACTS §7, §25.3), on `user:<id>` of the member who
 * started listening only. Ids only: the client reads
 * `GET /incoming-webhooks/:id/sample`.
 */
export const realtimeIncomingWebhookSampleCapturedSchema = z.strictObject({
  type: z.literal('incoming_webhook.sample_captured'),
  channel: realtimeChannelSchema,
  organization_id: idOf('org'),
  incoming_webhook_id: idOf('hok'),
});

/**
 * The configuration of a dashboard changed (T807, CONTRACTS §7, §28.5):
 * settings, layout or widgets — `version` is the dashboard's new version.
 * On `dashboard:<id>`; the client refetches `GET /dashboards/:id`.
 */
export const realtimeDashboardChangedSchema = z.strictObject({
  type: z.literal('dashboard.changed'),
  channel: realtimeChannelSchema,
  dashboard_id: idOf('dsh'),
  version: z.int().min(1),
});

/**
 * Records of tables the dashboard's widgets read changed (T807, CONTRACTS
 * §7, §28.5), gathered over 5 s per dashboard. A hint only: no value, no
 * number, no record id — each client refetches the widgets of `table_ids`
 * (only tables the subscriber sees) over HTTP with its own permissions.
 */
export const realtimeDashboardDataChangedSchema = z.strictObject({
  type: z.literal('dashboard.data_changed'),
  channel: realtimeChannelSchema,
  dashboard_id: idOf('dsh'),
  table_ids: z.array(idOf('tbl')).min(1),
});

export const realtimeServerMessageSchema = z.discriminatedUnion('type', [
  realtimeSubscribedSchema,
  realtimeErrorSchema,
  realtimePongSchema,
  realtimeRecordCreatedSchema,
  realtimeRecordUpdatedSchema,
  realtimeRecordsDeletedSchema,
  realtimeRecordsRestoredSchema,
  realtimeRecordsPurgedSchema,
  realtimeRecordAddedSchema,
  realtimeRecordRemovedFromViewSchema,
  realtimeRecordBatchSchema,
  realtimeSchemaChangedSchema,
  realtimeComputedRecomputingSchema,
  realtimePermissionChangedSchema,
  realtimeJobProgressSchema,
  realtimeFieldConvertingSchema,
  realtimeNotificationCreatedSchema,
  realtimeAutomationRunFinishedSchema,
  realtimeChannelChangedSchema,
  realtimeIncomingWebhookSampleCapturedSchema,
  realtimeDashboardChangedSchema,
  realtimeDashboardDataChangedSchema,
]);
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;
export type RealtimeServerMessageType = RealtimeServerMessage['type'];
