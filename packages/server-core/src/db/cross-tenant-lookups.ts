import {
  AI_USAGE_RETENTION_DAYS,
  API_TOKEN_RETENTION_DAYS,
  DASHBOARD_TRASH_RETENTION_DAYS,
  INCOMING_WEBHOOK_REQUEST_RETENTION_DAYS,
} from '@cellhive/contracts';
import { sql } from 'kysely';

import { FINAL_JOB_STATUSES } from '../jobs/jobs.repository.js';
import { EMAIL_ASSET_REFERENCED } from '../mail/images/email-assets.repository.js';

import { IDEMPOTENCY_KEY_TTL_HOURS } from './repositories/idempotency-keys.repository.js';

import type { Db, DbExecutor, Tx } from './create-db.js';
import type { PartitionedTable } from './partitions.js';
import type { JsonValue, OrgRole } from './schema.js';
import type { Id, NotificationBufferKind } from '@cellhive/contracts';

/**
 * Every intentional cross-tenant query of the server (AGENTS.md rule 5,
 * SPEC §14.1 "Tra cứu vượt tenant được phép"). Tenant tables are otherwise
 * read and written only through `TenantRepository` subclasses scoped by an
 * `OrgScope`, and `GlobalRepository` subclasses touch only the global
 * tables of SPEC §5.10.
 *
 * Rules for this module:
 * - it is the only place allowed to query a tenant table without an
 *   organization filter; adding a function here is a reviewed decision (a
 *   unit test lists the exports);
 * - each function states why it cannot be scoped, what it may return, and
 *   who may call it; none returns another organization's data to a caller
 *   that is not entitled to it;
 * - request handlers use only the lookups keyed by the caller's own
 *   identity or by a secret the caller holds (invitation token).
 */

/** An organization the user belongs to, with the user's role in it. */
export interface UserMembership {
  readonly organizationId: Id<'org'>;
  readonly name: string;
  readonly slug: string;
  readonly settings: JsonValue;
  readonly role: OrgRole;
  readonly joinedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Every organization `userId` belongs to, oldest membership first.
 *
 * Why: organizations hang off users (a global table), so "which tenants can
 * this user act in" is the entry point of every access check. Allowed uses:
 * - the caller's own memberships (`AccessService`, `GET /me`, `GET /orgs`);
 * - for another user, only to enforce rules that span organizations without
 *   disclosing them: the fan-out of a user's own audit entries (login,
 *   logout, password reset) to each of their organizations, and the admin
 *   password reset rule "the target belongs to this organization only and
 *   owns none" (SPEC §14.2). Callers must never return the list itself to
 *   someone else.
 */
export async function listMembershipsOfUser(
  executor: DbExecutor | Tx,
  userId: Id<'usr'>,
): Promise<UserMembership[]> {
  const rows = await executor
    .selectFrom('meta.org_members as m')
    .innerJoin('meta.organizations as o', 'o.id', 'm.organization_id')
    .select([
      'o.id as organization_id',
      'o.name',
      'o.slug',
      'o.settings',
      'm.role',
      'm.created_at as joined_at',
      'o.created_at',
      'o.updated_at',
    ])
    .where('m.user_id', '=', userId)
    .orderBy('m.created_at')
    .orderBy('o.id')
    .execute();
  return rows.map((row) => ({
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    settings: row.settings,
    role: row.role,
    joinedAt: row.joined_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * The organization an invitation token belongs to, or `undefined`.
 *
 * Why: `GET /invitations/:token` and `POST /invitations/:token/accept`
 * start from nothing but the token (SPEC §14.1A). Keyed by the SHA-256 of a
 * 32-byte secret, so only its holder can hit a row. Returns the
 * organization id only; every other read then goes through
 * `InvitationsRepository` with that organization's scope.
 */
export async function findInvitationOrganization(
  executor: DbExecutor | Tx,
  tokenHash: string,
): Promise<Id<'org'> | undefined> {
  const row = await executor
    .selectFrom('meta.invitations')
    .select('organization_id')
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  return row?.organization_id;
}

/**
 * The organization a share link token belongs to, or `undefined`.
 *
 * Why: `/shares/{token}/*` (SPEC §15A.3, BACKLOG T305) start from nothing
 * but the token. Keyed by the SHA-256 of a 32-byte secret, so only its
 * holder can hit a row. Returns the organization id only; every other read
 * then goes through `ShareLinksRepository` with that organization's scope.
 */
export async function findShareLinkOrganization(
  executor: DbExecutor | Tx,
  tokenHash: string,
): Promise<Id<'org'> | undefined> {
  const row = await executor
    .selectFrom('meta.share_links')
    .select('organization_id')
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  return row?.organization_id;
}

/** What the public route of an incoming webhook learns from a token hash. */
export interface IncomingWebhookTokenMatch {
  readonly organization_id: Id<'org'>;
  readonly incoming_webhook_id: Id<'hok'>;
}

/**
 * The organization and id of the incoming webhook whose URL token hashes to
 * `tokenHash`, or `undefined` (BACKLOG T602, ADR-35 §1).
 *
 * Why: `POST /api/v1/hooks/:token` (T603) starts from nothing but the URL
 * token. Keyed by the SHA-256 of a 32-byte secret (`UNIQUE (token_hash)`),
 * so only its holder can hit a row. Returns the two ids only — deleted and
 * disabled hooks included, so every "not usable" case answers the same
 * `404` after the scoped read; every other read goes through
 * `IncomingWebhooksRepository` with that organization's scope.
 */
export async function findIncomingWebhookByTokenHash(
  executor: DbExecutor | Tx,
  tokenHash: string,
): Promise<IncomingWebhookTokenMatch | undefined> {
  const row = await executor
    .selectFrom('meta.incoming_webhooks')
    .select(['organization_id', 'id'])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { organization_id: row.organization_id, incoming_webhook_id: row.id };
}

/** What a Bearer request learns from the hash of its API token. */
export interface ApiTokenHashMatch {
  readonly organization_id: Id<'org'>;
  readonly id: Id<'tok'>;
}

/**
 * The organization and id of the API token whose SHA-256 is `tokenHash`, or
 * `undefined` (BACKLOG T703/T704, ADR-36 §1).
 *
 * Why: a request with `Authorization: Bearer cht_…` starts from nothing but
 * the token. Keyed by the SHA-256 of a token of ≥ 178 random bits
 * (`UNIQUE (token_hash)`), so only its holder can hit a row. Returns the two
 * ids only — revoked and expired tokens included, so the guard tells them
 * apart after reading the token in that organization's scope through
 * `ApiTokensRepository`.
 */
export async function findApiTokenByHash(
  executor: DbExecutor | Tx,
  tokenHash: Buffer,
): Promise<ApiTokenHashMatch | undefined> {
  return executor
    .selectFrom('meta.api_tokens')
    .select(['organization_id', 'id'])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
}

/**
 * Locks a user row and every organization membership of that user
 * (`FOR UPDATE`), for the admin-issued password reset redeem check.
 *
 * Why: redeeming a link created by an organization admin must re-check,
 * under lock, that the target still belongs to that organization only and
 * owns none (SPEC §14.2). The rows are read only to decide, never returned
 * to another user.
 */
export async function lockUserMemberships(
  tx: Tx,
  userId: Id<'usr'>,
): Promise<{ organizationId: Id<'org'>; role: OrgRole }[]> {
  await tx.selectFrom('meta.users').select('id').where('id', '=', userId).forUpdate().execute();
  const rows = await tx
    .selectFrom('meta.org_members')
    .select(['organization_id', 'role'])
    .where('user_id', '=', userId)
    .orderBy('organization_id')
    .forUpdate()
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, role: row.role }));
}

/** Finished `meta.jobs` rows are kept this long (BACKLOG T108). */
export const FINISHED_JOB_RETENTION_DAYS = 30;
/** Rows deleted per statement, so a large backlog never holds long locks. */
export const MAINTENANCE_DELETE_BATCH = 5_000;

export interface MaintenanceCleanupResult {
  readonly idempotencyKeys: number;
  readonly jobs: number;
  /** `meta.automation_batch_counters` rows older than 24 hours (ADR-26 §4, T503). */
  readonly automationBatchCounters: number;
  /** `meta.incoming_webhook_requests` rows older than 7 days (ADR-35 §1, T602). */
  readonly incomingWebhookRequests: number;
  /** `meta.http_deliveries` of kind `test` older than 24 hours (T605, CONTRACTS §25.5). */
  readonly httpTestDeliveries: number;
  /** `meta.api_tokens` revoked or expired more than 90 days ago (T703, CONTRACTS §26.6). */
  readonly apiTokens: number;
  /** `meta.dashboards` in the trash for more than 30 days, widgets included (T805, CONTRACTS §28.1). */
  readonly dashboards: number;
  /** `meta.ai_usage_daily` rows of days more than 400 days ago (T906, CONTRACTS §29.1). */
  readonly aiUsageDays: number;
}

/** Runs `deleteBatch` until it deletes fewer than `batchSize` rows. */
async function deleteInBatches(
  deleteBatch: () => Promise<number>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteBatch();
    total += deleted;
    if (deleted < batchSize) return total;
  }
}

/**
 * Purges idempotency keys older than 24 hours (CONTRACTS §1.1), jobs
 * that finished more than 30 days ago, automation fan-out counters
 * older than 24 hours (ADR-26 §4; a batch id is never reused), raw
 * incoming webhook requests older than 7 days (ADR-35 §1, CONTRACTS §25.6;
 * a run reading a purged request fails with `trigger_data_expired`) and
 * "send a test" HTTP deliveries older than 24 hours (T605; action
 * deliveries follow their run), API tokens revoked or expired more than
 * 90 days ago (T703), dashboards in the trash for more than 30 days
 * (T805; their widgets go by cascade) and AI usage days older than 400 days
 * (T906), in every organization.
 *
 * Why: retention is the same for every tenant and runs from the worker's
 * `maintenance.cleanup` cron, never from a request; it deletes by age only
 * and returns counts, no data. Each batch is its own statement
 * (autocommit).
 */
export async function purgeExpiredOperationalRows(
  db: Db,
  options: { readonly now: Date; readonly batchSize?: number },
): Promise<MaintenanceCleanupResult> {
  const batchSize = options.batchSize ?? MAINTENANCE_DELETE_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  const keyCutoff = new Date(options.now.getTime() - IDEMPOTENCY_KEY_TTL_HOURS * 3_600_000);
  const jobCutoff = new Date(options.now.getTime() - FINISHED_JOB_RETENTION_DAYS * 86_400_000);

  const idempotencyKeys = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.idempotency_keys
       WHERE (principal_key, key) IN (
         SELECT principal_key, key FROM meta.idempotency_keys
          WHERE created_at < ${keyCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  const jobs = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.jobs
       WHERE id IN (
         SELECT id FROM meta.jobs
          WHERE finished_at < ${jobCutoff}
            AND status = ANY (${sql.val([...FINAL_JOB_STATUSES])}::text[])
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  const automationBatchCounters = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.automation_batch_counters
       WHERE (automation_id, batch_id) IN (
         SELECT automation_id, batch_id FROM meta.automation_batch_counters
          WHERE created_at < ${keyCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  const requestCutoff = new Date(
    options.now.getTime() - INCOMING_WEBHOOK_REQUEST_RETENTION_DAYS * 86_400_000,
  );
  const incomingWebhookRequests = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.incoming_webhook_requests
       WHERE id IN (
         SELECT id FROM meta.incoming_webhook_requests
          WHERE received_at < ${requestCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  // T605: `test` deliveries are kept 24 hours (CONTRACTS §25.6).
  const httpTestDeliveries = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.http_deliveries
       WHERE id IN (
         SELECT id FROM meta.http_deliveries
          WHERE kind = 'test' AND created_at < ${keyCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  // T703: a token that stopped working (revoked or expired, whichever came
  // first) is kept 90 days for listings and audit, then deleted.
  const tokenCutoff = new Date(options.now.getTime() - API_TOKEN_RETENTION_DAYS * 86_400_000);
  const apiTokens = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.api_tokens
       WHERE id IN (
         SELECT id FROM meta.api_tokens
          WHERE LEAST(revoked_at, expires_at) < ${tokenCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  // T805: the base trash keeps a dashboard 30 days (like tables), widgets by cascade.
  const dashboardCutoff = new Date(
    options.now.getTime() - DASHBOARD_TRASH_RETENTION_DAYS * 86_400_000,
  );
  const dashboards = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.dashboards
       WHERE id IN (
         SELECT id FROM meta.dashboards
          WHERE deleted_at < ${dashboardCutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  // T906: the AI usage ledger keeps 400 days (a day of the organization's zone; UTC is close enough).
  const usageCutoff = new Date(options.now.getTime() - AI_USAGE_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const aiUsageDays = await deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.ai_usage_daily
       WHERE (organization_id, day, feature) IN (
         SELECT organization_id, day, feature FROM meta.ai_usage_daily
          WHERE day < ${usageCutoff}::date
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);

  return {
    idempotencyKeys,
    jobs,
    automationBatchCounters,
    incomingWebhookRequests,
    httpTestDeliveries,
    apiTokens,
    dashboards,
    aiUsageDays,
  };
}

/**
 * Deletes notifications (and their queued deliveries, by cascade) created
 * more than `retentionDays` before `now`, in every organization; returns
 * how many.
 *
 * Why: `NOTIFICATION_RETENTION_DAYS` (ADR-29 §1) is instance-wide and runs
 * from the worker's `notifications.cleanup` cron only, never a request; it
 * deletes by age only and returns a count, no data. Each batch is its own
 * statement (autocommit).
 */
export async function purgeExpiredNotifications(
  db: Db,
  options: { readonly now: Date; readonly retentionDays: number; readonly batchSize?: number },
): Promise<number> {
  const batchSize = options.batchSize ?? MAINTENANCE_DELETE_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
    throw new RangeError('retentionDays must be a positive integer');
  }
  const cutoff = new Date(options.now.getTime() - options.retentionDays * 86_400_000);
  return deleteInBatches(async () => {
    const { numAffectedRows } = await sql`
      DELETE FROM meta.notifications
       WHERE id IN (
         SELECT id FROM meta.notifications
          WHERE created_at < ${cutoff}
          LIMIT ${batchSize})
    `.execute(db.kysely);
    return Number(numAffectedRows ?? 0n);
  }, batchSize);
}

/** A recipient with notification emails waiting to be sent (ids only). */
export interface PendingEmailRecipient {
  readonly organizationId: Id<'org'>;
  readonly userId: Id<'usr'>;
}

/**
 * Recipients (organization, user) that have at least one `pending` email
 * delivery of a notification, in (organization, user) order after `after`,
 * at most `limit`.
 *
 * Why: the hourly `notifications.daily_digest` cron (T512) finds whose
 * daily summary is due — the hour is the recipient's, in their own time
 * zone, so which organizations hold such recipients is only known by
 * looking at every organization's queue. Called by that cron only, never a
 * request. Returns ids only; settings, time zones and the emails are then
 * read inside each organization's scope.
 */
export async function listPendingEmailRecipients(
  executor: DbExecutor,
  options: { readonly after: PendingEmailRecipient | null; readonly limit: number },
): Promise<PendingEmailRecipient[]> {
  const after =
    options.after === null
      ? sql``
      : sql`AND (d.organization_id, n.user_id) > (${options.after.organizationId}, ${options.after.userId})`;
  const { rows } = await sql<{ organization_id: Id<'org'>; user_id: Id<'usr'> }>`
    SELECT DISTINCT d.organization_id, n.user_id
      FROM meta.notification_deliveries AS d
      JOIN meta.notifications AS n
        ON n.organization_id = d.organization_id AND n.id = d.notification_id
     WHERE d.status = 'pending'
       AND d.channel = 'email'
       ${after}
     ORDER BY d.organization_id, n.user_id
     LIMIT ${options.limit}
  `.execute(executor);
  return rows.map((row) => ({ organizationId: row.organization_id, userId: row.user_id }));
}

/** A group of the notification buffer whose flush is overdue (ids and keys only). */
export interface StaleNotificationBuffer {
  readonly organizationId: Id<'org'>;
  readonly kind: NotificationBufferKind;
  readonly groupKey: string;
}

/**
 * Groups of `meta.notification_buffer` holding a row appended before
 * `before`, in (organization, kind, group key) order after `after`, at most
 * `limit` (index `notification_buffer_created_at_idx`).
 *
 * Why: a group's `notifications.flush` job runs seconds after its first row
 * (ADR-34 §2); a row still there 10 minutes later lost its job (removed,
 * failed for good), and only a sweep over every organization finds it. Called
 * by the `notifications.cleanup` cron only, never a request (BACKLOG T542).
 * Returns the organization id and the group's kind and key only — the
 * group's key is a `batch.id` or a record id of that organization, never a
 * value; the rows are then locked and read in the organization's scope by
 * the flush.
 */
export async function listStaleNotificationBuffers(
  executor: DbExecutor,
  options: {
    readonly before: Date;
    readonly after: StaleNotificationBuffer | null;
    readonly limit: number;
  },
): Promise<StaleNotificationBuffer[]> {
  const after =
    options.after === null
      ? sql``
      : sql`AND (organization_id, kind, group_key) >
                (${options.after.organizationId}, ${options.after.kind}, ${options.after.groupKey})`;
  const { rows } = await sql<{
    organization_id: Id<'org'>;
    kind: NotificationBufferKind;
    group_key: string;
  }>`
    SELECT DISTINCT organization_id, kind, group_key
      FROM meta.notification_buffer
     WHERE created_at < ${options.before}
       ${after}
     ORDER BY organization_id, kind, group_key
     LIMIT ${options.limit}
  `.execute(executor);
  return rows.map((row) => ({
    organizationId: row.organization_id,
    kind: row.kind,
    groupKey: row.group_key,
  }));
}

/** A notification bot with pending personal links (ids only). */
export interface PendingTelegramLinkBot {
  readonly organizationId: Id<'org'>;
  readonly secretId: Id<'sec'>;
}

/**
 * Bots (organization, secret) with at least one pending personal link — a
 * `meta.user_channel_link_tokens` row not used and not expired at `now` —
 * in (organization, secret) order after `after`, at most `limit` (partial
 * index `user_channel_link_tokens_pending_idx`).
 *
 * Why: Telegram only tells a bot about `/start <token>` when someone asks
 * (`getUpdates`); the per-minute `notifications.telegram_poll` cron (BACKLOG
 * T549, ADR-34 §3) must find which bots of which organizations wait for one,
 * which is only known by looking at all of them. Called by that cron only,
 * never a request. Returns the organization id and the secret id only —
 * never a token hash or a user; the poll job then checks, in the
 * organization's scope, that the secret is still its notification bot.
 */
export async function listOrganizationsWithPendingTelegramLinks(
  executor: DbExecutor,
  options: {
    readonly now: Date;
    readonly after: PendingTelegramLinkBot | null;
    readonly limit: number;
  },
): Promise<PendingTelegramLinkBot[]> {
  const after =
    options.after === null
      ? sql``
      : sql`AND (organization_id, secret_id) >
                (${options.after.organizationId}, ${options.after.secretId})`;
  const { rows } = await sql<{ organization_id: Id<'org'>; secret_id: Id<'sec'> }>`
    SELECT DISTINCT organization_id, secret_id
      FROM meta.user_channel_link_tokens
     WHERE used_at IS NULL
       AND expires_at > ${options.now}
       ${after}
     ORDER BY organization_id, secret_id
     LIMIT ${options.limit}
  `.execute(executor);
  return rows.map((row) => ({ organizationId: row.organization_id, secretId: row.secret_id }));
}

/** What the Telegram webhook route learns from a path token hash (T609). */
export interface TelegramWebhookPathMatch {
  readonly organization_id: Id<'org'>;
}

/**
 * The organization whose notification bot's webhook URL carries the path
 * token hashing to `pathTokenHash`, or `undefined` (BACKLOG T609, ADR-35 §7).
 *
 * Why: `POST /api/v1/telegram/webhook/:pathToken` is called by Telegram with
 * nothing but the path token (and the secret header, checked after). Keyed
 * by the SHA-256 of a 24-byte secret (`UNIQUE (path_token_hash)`), so only
 * its holder can hit a row. Returns the organization id only; every other
 * read goes through `TelegramWebhooksRepository` in that organization's
 * scope.
 */
export async function findTelegramWebhookByPathHash(
  executor: DbExecutor | Tx,
  pathTokenHash: string,
): Promise<TelegramWebhookPathMatch | undefined> {
  const row = await executor
    .selectFrom('meta.telegram_webhooks')
    .select('organization_id')
    .where('path_token_hash', '=', pathTokenHash)
    .executeTakeFirst();
  return row === undefined ? undefined : { organization_id: row.organization_id };
}

/**
 * Notification bots (organization, secret) in `polling` mode with at least
 * one `linked` Telegram channel through that very bot, in (organization,
 * secret) order after `after`, at most `limit` (BACKLOG T609, QA S5b M4).
 *
 * Why: the long poll only runs while links wait; the 15-minute sparse poll
 * (`notifications.telegram_sparse_poll` cron) must find every bot whose
 * members could send `/stop`, which is only known by looking at all
 * organizations. Called by that cron only, never a request. Returns the two
 * ids only; the poll job checks again, in the organization's scope, that
 * the secret is still its notification bot in `polling` mode.
 */
export async function listTelegramBotsForSparsePoll(
  executor: DbExecutor,
  options: {
    readonly after: { readonly organizationId: Id<'org'>; readonly secretId: Id<'sec'> } | null;
    readonly limit: number;
  },
): Promise<PendingTelegramLinkBot[]> {
  const after =
    options.after === null
      ? sql``
      : sql`AND (c.organization_id, c.secret_id) >
                (${options.after.organizationId}, ${options.after.secretId})`;
  const { rows } = await sql<{ organization_id: Id<'org'>; secret_id: Id<'sec'> }>`
    SELECT DISTINCT c.organization_id, c.secret_id
      FROM meta.user_channels c
      JOIN meta.organizations o ON o.id = c.organization_id
     WHERE c.kind = 'telegram'
       AND c.status = 'linked'
       AND c.secret_id IS NOT NULL
       AND o.settings -> 'notifications' ->> 'telegram_bot_secret_id' = c.secret_id
       AND COALESCE(o.settings -> 'notifications' ->> 'telegram_delivery_mode', 'polling')
           <> 'webhook'
       ${after}
     ORDER BY c.organization_id, c.secret_id
     LIMIT ${options.limit}
  `.execute(executor);
  return rows.map((row) => ({ organizationId: row.organization_id, secretId: row.secret_id }));
}

/**
 * Organizations with a notification bot webhook (`meta.telegram_webhooks`),
 * in id order after `after`, at most `limit` (BACKLOG T609, ADR-35 §7).
 *
 * Why: the hourly `notifications.telegram_webhook_check` cron asks Telegram
 * (`getWebhookInfo`) about every registered webhook — a changed
 * `PUBLIC_URL` is re-registered, delivery errors shown to owners/admins.
 * Called by that cron only. Returns organization ids only; the check reads
 * the row in that organization's scope.
 */
export async function listTelegramWebhooksToCheck(
  executor: DbExecutor,
  options: { readonly after: Id<'org'> | null; readonly limit: number },
): Promise<Id<'org'>[]> {
  let query = executor
    .selectFrom('meta.telegram_webhooks')
    .select('organization_id')
    .orderBy('organization_id')
    .limit(options.limit);
  if (options.after !== null) query = query.where('organization_id', '>', options.after);
  const rows = await query.execute();
  return rows.map((row) => row.organization_id);
}

/** A `datetime` field whose date reminder is on (ids only). */
export interface DateReminderField {
  readonly organizationId: Id<'org'>;
  readonly fieldId: Id<'fld'>;
}

/**
 * Fields with a date reminder — a `meta.date_reminder_cursors` row, which
 * exists exactly while `options.reminder` is on — in (organization, field)
 * order after `after`, at most `limit` (primary key of the table).
 *
 * Why: reminders fire on time passing, not on a tenant's write, so which
 * fields of which organizations remind is only known by looking at all of
 * them (BACKLOG T547, ADR-34 §1). Called by the per-minute
 * `notifications.date_reminder_scan` cron only, never a request. Returns the
 * organization id and the field id only — never a date, a recipient or a
 * record; each field is then locked, read and scanned in its organization's
 * scope.
 */
export async function listDateReminderFields(
  executor: DbExecutor,
  options: { readonly after: DateReminderField | null; readonly limit: number },
): Promise<DateReminderField[]> {
  let query = executor
    .selectFrom('meta.date_reminder_cursors')
    .select(['organization_id', 'field_id'])
    .orderBy('organization_id')
    .orderBy('field_id')
    .limit(options.limit);
  const after = options.after;
  if (after !== null) {
    query = query.where((eb) =>
      eb.or([
        eb('organization_id', '>', after.organizationId),
        eb.and([
          eb('organization_id', '=', after.organizationId),
          eb('field_id', '>', after.fieldId),
        ]),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((row) => ({ organizationId: row.organization_id, fieldId: row.field_id }));
}

/** A finished export whose download link expired: its file can be deleted. */
export interface ExpiredExportFile {
  readonly organizationId: Id<'org'>;
  readonly jobId: Id<'job'>;
}

/**
 * Succeeded jobs of `type` (e.g. `audit.export`) whose `result.expires_at`
 * is at or before `now` and that still carry `result.download_url`, oldest
 * first, at most `limit`.
 *
 * Why: export files are deleted when their link expires, for every
 * organization, by the worker's `exports.cleanup` cron only (never a
 * request). Returns ids only; each file is then deleted and its job updated
 * through the organization's scope (`JobsRepository.clearDownload`).
 */
export async function listExpiredExportFiles(
  executor: DbExecutor,
  options: { readonly type: string; readonly now: Date; readonly limit: number },
): Promise<ExpiredExportFile[]> {
  const rows = await executor
    .selectFrom('meta.jobs')
    .select(['organization_id', 'id'])
    .where('type', '=', options.type)
    .where('status', '=', 'succeeded')
    .where(sql<boolean>`result ? 'download_url'`)
    .where(sql<boolean>`(result->>'expires_at')::timestamptz <= ${options.now}`)
    .orderBy('finished_at')
    .orderBy('id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, jobId: row.id }));
}

/** An import upload past its expiry: its file and row can be deleted. */
export interface ExpiredImportUpload {
  readonly organizationId: Id<'org'>;
  readonly id: Id<'imp'>;
}

/**
 * Import uploads (`meta.imports`) whose `expires_at` is at or before `now`
 * and whose import job, if any, is no longer queued or running, oldest
 * first, at most `limit`.
 *
 * Why: temporary uploads are deleted for every organization by the
 * worker's `imports.cleanup` cron only (never a request). Returns ids only;
 * each file and row is then deleted through the organization's scope.
 */
export async function listExpiredImportUploads(
  executor: DbExecutor,
  options: { readonly now: Date; readonly limit: number },
): Promise<ExpiredImportUpload[]> {
  const rows = await executor
    .selectFrom('meta.imports as i')
    .select(['i.organization_id', 'i.id'])
    .where('i.expires_at', '<=', options.now)
    .where((eb) =>
      eb.or([
        eb('i.job_id', 'is', null),
        eb.not(
          eb.exists(
            eb
              .selectFrom('meta.jobs as j')
              .select('j.id')
              .whereRef('j.id', '=', 'i.job_id')
              .whereRef('j.organization_id', '=', 'i.organization_id')
              .where('j.status', 'in', ['queued', 'running']),
          ),
        ),
      ]),
    )
    .orderBy('i.expires_at')
    .orderBy('i.id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, id: row.id }));
}

/** A finished field conversion past its 7 days: its old column can be dropped. */
export interface ExpiredFieldConversion {
  readonly organizationId: Id<'org'>;
  readonly jobId: Id<'job'>;
}

/**
 * Field type conversions (`meta.field_conversions`, T403) that succeeded
 * and whose revert window ended at or before `now`,
 * oldest first, at most `limit`.
 *
 * Why: the old columns (`f_x__old_<ms>`) are dropped for every organization
 * by the worker's `field.conversion_cleanup` cron only (never a request).
 * Returns ids only; each column is then dropped through `SchemaService`
 * with the organization's scope.
 */
export async function listExpiredFieldConversions(
  executor: DbExecutor,
  options: { readonly now: Date; readonly limit: number },
): Promise<ExpiredFieldConversion[]> {
  const rows = await executor
    .selectFrom('meta.field_conversions')
    .select(['organization_id', 'job_id'])
    .where('status', '=', 'succeeded')
    .where('expires_at', '<=', options.now)
    .orderBy('expires_at')
    .orderBy('job_id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, jobId: row.job_id }));
}

/** A table in the trash past its 30 days (T461). */
export interface ExpiredTrashedTable {
  readonly organizationId: Id<'org'>;
  readonly tableId: Id<'tbl'>;
}

/**
 * Tables (`meta.tables`) in the trash since before `before` and not purged
 * yet, after the (`organizationId`, `tableId`) cursor `after` in that order,
 * at most `limit`.
 *
 * Why: tables trashed more than 30 days ago are purged for every
 * organization by the worker's daily `tables.purge` cron only (never a
 * request), which starts one job per organization (tenant-fair, ADR-18).
 * Returns ids only; each table is then re-checked and purged through
 * `SchemaService` with the organization's scope.
 */
export async function listExpiredTrashedTables(
  executor: DbExecutor,
  options: {
    readonly before: Date;
    readonly after: ExpiredTrashedTable | null;
    readonly limit: number;
  },
): Promise<ExpiredTrashedTable[]> {
  let query = executor
    .selectFrom('meta.tables')
    .select(['organization_id', 'id'])
    .where('deleted_at', '<', options.before)
    .where('purged_at', 'is', null)
    .orderBy('organization_id')
    .orderBy('id')
    .limit(options.limit);
  const after = options.after;
  if (after !== null) {
    query = query.where((eb) =>
      eb.or([
        eb('organization_id', '>', after.organizationId),
        eb.and([eb('organization_id', '=', after.organizationId), eb('id', '>', after.tableId)]),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((row) => ({ organizationId: row.organization_id, tableId: row.id }));
}

/**
 * Organizations having at least one table (trash included, purged tables
 * excluded), after `after` in id order, at most `limit`.
 *
 * Why: the daily `records.purge` cron (T408) starts one purge job per
 * organization (tenant-fair, ADR-18) for records trashed more than 30 days
 * ago; which tables hold such records is only known inside each
 * organization's scope. Returns organization ids only.
 */
export async function listOrganizationsWithTables(
  executor: DbExecutor,
  options: { readonly after: Id<'org'> | null; readonly limit: number },
): Promise<Id<'org'>[]> {
  let query = executor
    .selectFrom('meta.tables')
    .select('organization_id')
    .where('purged_at', 'is', null)
    .distinct()
    .orderBy('organization_id')
    .limit(options.limit);
  if (options.after !== null) query = query.where('organization_id', '>', options.after);
  const rows = await query.execute();
  return rows.map((row) => row.organization_id);
}

/**
 * Organizations having at least one finished automation run (`succeeded`,
 * `failed`, `skipped`, `cancelled`) created before `before`, after `after`
 * in id order, at most `limit`.
 *
 * Why: `AUTOMATION_RUN_RETENTION_DAYS` (BACKLOG T518) is instance-wide and
 * runs from the worker's `automation.runs_cleanup` cron only, never a
 * request; which organizations hold such runs is only known by looking at
 * all of them. Returns organization ids only; the runs are then deleted in
 * batches through each organization's scope
 * (`AutomationRunsRepository.deleteFinishedBefore`).
 */
export async function listOrganizationsWithExpiredAutomationRuns(
  executor: DbExecutor,
  options: { readonly before: Date; readonly after: Id<'org'> | null; readonly limit: number },
): Promise<Id<'org'>[]> {
  let query = executor
    .selectFrom('meta.automation_runs')
    .select('organization_id')
    .where('created_at', '<', options.before)
    .where('status', 'in', ['succeeded', 'failed', 'skipped', 'cancelled'])
    .distinct()
    .orderBy('organization_id')
    .limit(options.limit);
  if (options.after !== null) query = query.where('organization_id', '>', options.after);
  const rows = await query.execute();
  return rows.map((row) => row.organization_id);
}

/** An attachment row the cleanup may delete (with its object once unreferenced). */
export interface ExpiredAttachment {
  readonly organizationId: Id<'org'>;
  readonly id: Id<'att'>;
}

/**
 * Attachments (`meta.attachments`, T406) that are no longer needed, oldest
 * first, at most `limit`: uploads never written to a cell and created
 * before `unattachedBefore` (any status), files detached from their cell
 * before `detachedBefore`, files of a permanently deleted record (T408)
 * and files of a purged field (the field and its column are gone for good).
 *
 * Why: orphaned files are deleted for every organization by the worker's
 * `attachments.cleanup` cron only (never a request). Returns ids only; each
 * row (and its object, when no other row shares it) is then deleted
 * through the organization's scope.
 */
export async function listExpiredAttachments(
  executor: DbExecutor,
  options: {
    readonly unattachedBefore: Date;
    readonly detachedBefore: Date;
    readonly limit: number;
  },
): Promise<ExpiredAttachment[]> {
  const rows = await executor
    .selectFrom('meta.attachments as a')
    .select(['a.organization_id', 'a.id'])
    .where((eb) =>
      eb.or([
        eb.and([eb('a.record_id', 'is', null), eb('a.created_at', '<', options.unattachedBefore)]),
        eb('a.detached_at', '<', options.detachedBefore),
        eb('a.record_purged_at', 'is not', null),
        eb.exists(
          eb
            .selectFrom('meta.fields as f')
            .select('f.id')
            .whereRef('f.id', '=', 'a.field_id')
            .whereRef('f.organization_id', '=', 'a.organization_id')
            .where('f.purged_at', 'is not', null),
        ),
      ]),
    )
    .orderBy('a.created_at')
    .orderBy('a.id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, id: row.id }));
}

/** A cover image the cleanup may delete (row and object). */
export interface ExpiredFormCover {
  readonly organizationId: Id<'org'>;
  readonly id: Id<'att'>;
}

/**
 * Form covers (`meta.form_covers`, T419) uploaded before `createdBefore`
 * that no form view of their organization names as its cover (never used,
 * replaced, removed, or their view deleted), oldest first, at most `limit`.
 *
 * Why: unused covers are deleted for every organization by the worker's
 * `attachments.cleanup` cron only (never a request). Returns ids only; each
 * row (and its object) is then deleted through the organization's scope,
 * re-checked under a lock.
 */
export async function listExpiredFormCovers(
  executor: DbExecutor,
  options: { readonly createdBefore: Date; readonly limit: number },
): Promise<ExpiredFormCover[]> {
  const rows = await executor
    .selectFrom('meta.form_covers as c')
    .select(['c.organization_id', 'c.id'])
    .where('c.created_at', '<', options.createdBefore)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('meta.views as v')
            .select('v.id')
            .whereRef('v.organization_id', '=', 'c.organization_id')
            .where('v.type', '=', 'form')
            .where(sql<string>`v.config -> 'form' ->> 'cover_attachment_id'`, '=', eb.ref('c.id')),
        ),
      ),
    )
    .orderBy('c.created_at')
    .orderBy('c.id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, id: row.id }));
}

/** An email image the cleanup may delete (row and object). */
export interface ExpiredEmailAsset {
  readonly organizationId: Id<'org'>;
  readonly id: Id<'att'>;
}

/**
 * Email assets (`meta.email_assets`, T534) uploaded before `createdBefore`
 * that nothing of their organization references any more
 * (`EMAIL_ASSET_REFERENCED`: never inserted, removed from the signature or
 * the automation body, upload not finished), oldest first, at most `limit`.
 *
 * Why: unused email images are deleted for every organization by the
 * worker's `attachments.cleanup` cron only (never a request). Returns ids
 * only; each row (and its object) is then deleted through the
 * organization's scope, re-checked under a lock.
 */
export async function listExpiredEmailAssets(
  executor: DbExecutor,
  options: { readonly createdBefore: Date; readonly limit: number },
): Promise<ExpiredEmailAsset[]> {
  const rows = await executor
    .selectFrom('meta.email_assets as a')
    .select(['a.organization_id', 'a.id'])
    .where('a.created_at', '<', options.createdBefore)
    .where(sql<boolean>`NOT ${EMAIL_ASSET_REFERENCED}`)
    .orderBy('a.created_at')
    .orderBy('a.id')
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ organizationId: row.organization_id, id: row.id }));
}

/**
 * Creates the monthly partition of `table` for `month` (`YYYY-MM-DD`) if
 * missing; returns its name.
 *
 * Why: `meta.events` / `meta.audit_logs` are partitioned by month for every
 * tenant at once; the worker's `partitions.maintain` cron (DDL through
 * `meta.create_monthly_partition`) only, never a request.
 */
export async function createMonthlyPartition(
  db: DbExecutor,
  table: PartitionedTable,
  month: string,
): Promise<string> {
  const { rows } = await sql<{ name: string }>`
    SELECT meta.create_monthly_partition(${table}, ${month}::date) AS name
  `.execute(db);
  const name = rows[0]?.name;
  if (name === undefined) throw new Error('meta.create_monthly_partition returned no row');
  return name;
}

export interface PartitionDropResult {
  readonly partition: string;
  /** `false`: kept because it still holds events not dispatched yet. */
  readonly dropped: boolean;
}

/**
 * Drops the partitions of `table` whose whole month ends at or before
 * `cutoff`.
 *
 * Why: retention (`AUDIT_RETENTION_DAYS`, events) is instance-wide; the
 * worker's `partitions.maintain` cron only. Returns partition names, no
 * rows.
 */
export async function dropMonthlyPartitionsBefore(
  db: DbExecutor,
  table: PartitionedTable,
  cutoff: Date,
): Promise<PartitionDropResult[]> {
  const { rows } = await sql<{ partition_name: string; dropped: boolean }>`
    SELECT partition_name, dropped
      FROM meta.drop_monthly_partitions_before(${table}, ${cutoff.toISOString()}::timestamptz)
  `.execute(db);
  return rows.map((row) => ({ partition: row.partition_name, dropped: row.dropped }));
}

/** An enabled automation with a time trigger (ids only). */
export interface TimeTriggerAutomation {
  readonly organizationId: Id<'org'>;
  readonly automationId: Id<'aut'>;
}

/**
 * Enabled, not deleted automations whose trigger is `type` (`schedule` or
 * `record.date_reached`), in (organization, automation) order after
 * `after`, at most `limit` (index `automations_time_trigger_idx`).
 *
 * Why: the per-minute `automation.schedule_tick` / `automation.date_scan`
 * crons (BACKLOG T508, SPEC §11.2) fire on time passing, not on a tenant's
 * write, so which organizations have such automations is only known by
 * looking at all of them. Called by those crons only, never a request.
 * Returns ids only; each automation is then locked, read and run through
 * the organization's scope.
 */
export async function listTimeTriggerAutomations(
  executor: DbExecutor,
  options: {
    readonly type: 'schedule' | 'record.date_reached';
    readonly after: TimeTriggerAutomation | null;
    readonly limit: number;
  },
): Promise<TimeTriggerAutomation[]> {
  let query = executor
    .selectFrom('meta.automations')
    .select(['organization_id', 'id'])
    .where('enabled', '=', true)
    .where('deleted_at', 'is', null)
    .where('trigger_type', 'in', ['schedule', 'record.date_reached'])
    .where('trigger_type', '=', options.type)
    .orderBy('organization_id')
    .orderBy('id')
    .limit(options.limit);
  const after = options.after;
  if (after !== null) {
    query = query.where((eb) =>
      eb.or([
        eb('organization_id', '>', after.organizationId),
        eb.and([
          eb('organization_id', '=', after.organizationId),
          eb('id', '>', after.automationId),
        ]),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((row) => ({ organizationId: row.organization_id, automationId: row.id }));
}

/** Deliveries still to make, instance-wide (T605). */
export interface HttpDeliveryBacklog {
  /** Rows `pending` or `sending`. */
  readonly pending: number;
  /** Age of the oldest of them (from `created_at`), `0` when none. */
  readonly oldestPendingSeconds: number;
}

/**
 * Size and age of the outbound HTTP backlog in every organization — the
 * gauge `http_delivery_oldest_pending_seconds` (SPEC §19: alert above
 * 600 s).
 *
 * Why: the metric is instance-wide by nature and labels never carry a
 * tenant (SPEC §19); it is read only when `/metrics` is scraped, through
 * the partial index of rows still to deliver. Returns two numbers, no
 * data.
 */
export async function measureHttpDeliveryBacklog(
  db: Db,
  options: { readonly now: Date },
): Promise<HttpDeliveryBacklog> {
  const { rows } = await sql<{ pending: string; oldest: Date | null }>`
    SELECT count(*)::text AS pending, min(created_at) AS oldest
      FROM meta.http_deliveries
     WHERE status IN ('pending', 'sending')
  `.execute(db.kysely);
  const row = rows[0];
  const oldest = row?.oldest ?? null;
  return {
    pending: Number(row?.pending ?? 0),
    oldestPendingSeconds:
      oldest === null ? 0 : Math.max(0, (options.now.getTime() - oldest.getTime()) / 1000),
  };
}

/** A `pending` delivery this long past `next_attempt_at` lost its job (T702). */
const STUCK_PENDING_AFTER_MS = 60_000;
/** A `sending` delivery this long past `lease_until` lost its safety job too (T702). */
const STUCK_LEASE_AFTER_MS = 30_000;

/** A delivery whose job seems lost (ids only, T702). */
export interface StuckHttpDelivery {
  readonly organization_id: Id<'org'>;
  readonly id: Id<'hdl'>;
}

/**
 * Deliveries that should have moved by `now` but did not: `pending` more
 * than 60 s past `next_attempt_at`, or `sending` more than 30 s past
 * `lease_until` (their worker died and the safety job is gone too), with no
 * live `http.deliver` job (locked, or waiting with attempts left), oldest
 * due first, at most `limit`.
 *
 * Why: the per-minute cron `http.deliveries_rescue` (BACKLOG T702, ADR-36
 * §5) finds deliveries whose `http.deliver` job was lost; a lost job is not
 * a tenant's write, so which organizations have one is only known by
 * looking at all of them. Called by that cron only, never a request.
 * Returns ids only; each delivery is then re-read and re-queued in its
 * organization's scope (`rescueHttpDelivery`).
 *
 * Uses the partial index `http_deliveries_due_idx (next_attempt_at) WHERE
 * status IN ('pending', 'sending')`: a `sending` row keeps the
 * `next_attempt_at` it was leased at, never later than the lease start, so
 * `next_attempt_at < now − 30 s` bounds the index scan for both kinds.
 */
export async function listStuckHttpDeliveries(
  executor: DbExecutor | Tx,
  options: { readonly now: Date; readonly limit: number },
): Promise<StuckHttpDelivery[]> {
  const now = options.now.getTime();
  const pendingBefore = new Date(now - STUCK_PENDING_AFTER_MS);
  const leaseBefore = new Date(now - STUCK_LEASE_AFTER_MS);
  return (
    executor
      .selectFrom('meta.http_deliveries as d')
      .select(['d.organization_id', 'd.id'])
      .where('d.status', 'in', ['pending', 'sending'])
      .where('d.next_attempt_at', '<', leaseBefore)
      .where((eb) =>
        eb.or([
          eb.and([eb('d.status', '=', 'pending'), eb('d.next_attempt_at', '<', pendingBefore)]),
          eb.and([eb('d.status', '=', 'sending'), eb('d.lease_until', '<', leaseBefore)]),
        ]),
      )
      // Rows whose job is only waiting (a backlog) are not lost: leaving them out keeps
      // them from filling every page. The key is `httpDeliverJobKey` (`http:<id>`), one
      // row of the unique key index of graphile-worker's public `jobs` view.
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM graphile_worker.jobs j
           WHERE j.key = ${'http:'} || d.id
             AND (j.locked_at IS NOT NULL OR j.attempts < j.max_attempts))`,
      )
      .orderBy('d.next_attempt_at')
      .orderBy('d.id')
      .limit(options.limit)
      .execute()
  );
}
