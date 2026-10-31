import { isIP } from 'node:net';

import { auditActionSchema, idOf, type AuditAction, type Id } from '@cellhive/contracts';
import { z } from 'zod';

import { actorSchema, type Actor } from '../events/event.js';

import type { JsonObject, JsonValue } from '../db/schema.js';

/**
 * Where a change came from besides the actor (ADR-23, CONTRACTS §11.1):
 * `{ automation_id, run_id }`, `{ api_token_id }` (`mcp: true` through the MCP
 * server), `{ share_link_id }`, `{ import_job_id }` or `{ reverted_from }`.
 */
export interface AuditVia {
  readonly automation_id?: Id<'aut'>;
  readonly run_id?: Id<'run'>;
  readonly api_token_id?: Id<'tok'>;
  readonly share_link_id?: Id<'shl'>;
  readonly import_job_id?: Id<'job'>;
  readonly reverted_from?: Id<'aud'>;
  /** With `{ automation_id, run_id }`: the run was started by this incoming webhook (T604). */
  readonly incoming_webhook_id?: Id<'hok'>;
  /** With `{ api_token_id }`: through the MCP server (T921, CONTRACTS §30.3). */
  readonly mcp?: true;
  /** A value written by the AI worker for this AI field (T910). */
  readonly ai_field_id?: Id<'fld'>;
}

/**
 * Request-level context of a mutation (SPEC §14.4). Built once by the
 * controller or job and passed to every service that writes audit entries
 * (`RecordMutationService` requires it).
 */
export interface AuditContext {
  readonly actor: Actor;
  readonly via: AuditVia | null;
  /**
   * Groups the entries of one bulk operation: the request (`req_…`), job
   * (`job_…`) or automation run (`run_…`, ADR-26 §1) id. Also the `batch.id`
   * of the `record.*` events of the change.
   */
  readonly batch_id: Id<'req'> | Id<'job'> | Id<'run'> | null;
  readonly request_id: Id<'req'> | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

/**
 * One audit log entry. `before`/`after` hold storage-form values of what
 * changed. **Never** put secrets in them: no passwords or hashes, tokens,
 * API keys, secret values or ciphertexts, reset/invitation links. Log that a
 * secret changed, not its value (keys that look like secrets are rejected).
 */
export interface AuditEntryInput {
  readonly action: AuditAction;
  /**
   * `null` only for `auth.*` actions before the organization is known and for
   * system actions (CLI); such entries are visible through the CLI/DB only
   * (CONTRACTS §8).
   */
  readonly organizationId: Id<'org'> | null;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: JsonObject | null;
  readonly after?: JsonObject | null;
  readonly context: AuditContext;
}

/** Longest `user_agent` stored; longer values are cut. */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * Object keys that must never appear in `before`/`after` (case-insensitive,
 * at any depth). Fields of user tables are keyed by `fld_…` ids, so this does
 * not reject record data.
 */
export const FORBIDDEN_AUDIT_KEYS: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'new_password',
  'token',
  'token_hash',
  'secret',
  'secret_enc',
  'client_secret',
  'ciphertext',
  'api_key',
  'private_key',
  'authorization',
  'cookie',
]);

const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const auditViaSchema = z
  .object({
    automation_id: idOf('aut').optional(),
    run_id: idOf('run').optional(),
    api_token_id: idOf('tok').optional(),
    share_link_id: idOf('shl').optional(),
    import_job_id: idOf('job').optional(),
    reverted_from: idOf('aud').optional(),
    incoming_webhook_id: idOf('hok').optional(),
    mcp: z.literal(true).optional(),
    ai_field_id: idOf('fld').optional(),
  })
  .strict()
  .refine((via) => Object.keys(via).length > 0, 'via must name at least one source');

export const auditContextSchema = z
  .object({
    actor: actorSchema,
    via: auditViaSchema.nullable(),
    batch_id: z.union([idOf('req'), idOf('job'), idOf('run')]).nullable(),
    request_id: idOf('req').nullable(),
    ip: z
      .string()
      .refine((value) => isIP(value) !== 0, 'must be an IPv4 or IPv6 address')
      .nullable(),
    user_agent: z.string().nullable(),
  })
  .strict();

/** A context for work started by the system itself (cron jobs, CLI). */
export function systemAuditContext(batchId: Id<'job'> | null = null): AuditContext {
  return {
    actor: { type: 'system', id: null },
    via: null,
    batch_id: batchId,
    request_id: null,
    ip: null,
    user_agent: null,
  };
}

/** Path of the first forbidden key in `value`, or `null`. */
export function findForbiddenAuditKey(value: JsonValue | undefined, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenAuditKey(item, `${path}[${String(index)}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const [key, item] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_AUDIT_KEYS.has(key.toLowerCase())) return here;
    const found = findForbiddenAuditKey(item, here);
    if (found !== null) return found;
  }
  return null;
}

/**
 * May an entry of this action/actor have `organization_id = NULL`? (CONTRACTS
 * §8): `auth.*`, `user.created` of an account created by an OIDC sign-in
 * that joined no organization (T707), and system actors.
 */
export function allowsNullOrganization(action: AuditAction, actor: Actor): boolean {
  return action.startsWith('auth.') || action === 'user.created' || actor.type === 'system';
}

/** Columns of `meta.audit_logs` for a validated entry (without id/created_at). */
export interface AuditRowValues {
  readonly organization_id: Id<'org'> | null;
  readonly base_id: Id<'bse'> | null;
  readonly table_id: Id<'tbl'> | null;
  readonly actor_type: Actor['type'];
  readonly actor_id: string | null;
  readonly via: AuditVia | null;
  readonly action: AuditAction;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly batch_id: string | null;
  readonly request_id: string | null;
  readonly before: JsonObject | null;
  readonly after: JsonObject | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

function fail(message: string): never {
  throw new TypeError(`Invalid audit entry: ${message}`);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined
    ? 'unknown error'
    : `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

/**
 * Validates an entry and builds its row. Problems are programming errors
 * (`TypeError`): unknown action (CONTRACTS §8 closed list), missing
 * organization outside `auth.*`/system, secret-looking keys, bad ids or IP.
 */
export function buildAuditRow(entry: AuditEntryInput): AuditRowValues {
  const action = auditActionSchema.safeParse(entry.action);
  if (!action.success) fail(`unknown action '${entry.action}'`);
  const context = auditContextSchema.safeParse(entry.context);
  if (!context.success) fail(`context.${firstIssue(context.error)}`);
  if (entry.organizationId === null) {
    if (!allowsNullOrganization(action.data, context.data.actor)) {
      fail('organizationId may be null only for auth.* actions or system actors');
    }
  } else if (!idOf('org').safeParse(entry.organizationId).success) {
    fail('organizationId is not an organization ID');
  }
  if (entry.baseId != null && !idOf('bse').safeParse(entry.baseId).success) {
    fail('baseId is not a base ID');
  }
  if (entry.tableId != null && !idOf('tbl').safeParse(entry.tableId).success) {
    fail('tableId is not a table ID');
  }
  if (!ENTITY_TYPE_PATTERN.test(entry.entityType)) fail('entityType must match [a-z][a-z0-9_]*');
  for (const side of ['before', 'after'] as const) {
    const key = findForbiddenAuditKey(entry[side] ?? undefined);
    if (key !== null) fail(`${side}.${key} looks like a secret; audit entries never store secrets`);
  }
  const ctx = context.data;
  return {
    organization_id: entry.organizationId,
    base_id: entry.baseId ?? null,
    table_id: entry.tableId ?? null,
    actor_type: ctx.actor.type,
    actor_id: ctx.actor.id,
    // Validated above; the input keeps its exact optional-property type.
    via: entry.context.via,
    action: action.data,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    batch_id: ctx.batch_id,
    request_id: ctx.request_id,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: ctx.ip,
    user_agent: ctx.user_agent === null ? null : ctx.user_agent.slice(0, MAX_USER_AGENT_LENGTH),
  };
}
