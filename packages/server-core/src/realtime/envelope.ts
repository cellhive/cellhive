import {
  aiFieldStateSchema,
  AUTOMATION_RUN_FINISHED_STATUSES,
  CHANNEL_CHANGED_STATUSES,
  idOf,
  JOB_STATUSES,
  notificationTypeSchema,
  SCHEMA_CHANGE_ACTIONS,
  SCHEMA_CHANGE_ENTITIES,
  userChannelKindSchema,
  type Id,
} from '@cellhive/contracts';
import { z } from 'zod';

/**
 * Messages on the realtime bus between processes (SPEC §15): api and worker
 * publish, every api instance receives and routes them to its local
 * WebSocket subscriptions. One Valkey pub/sub channel per organization.
 *
 * An envelope carries IDs and **stored-form** data only, never a value
 * filtered for (or formatted for) one person: each api instance decides per
 * subscriber what may be sent. Unknown `type`s are ignored by receivers, so
 * a newer publisher never breaks an older instance during a rolling deploy.
 */
export const REALTIME_ENVELOPE_VERSION = 1;

/** Valkey channel prefix of an organization's bus. */
export const REALTIME_BUS_PREFIX = 'rt:org:';

/** The Valkey pub/sub channel of an organization. */
export function orgBusChannel(organizationId: Id<'org'>): string {
  return `${REALTIME_BUS_PREFIX}${organizationId}`;
}

/** The organization of a bus channel, or `undefined` for anything else. */
export function orgOfBusChannel(channel: string): Id<'org'> | undefined {
  if (!channel.startsWith(REALTIME_BUS_PREFIX)) return undefined;
  const id = idOf('org').safeParse(channel.slice(REALTIME_BUS_PREFIX.length));
  return id.success ? id.data : undefined;
}

const common = {
  v: z.literal(REALTIME_ENVELOPE_VERSION),
  organization_id: idOf('org'),
};

/** A committed schema change (SchemaService), routed to `table:` (and `base:` for tables). */
export const schemaChangedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('schema.changed'),
  base_id: idOf('bse'),
  table_id: idOf('tbl'),
  entity: z.enum(SCHEMA_CHANGE_ENTITIES),
  entity_id: z.string().min(1).max(64),
  action: z.enum(SCHEMA_CHANGE_ACTIONS),
  /**
   * Views only: the owner of a personal view (only they receive the
   * message), `null` for a shared view (receivers must see it through
   * `visible_views`). Absent for tables and fields.
   */
  owner_id: idOf('usr').nullable().optional(),
  /** AI fields only (T910): queue counts after a pause or resume of the whole field. */
  ai_state: aiFieldStateSchema.optional(),
});

/**
 * `permission_version` of these bases changed (roles, assignments, groups,
 * memberships, ownership, tables/fields, trash): every instance re-checks
 * its subscriptions of the bases.
 */
export const permissionChangedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('permission.changed'),
  base_ids: z.array(idOf('bse')).min(1),
});

/** A user-visible job (`meta.jobs`) changed state or progress; sent to `user:<created_by>`. */
export const jobProgressEnvelopeSchema = z.object({
  ...common,
  type: z.literal('job.progress'),
  user_id: idOf('usr'),
  job_id: idOf('job'),
  progress: z.number().min(0).max(1),
  status: z.enum(JOB_STATUSES),
});

/**
 * A notification was recorded for `user_id` (T511, ADR-29 §1); sent to
 * `user:<user_id>` only. Ids only: the client refetches.
 */
export const notificationCreatedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('notification.created'),
  user_id: idOf('usr'),
  notification_id: idOf('ntf'),
  notification_type: notificationTypeSchema,
  base_id: idOf('bse').nullable(),
});

/**
 * Progress of a field type conversion (T403), routed to `table:` and
 * `base:` subscribers who see the field.
 */
export const fieldConvertingEnvelopeSchema = z.object({
  ...common,
  type: z.literal('field.converting'),
  base_id: idOf('bse'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
  job_id: idOf('job'),
  status: z.enum(['running', 'succeeded', 'failed']),
  progress: z.number().min(0).max(1),
  from_type: z.string().min(1).max(32),
  to_type: z.string().min(1).max(32),
  actor_id: idOf('usr').nullable(),
  /** Link conversions (T404): what changes (the type stays `link`). */
  link_change: z.enum(['to_two_way', 'to_one_way', 'to_single']).optional(),
});

/**
 * Progress of the computation of a stored formula/lookup field (T459,
 * CONTRACTS §7 `computed.recomputing`): the backfill of a new definition
 * (`computed.backfill`, T456) or the incremental recompute job
 * (`computed.recompute`, T458) — at the start, after each batch, at the end.
 * Routed to `table:` subscribers who see the field.
 */
export const computedRecomputingEnvelopeSchema = z.object({
  ...common,
  type: z.literal('computed.recomputing'),
  table_id: idOf('tbl'),
  field_id: idOf('fld'),
  progress: z.number().min(0).max(1),
  status: z.enum(['running', 'succeeded', 'failed']),
});

const tableFieldSchema = z.object({ table_id: idOf('tbl'), field_id: idOf('fld') });

/**
 * A formula/lookup field of a `record.changes` envelope (T459): its result
 * type (the filter meta of images, SPEC §6.2) and what it reads, so each api
 * instance decides per subscriber — like `RecordQueryService` (T457,
 * S4b open question #1) — whether the value is `locked` (a table or a field
 * of other records the subscriber cannot read; with `strict`, a same-record
 * field too) or computed differently for them (a record rule on a table it
 * reads: the stored value is not theirs).
 */
export const computedFieldMetaSchema = z.object({
  result_type: z.string().min(1).max(32).optional(),
  result_options: z.unknown().optional(),
  result_is_list: z.boolean().optional(),
  tables: z.array(idOf('tbl')),
  cross_fields: z.array(tableFieldSchema),
  same_row_fields: z.array(tableFieldSchema),
  /** `strict_computed_permissions` of the base when published. */
  strict: z.boolean(),
  /**
   * `true` for a formula/lookup computed on read (`compute_mode: virtual`, or
   * stored without its column yet, T462): named by a view filter, its meta
   * travels but images never carry its value — receivers cannot evaluate a
   * condition on it (subscribers of such a view get `record.batch`).
   */
  virtual: z.boolean().optional(),
});

/** Kinds of record change in a `record.changes` envelope. */
export const RECORD_CHANGE_OPS = ['created', 'updated', 'deleted', 'restored', 'purged'] as const;
export type RecordChangeOp = (typeof RECORD_CHANGE_OPS)[number];

const storedImageSchema = z.record(z.string(), z.unknown());

/**
 * One record change of a `record.changes` envelope (T210). `before`/`after`
 * are storage-form images of the fields named by any role's record rules
 * plus the changed fields (`null` on the side where the record does not
 * exist: before a create or a restore, after a delete); `values` are the
 * `cell_format=json` values a message may carry (every field of a created
 * record; the changed fields and `updated_at`/`updated_by` fields of an
 * updated one). `changed` lists the fields the write changed.
 */
export const recordChangeItemSchema = z.object({
  op: z.enum(RECORD_CHANGE_OPS),
  record_id: idOf('rec'),
  version: z.int().min(1),
  /** `null` for recomputed values (no `meta.events` row). */
  event_id: idOf('evt').nullable(),
  changed: z.array(idOf('fld')),
  before: storedImageSchema.nullable(),
  after: storedImageSchema.nullable(),
  values: z.record(z.string(), z.unknown()),
});

/**
 * Record changes of one table committed by one transaction (split into
 * several envelopes when large), routed to `table:<id>`. `fields` gives type
 * and raw options of every field present in the images, so each api
 * instance evaluates subscribers' read rules (`@cellhive/filter-dsl`)
 * without reading the database.
 */
export const recordChangesEnvelopeSchema = z.object({
  ...common,
  type: z.literal('record.changes'),
  base_id: idOf('bse'),
  table_id: idOf('tbl'),
  /** The user behind the change; `null` for the system and automations. */
  actor_id: idOf('usr').nullable(),
  fields: z.array(
    z.object({
      id: idOf('fld'),
      type: z.string(),
      options: z.unknown(),
      /** Formula/lookup fields (T459); absent for every other type. Older receivers strip it. */
      computed: computedFieldMetaSchema.optional(),
    }),
  ),
  /**
   * Link fields whose `values` the changes carry (T401): `[{ id, title }]`
   * with every title; receivers keep a title only for subscribers who read
   * `title_field_id` of the linked `table_id` without a record rule there,
   * and send `title: null` to the others (CONTRACTS §7, P20). Absent: none.
   */
  links: z
    .array(
      z.object({
        field_id: idOf('fld'),
        table_id: idOf('tbl'),
        title_field_id: idOf('fld').nullable(),
      }),
    )
    .optional(),
  changes: z.array(recordChangeItemSchema).min(1),
  /**
   * Link cells changed by another table (T402): each change is a
   * `record.updated` of a linking record (`event_id: null`, same version)
   * whose cell of `field_id` shows records that were renamed (primary
   * field) or entered/left the trash. `titles_only`: only titles changed,
   * so subscribers who may not see them get nothing; `values: false`: the
   * changes carry no values (too many records) and every group with
   * something to receive gets one `record.batch`. Older receivers ignore it.
   */
  link_fanout: z
    .object({
      field_id: idOf('fld'),
      titles_only: z.boolean(),
      values: z.boolean(),
    })
    .optional(),
  /**
   * Present when the table's changes of one transaction were split over
   * several envelopes (T303): they share `id` and are published in order
   * (`part` 0 … `parts - 1`), so receivers can decide per subscriber
   * whether the whole write is one `record.batch` message. Older receivers
   * ignore it and handle each envelope on its own.
   */
  batch: z
    .object({
      id: z.string().min(1).max(64),
      part: z.int().min(0),
      parts: z.int().min(2),
    })
    .refine((batch) => batch.part < batch.parts)
    .optional(),
});

/**
 * A run started by a button click ended (T517, ADR-32 §2): sent to
 * `user:<clicked_by>` only. Ids and the status only.
 */
export const automationRunFinishedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('automation.run.finished'),
  user_id: idOf('usr'),
  run_id: idOf('run'),
  automation_id: idOf('aut'),
  table_id: idOf('tbl').nullable(),
  record_id: idOf('rec').nullable(),
  status: z.enum(AUTOMATION_RUN_FINISHED_STATUSES),
});

/**
 * A personal notification channel of `user_id` changed (T549, CONTRACTS
 * §7, §22.7): sent to `user:<user_id>` only. Kind and status only — never a
 * chat id or a Telegram name.
 */
export const channelChangedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('channel.changed'),
  user_id: idOf('usr'),
  kind: userChannelKindSchema,
  status: z.enum(CHANNEL_CHANGED_STATUSES),
});

/**
 * A sample request of an incoming webhook was captured (T603, CONTRACTS §7,
 * §25.3): sent to `user:<user_id>` (the member who started listening) only.
 * Ids only.
 */
export const incomingWebhookSampleCapturedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('incoming_webhook.sample_captured'),
  user_id: idOf('usr'),
  incoming_webhook_id: idOf('hok'),
});

/**
 * API tokens stopped authenticating (T703, ADR-36 §1): `token_ids` were
 * revoked or deleted with their owner's membership; without `token_ids`,
 * the organization turned API tokens off. Receivers close the WebSocket
 * connections authenticated by them (T706). Ids only.
 */
export const apiTokenRevokedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('api_token.revoked'),
  token_ids: z.array(idOf('tok')).min(1).optional(),
});

/**
 * Cookie sessions of `user_id` ended (sign-out, sign-in replacing the
 * session, password reset): `session_ids` were deleted; without them, every
 * session of the user. Published on the bus of each organization the user
 * belongs to; receivers close the WebSocket connections opened with those
 * sessions at once (4401). Ids only.
 */
export const sessionRevokedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('session.revoked'),
  user_id: idOf('usr'),
  session_ids: z.array(idOf('ses')).min(1).max(100).optional(),
});

/**
 * A dashboard's configuration changed (T807, CONTRACTS §28.5): settings,
 * layout, widgets, trash. Routed to `dashboard:<id>`; receivers also reload
 * the tables the dashboard reads (for `dashboard.data_changed`) and
 * re-check its subscriptions (a dashboard in the trash is gone).
 */
export const dashboardChangedEnvelopeSchema = z.object({
  ...common,
  type: z.literal('dashboard.changed'),
  base_id: idOf('bse'),
  dashboard_id: idOf('dsh'),
  version: z.int().min(1),
});

export const realtimeEnvelopeSchema = z.discriminatedUnion('type', [
  schemaChangedEnvelopeSchema,
  permissionChangedEnvelopeSchema,
  jobProgressEnvelopeSchema,
  recordChangesEnvelopeSchema,
  fieldConvertingEnvelopeSchema,
  computedRecomputingEnvelopeSchema,
  notificationCreatedEnvelopeSchema,
  automationRunFinishedEnvelopeSchema,
  channelChangedEnvelopeSchema,
  incomingWebhookSampleCapturedEnvelopeSchema,
  apiTokenRevokedEnvelopeSchema,
  sessionRevokedEnvelopeSchema,
  dashboardChangedEnvelopeSchema,
]);

export type SchemaChangedEnvelope = z.infer<typeof schemaChangedEnvelopeSchema>;
export type PermissionChangedEnvelope = z.infer<typeof permissionChangedEnvelopeSchema>;
export type JobProgressEnvelope = z.infer<typeof jobProgressEnvelopeSchema>;
export type RecordChangesEnvelope = z.infer<typeof recordChangesEnvelopeSchema>;
export type FieldConvertingEnvelope = z.infer<typeof fieldConvertingEnvelopeSchema>;
export type ComputedRecomputingEnvelope = z.infer<typeof computedRecomputingEnvelopeSchema>;
export type NotificationCreatedEnvelope = z.infer<typeof notificationCreatedEnvelopeSchema>;
export type AutomationRunFinishedEnvelope = z.infer<typeof automationRunFinishedEnvelopeSchema>;
export type ChannelChangedEnvelope = z.infer<typeof channelChangedEnvelopeSchema>;
export type IncomingWebhookSampleCapturedEnvelope = z.infer<
  typeof incomingWebhookSampleCapturedEnvelopeSchema
>;
export type ApiTokenRevokedEnvelope = z.infer<typeof apiTokenRevokedEnvelopeSchema>;
export type SessionRevokedEnvelope = z.infer<typeof sessionRevokedEnvelopeSchema>;
export type DashboardChangedEnvelope = z.infer<typeof dashboardChangedEnvelopeSchema>;
export type ComputedFieldMeta = z.infer<typeof computedFieldMetaSchema>;
export type RecordChangeItem = z.infer<typeof recordChangeItemSchema>;
export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;
export type RealtimeEnvelopeType = RealtimeEnvelope['type'];

/**
 * Parses a bus message. `undefined` for malformed JSON, another version,
 * an unknown type, or an envelope of another organization than the channel
 * it arrived on.
 */
export function parseRealtimeEnvelope(
  message: string,
  organizationId: Id<'org'>,
): RealtimeEnvelope | undefined {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return undefined;
  }
  const parsed = realtimeEnvelopeSchema.safeParse(json);
  if (!parsed.success || parsed.data.organization_id !== organizationId) return undefined;
  return parsed.data;
}
