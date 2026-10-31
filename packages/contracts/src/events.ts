import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Closed catalogue of internal events (`meta.events.type`), CONTRACTS §8.
 * Every event is also written to the audit log. Adding a name means updating
 * CONTRACTS §8 in the same change.
 */
export const EVENT_TYPES = [
  // Record
  'record.created',
  'record.updated',
  'record.deleted',
  'record.restored',
  // Permanent delete from the trash (T408): one per purge and table, `entity_type = table`.
  'record.purged',
  // Schema
  'table.created',
  'table.updated',
  'table.deleted',
  'table.restored',
  // Permanent delete of a table from the trash (T461): one per table, `entity_type = table`.
  'table.purged',
  'field.created',
  'field.updated',
  'field.deleted',
  'field.restored',
  'field.converted',
  'view.created',
  'view.updated',
  'view.deleted',
  // Organization & people
  'org.created',
  'org.updated',
  'org_member.added',
  'org_member.role_changed',
  'org_member.removed',
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'group.created',
  'group.updated',
  'group.deleted',
  'group_member.added',
  'group_member.removed',
  'workspace.created',
  'workspace.updated',
  'workspace.deleted',
  'workspace_member.added',
  'workspace_member.role_changed',
  'workspace_member.removed',
  // Base & permissions
  'base.created',
  'base.updated',
  'base.deleted',
  'base.restored',
  'role.created',
  'role.updated',
  'role.deleted',
  'role_assignment.changed',
  'permission.changed',
  // Sharing & integrations
  'share_link.created',
  'share_link.updated',
  'share_link.revoked',
  'form.submitted',
  'webhook.received',
  'schedule.fired',
  'api_token.created',
  'api_token.revoked',
  'incoming_webhook.created',
  'incoming_webhook.updated',
  'incoming_webhook.deleted',
  // Automation, dashboard, AI
  'automation.created',
  'automation.updated',
  'automation.deleted',
  'automation.enabled',
  'automation.disabled',
  // ADR-25 §7 (T502): `before/after.run_as_user_id`, `after.reason`.
  'automation.run_as_changed',
  'automation.run.succeeded',
  'automation.run.failed',
  // A click on a button field (T517, ADR-32 §2): `entity_type = record`, `data =
  // { field_id, automation_id, run_id }`; the click's run is queued with it.
  'button.clicked',
  // Sender identities (T530, ADR-33 §5): never secrets, tokens or codes.
  'email_identity.created',
  'email_identity.verification_sent',
  'email_identity.verified',
  'email_identity.updated',
  'email_identity.credentials_changed',
  'email_identity.error',
  'email_identity.disabled',
  'email_identity.enabled',
  'email_identity.deleted',
  // Dashboards (T805, CONTRACTS §28): configuration only, never record values.
  'dashboard.created',
  'dashboard.updated',
  'dashboard.deleted',
  'dashboard.restored',
  'dashboard.duplicated',
  'dashboard.widget_created',
  'dashboard.widget_updated',
  'dashboard.widget_deleted',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Actions that are audited but never emitted as events (CONTRACTS §8, right column). */
export const AUDIT_ONLY_ACTIONS = [
  'schema.compacted',
  'setup.completed',
  'email.test_sent',
  // "Send a test to me" of `send_email` (T514): no content, no address.
  'automation.test_email_sent',
  // "Send a test" of `http_request` (T606): action, delivery id and host only.
  'automation.test_http_sent',
  'base.exported',
  'base.imported',
  'share_link.unlock_failed',
  'share_link.file_downloaded',
  'ai.requested',
  'ai_settings.updated',
  // Run log (T518): a person re-ran or cancelled a run (ids and statuses only).
  'automation.run.rerun',
  'automation.run.cancelled',
  'auth.login',
  'auth.logout',
  'auth.login_failed',
  'auth.password_reset_requested',
  'auth.password_reset',
  'auth.session_revoked',
  'export.created',
  // A tool of the MCP server read records (T921, CONTRACTS §30.3): tool and row count, never values.
  'mcp.records_read',
  'audit.viewed',
  'audit.exported',
  'audit.redacted',
  'secret.created',
  // Name, scope or value replaced (T516): never the value.
  'secret.updated',
  'secret.deleted',
  // Outbound HTTP allowlist entry added or removed (T600, CONTRACTS §25.4): pattern and note.
  'http_allowlist.created',
  'http_allowlist.deleted',
  // Incoming webhook credentials replaced (T602, CONTRACTS §25.1): never the secret or token.
  'incoming_webhook.secret_rotated',
  'incoming_webhook.token_regenerated',
  // Personal notification channel linked (`/start`) or removed (API, `/stop`) (T549): never the chat.
  'user_channel.linked',
  'user_channel.unlinked',
  // An API token renamed by its owner (T703, CONTRACTS §26.4): name only, never the token.
  'api_token.updated',
  // An account created by signing in with OIDC (T707, CONTRACTS §27.2): no password, no claim.
  'user.created',
  // OIDC identity connected or disconnected (T708, CONTRACTS §27.3): provider and method, no claim.
  'auth.identity_linked',
  'auth.identity_unlinked',
  // The caller changed their own password or profile (T831, CONTRACTS §12.0): never the password.
  'auth.password_changed',
  'user.updated',
] as const;

export type AuditOnlyAction = (typeof AUDIT_ONLY_ACTIONS)[number];

/** Every valid `meta.audit_logs.action`: all event types plus audit-only actions. */
export const AUDIT_ACTIONS = [...EVENT_TYPES, ...AUDIT_ONLY_ACTIONS] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `actor.type` of events and audit entries (CONTRACTS §8). `webhook`: the
 * `webhook.received` event of an incoming webhook (`id` = `hok_…`, T603,
 * ADR-35 §1) — events only, never an audit entry.
 */
export const ACTOR_TYPES = [
  'user',
  'api_token',
  'automation',
  'share_link',
  'system',
  'webhook',
] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export const eventTypeSchema = z.enum(EVENT_TYPES);
export const auditOnlyActionSchema = z.enum(AUDIT_ONLY_ACTIONS);
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export const actorTypeSchema = z.enum(ACTOR_TYPES);

const eventTypeSet: ReadonlySet<string> = new Set(EVENT_TYPES);
const auditActionSet: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && eventTypeSet.has(value);
}

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && auditActionSet.has(value);
}

/** Sanity bound of `batch.size` (record writes and job batches are far smaller). */
export const MAX_EVENT_BATCH_SIZE = 1_000_000;

/**
 * `batch` of a `record.*` event (ADR-26 §1, CONTRACTS §8): the request
 * (`req_…`), job (`job_…`) or automation run (`run_…`) that made the change,
 * and how many records that one call to the record service changed. Every
 * event of the call carries the same value; an event without `batch` is a
 * single change.
 */
export const eventBatchSchema = z
  .strictObject({
    id: z.union([idOf('req'), idOf('job'), idOf('run')]),
    size: z.int().min(1).max(MAX_EVENT_BATCH_SIZE),
  })
  .meta({ id: 'EventBatch' });
export type EventBatch = z.infer<typeof eventBatchSchema>;

/**
 * `via` of an event (CONTRACTS §8): the audit `via` (§11.1) — `{ automation_id,
 * run_id }`, `{ api_token_id }` (the actor user wrote through that token, T705 —
 * events always carry the id, only readers of history/audit get it hidden),
 * `{ share_link_id }`, `{ import_job_id }`,
 * `{ reverted_from }`, and `incoming_webhook_id` next to `{ automation_id, run_id }`
 * when the run was started by `webhook.received` (T604, ADR-35 §6) — plus, for a
 * `record.updated` written from recomputed
 * formula/lookup values (T509, ADR-26 §2), `computed_recompute: true` and
 * `job_id`: the `computed.recompute` run (`job_…`, always a bulk event), or
 * `null` when the write itself recomputed them (its `batch` and `causation`);
 * `ai_field_id` for a value written by the AI worker (T910, actor `system`).
 */
export const eventViaSchema = z
  .strictObject({
    automation_id: idOf('aut').optional(),
    run_id: idOf('run').optional(),
    api_token_id: idOf('tok').optional(),
    share_link_id: idOf('shl').optional(),
    import_job_id: idOf('job').optional(),
    reverted_from: idOf('aud').optional(),
    incoming_webhook_id: idOf('hok').optional(),
    computed_recompute: z.literal(true).optional(),
    job_id: idOf('job').nullable().optional(),
    ai_field_id: idOf('fld').optional(),
  })
  .meta({ id: 'EventVia' });
export type EventVia = z.infer<typeof eventViaSchema>;
