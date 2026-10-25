import {
  authOf,
  authUsesBearer,
  authUsesSignature,
  CREDENTIAL_REQUIRED,
  INCOMING_WEBHOOK_DEFAULT_RATE_PER_SEC,
  INCOMING_WEBHOOK_LISTEN_SECONDS,
  INCOMING_WEBHOOKS_MAX_PER_BASE,
  newId,
  RATE_LIMIT_TOO_HIGH,
  SIGNING_SECRET_ROTATION_HOURS,
  TOO_MANY_WEBHOOKS,
  WEBHOOK_IN_USE,
  WEBHOOK_NAME_TAKEN,
  type CreateIncomingWebhookRequest,
  type Id,
  type IncomingWebhookDto,
  type IncomingWebhookList,
  type IncomingWebhookListenResponse,
  type IncomingWebhookRequestList,
  type IncomingWebhookRequestListQuery,
  type IncomingWebhookSampleResponse,
  type IncomingWebhookUsage,
  type IncomingWebhookWithSecretsDto,
  type UpdateIncomingWebhookRequest,
} from '@cellhive/contracts';
import {
  AuditWriter,
  BasesRepository,
  canSeeAutomation,
  decodeCursor,
  IncomingWebhookCredentials,
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
  incomingWebhookUrl,
  IncomingWebhookUsageRepository,
  orgScope,
  sampleFromJson,
  SQLSTATE,
  sqlStateOf,
  type AppConfig,
  type AuditContext,
  type Db,
  type IncomingWebhookListRow,
  type IncomingWebhookPatch,
  type IncomingWebhookRow,
  type JsonObject,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { type RequestMeta } from '../../common/auth/request-meta.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

function validation(path: string, code: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, code, message }] });
}

/** The unique index of live hook names in a base (migration 0043). */
const NAME_INDEX = 'incoming_webhooks_base_name_key';

function constraintOf(error: unknown): string | undefined {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Audit/event snapshot of a hook (CONTRACTS §8, §25.1): configuration only —
 * never the token, a secret, a hash or a ciphertext.
 */
function snapshotOf(
  hook: Pick<IncomingWebhookRow, 'name' | 'auth' | 'enabled' | 'rate_limit_per_sec'>,
): JsonObject {
  return {
    name: hook.name,
    auth: hook.auth,
    enabled: hook.enabled,
    rate_limit_per_sec: hook.rate_limit_per_sec,
  };
}

/** Keys of the snapshot that differ. */
function changedKeys(before: JsonObject, after: JsonObject): string[] {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

const audit = new AuditWriter();

interface ResolvedHook {
  readonly base: BaseAccess;
  readonly scope: OrgScope;
  readonly hook: IncomingWebhookRow;
}

/**
 * Incoming webhooks — management (BACKLOG T602, CONTRACTS §25.1, ADR-35 §1).
 *
 * **Base admins only** (BACKLOG "Quyết định S5c" #7): a member who can read
 * the base but is not a base admin gets `403`; a base the caller cannot
 * read, a hook of another organization, a deleted hook or an unknown id is
 * `404`. The URL is readable again by base admins (`token_enc`, decision
 * #8); the signing secret and the Bearer token are returned only by the
 * call that issues them. Changes are audited — `incoming_webhook.created|
 * updated|deleted` as events, `incoming_webhook.secret_rotated|
 * token_regenerated` audit only — with configuration only.
 */
@Injectable()
export class IncomingWebhookService {
  private readonly credentials: IncomingWebhookCredentials;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(IncomingWebhooksRepository) private readonly hooks: IncomingWebhooksRepository,
    @Inject(IncomingWebhookRequestsRepository)
    private readonly requests: IncomingWebhookRequestsRepository,
    @Inject(IncomingWebhookUsageRepository)
    private readonly usage: IncomingWebhookUsageRepository,
  ) {
    this.credentials = new IncomingWebhookCredentials(config.security.appMasterKey);
  }

  async list(principal: Principal, baseId: Id<'bse'>): Promise<IncomingWebhookList> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    const rows = await this.hooks.listByBase(base.org.scope, baseId);
    const items: IncomingWebhookDto[] = [];
    for (const row of rows) items.push(await this.dtoOf(principal, base.org.scope, row));
    return { items };
  }

  async get(principal: Principal, hookId: Id<'hok'>): Promise<IncomingWebhookDto> {
    const { scope } = await this.requireHook(principal, hookId);
    return this.read(principal, scope, hookId);
  }

  async create(
    principal: Principal,
    baseId: Id<'bse'>,
    body: CreateIncomingWebhookRequest,
    meta: RequestMeta,
  ): Promise<IncomingWebhookWithSecretsDto> {
    const base = await this.access.requireBase(principal, baseId, 'admin');
    const rate = this.rateOf(body.rate_limit_per_sec);
    const token = this.credentials.issueToken();
    const signing = authUsesSignature(body.auth) ? this.credentials.issueSigningSecret() : null;
    const bearer = authUsesBearer(body.auth) ? this.credentials.issueBearer() : null;
    const context = mutationContextOf(meta, principal.userId);
    const organizationId = base.org.organizationId;
    const created = await this.uniqueName(() =>
      this.db.withTx(async (tx) => {
        const scope = orgScope(organizationId, tx);
        // One creation at a time per base: the count and the insert agree.
        if ((await this.bases.lockForUpdate(scope, baseId)) === undefined) throw notFound();
        if ((await this.hooks.countByBase(scope, baseId)) >= INCOMING_WEBHOOKS_MAX_PER_BASE) {
          throw validation(
            '',
            TOO_MANY_WEBHOOKS,
            `A base has at most ${String(INCOMING_WEBHOOKS_MAX_PER_BASE)} incoming webhooks.`,
          );
        }
        const row = await this.hooks.create(scope, {
          id: newId('hok'),
          base_id: baseId,
          name: body.name,
          token_hash: token.tokenHash,
          token_enc: token.tokenEnc,
          auth: body.auth,
          signing_secret_enc: signing?.secretEnc ?? null,
          bearer_hash: bearer?.bearerHash ?? null,
          rate_limit_per_sec: rate,
          created_by: principal.userId,
        });
        await this.change(tx, row, 'incoming_webhook.created', context, {
          after: snapshotOf(row),
        });
        return row;
      }),
    );
    return {
      ...(await this.read(principal, base.org.scope, created.id)),
      signing_secret: signing?.secret ?? null,
      bearer_token: bearer?.token ?? null,
    };
  }

  async update(
    principal: Principal,
    hookId: Id<'hok'>,
    body: UpdateIncomingWebhookRequest,
    meta: RequestMeta,
  ): Promise<IncomingWebhookDto> {
    const { scope } = await this.requireHook(principal, hookId);
    if (body.rate_limit_per_sec !== undefined) this.rateOf(body.rate_limit_per_sec);
    const context = mutationContextOf(meta, principal.userId);
    await this.uniqueName(() =>
      this.locked(scope, hookId, async (tx, txScope, current) => {
        const patch: IncomingWebhookPatch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (body.rate_limit_per_sec !== undefined) {
          patch.rate_limit_per_sec = body.rate_limit_per_sec;
        }
        if (body.auth !== undefined) Object.assign(patch, this.authPatch(current, body.auth));
        const before = snapshotOf(current);
        const after = snapshotOf({ ...current, ...patch } as IncomingWebhookRow);
        const changed = changedKeys(before, after);
        if (changed.length === 0) return;
        const updated = await this.hooks.update(txScope, hookId, patch);
        if (updated === undefined) throw notFound();
        await this.change(tx, updated, 'incoming_webhook.updated', context, {
          before,
          after: snapshotOf(updated),
          data: { changed },
        });
      }),
    );
    return this.read(principal, scope, hookId);
  }

  /** `409 WEBHOOK_IN_USE` while automations (not deleted) are triggered by it. */
  async remove(principal: Principal, hookId: Id<'hok'>, meta: RequestMeta): Promise<void> {
    const { scope } = await this.requireHook(principal, hookId);
    const context = mutationContextOf(meta, principal.userId);
    const blocked = await this.locked(scope, hookId, async (tx, txScope, current) => {
      // The usages are read under the hook's lock, in the same transaction.
      if ((await this.usage.list(txScope, hookId)).length > 0) return true;
      await this.hooks.softDelete(txScope, hookId);
      await this.change(tx, current, 'incoming_webhook.deleted', context, {
        before: snapshotOf(current),
      });
      return false;
    });
    if (!blocked) return;
    const usages = await this.usagesOf(principal, scope, hookId);
    const message = 'Automations are triggered by this webhook: change or delete them first.';
    throw new AppError('WEBHOOK_IN_USE', {
      detail: message,
      errors: [
        {
          path: '',
          code: WEBHOOK_IN_USE,
          message,
          params: { usages, total: usages.length },
        },
      ],
    });
  }

  /**
   * A new signing secret, shown once. The current one stays valid for 24 h
   * (only one previous secret is kept: rotating again during the grace
   * period drops the oldest). Without a signature check, turns it on.
   */
  async rotateSecret(
    principal: Principal,
    hookId: Id<'hok'>,
    meta: RequestMeta,
  ): Promise<IncomingWebhookWithSecretsDto> {
    const { scope } = await this.requireHook(principal, hookId);
    const issued = this.credentials.issueSigningSecret();
    const context = mutationContextOf(meta, principal.userId);
    await this.locked(scope, hookId, async (tx, txScope, current) => {
      const previous = current.signing_secret_enc;
      const expires =
        previous === null ? null : new Date(Date.now() + SIGNING_SECRET_ROTATION_HOURS * 3_600_000);
      const updated = await this.hooks.update(txScope, hookId, {
        signing_secret_enc: issued.secretEnc,
        signing_secret_prev_enc: previous,
        signing_secret_prev_expires_at: expires,
        auth: authOf(true, current.bearer_hash !== null),
      });
      if (updated === undefined) throw notFound();
      await this.auditOnly(tx, updated, 'incoming_webhook.secret_rotated', context, {
        before: { auth: current.auth },
        after: {
          auth: updated.auth,
          previous_secret_valid_until: expires === null ? null : expires.toISOString(),
        },
      });
    });
    return {
      ...(await this.read(principal, scope, hookId)),
      signing_secret: issued.secret,
      bearer_token: null,
    };
  }

  /** A new URL token: the old URL answers `404` from the commit on. */
  async regenerateToken(
    principal: Principal,
    hookId: Id<'hok'>,
    meta: RequestMeta,
  ): Promise<IncomingWebhookDto> {
    const { scope } = await this.requireHook(principal, hookId);
    const token = this.credentials.issueToken();
    const context = mutationContextOf(meta, principal.userId);
    await this.locked(scope, hookId, async (tx, txScope) => {
      const updated = await this.hooks.update(txScope, hookId, {
        token_hash: token.tokenHash,
        token_enc: token.tokenEnc,
      });
      if (updated === undefined) throw notFound();
      await this.auditOnly(tx, updated, 'incoming_webhook.token_regenerated', context, {});
    });
    return this.read(principal, scope, hookId);
  }

  /** A new Bearer token, shown once; replaces the current one at once. */
  async setBearer(
    principal: Principal,
    hookId: Id<'hok'>,
    meta: RequestMeta,
  ): Promise<IncomingWebhookWithSecretsDto> {
    const { scope } = await this.requireHook(principal, hookId);
    const issued = this.credentials.issueBearer();
    const context = mutationContextOf(meta, principal.userId);
    await this.locked(scope, hookId, async (tx, txScope, current) => {
      const updated = await this.hooks.update(txScope, hookId, {
        bearer_hash: issued.bearerHash,
        auth: authOf(current.signing_secret_enc !== null, true),
      });
      if (updated === undefined) throw notFound();
      await this.change(tx, updated, 'incoming_webhook.updated', context, {
        before: snapshotOf(current),
        after: { ...snapshotOf(updated), bearer_replaced: true },
        data: { changed: ['bearer'] },
      });
    });
    return {
      ...(await this.read(principal, scope, hookId)),
      signing_secret: null,
      bearer_token: issued.token,
    };
  }

  /** Turns the Bearer check off (nothing to do when it is off). */
  async deleteBearer(
    principal: Principal,
    hookId: Id<'hok'>,
    meta: RequestMeta,
  ): Promise<IncomingWebhookDto> {
    const { scope } = await this.requireHook(principal, hookId);
    const context = mutationContextOf(meta, principal.userId);
    await this.locked(scope, hookId, async (tx, txScope, current) => {
      if (current.bearer_hash === null) return;
      const updated = await this.hooks.update(txScope, hookId, {
        bearer_hash: null,
        auth: authOf(current.signing_secret_enc !== null, false),
      });
      if (updated === undefined) throw notFound();
      await this.change(tx, updated, 'incoming_webhook.updated', context, {
        before: snapshotOf(current),
        after: snapshotOf(updated),
        data: { changed: ['auth'] },
      });
    });
    return this.read(principal, scope, hookId);
  }

  /**
   * Opens (or replaces) the 180-second "listen for a sample request" window
   * for the caller and drops the previous sample (T603, CONTRACTS §25.3).
   * Not audited: it changes no configuration.
   */
  async listen(principal: Principal, hookId: Id<'hok'>): Promise<IncomingWebhookListenResponse> {
    const { scope } = await this.requireHook(principal, hookId);
    const until = new Date(Date.now() + INCOMING_WEBHOOK_LISTEN_SECONDS * 1000);
    const updated = await this.hooks.startListening(scope, hookId, principal.userId, until);
    if (updated === undefined) throw notFound();
    return { listen_until: iso(until) };
  }

  /** Closes the listening window; a sample already captured stays. */
  async stopListening(principal: Principal, hookId: Id<'hok'>): Promise<void> {
    const { scope } = await this.requireHook(principal, hookId);
    if (!(await this.hooks.stopListening(scope, hookId))) throw notFound();
  }

  /** The captured sample (sensitive headers were never stored) and the open window, if any. */
  async sample(principal: Principal, hookId: Id<'hok'>): Promise<IncomingWebhookSampleResponse> {
    const { hook } = await this.requireHook(principal, hookId);
    const sample = sampleFromJson(hook.sample);
    const listening = hook.listen_until !== null && hook.listen_until.getTime() > Date.now();
    return {
      sample:
        sample === null || hook.sample_captured_at === null
          ? null
          : {
              body: sample.body,
              headers: { ...sample.headers },
              query: { ...sample.query },
              truncated: sample.truncated,
              received_at: iso(hook.sample_captured_at),
            },
      listen_until: listening && hook.listen_until !== null ? iso(hook.listen_until) : null,
    };
  }

  /** The request log (metadata only), newest first. */
  async listRequests(
    principal: Principal,
    hookId: Id<'hok'>,
    query: IncomingWebhookRequestListQuery,
  ): Promise<IncomingWebhookRequestList> {
    const { scope } = await this.requireHook(principal, hookId);
    const page = await this.requests.listPage(scope, hookId, {
      cursor: decodeCursor(query.cursor),
      limit: query.limit,
    });
    return {
      items: page.items.map((row) => ({
        id: row.id,
        received_at: iso(row.received_at),
        size_bytes: row.size_bytes,
        duplicate: row.duplicate,
        causation_accepted: row.causation_accepted,
        event_id: row.event_id,
      })),
      next_cursor: page.nextCursor,
    };
  }

  // --- Internals ---------------------------------------------------------

  /**
   * The live hook in one of the caller's organizations, with base admin
   * access to its base: a hook of another organization, a deleted one or one
   * of a base the caller cannot read is `404`; a reader who is not a base
   * admin `403`.
   */
  private async requireHook(principal: Principal, hookId: Id<'hok'>): Promise<ResolvedHook> {
    for (const membership of await this.access.memberships(principal)) {
      const scope = orgScope(membership.organizationId);
      const hook = await this.hooks.findById(scope, hookId);
      if (hook === undefined) continue;
      const base = await this.access.requireBase(principal, hook.base_id, 'admin');
      return { base, scope: base.org.scope, hook };
    }
    throw notFound();
  }

  /** Runs `fn` in a transaction holding the hook's row lock (`404` when it is gone). */
  private async locked<T>(
    scope: OrgScope,
    hookId: Id<'hok'>,
    fn: (tx: Tx, scope: OrgScope, current: IncomingWebhookRow) => Promise<T>,
  ): Promise<T> {
    return this.db.withTx(async (tx) => {
      const txScope = orgScope(scope.organizationId, tx);
      const current = await this.hooks.findById(txScope, hookId, { forUpdate: true });
      if (current === undefined) throw notFound();
      return fn(tx, txScope, current);
    });
  }

  /** `rate_limit_per_sec` checked against `WEBHOOK_MAX_RATE_PER_SEC`. */
  private rateOf(requested: number | undefined): number {
    const max = this.config.incomingWebhooks.maxRatePerSec;
    if (requested === undefined) return Math.min(INCOMING_WEBHOOK_DEFAULT_RATE_PER_SEC, max);
    if (requested > max) {
      throw validation(
        'rate_limit_per_sec',
        RATE_LIMIT_TOO_HIGH,
        `This instance allows at most ${String(max)} requests per second per webhook.`,
      );
    }
    return requested;
  }

  /**
   * The columns for a new `auth`: it may only remove checks; the credential
   * of a removed check is erased. Adding one needs its credential.
   */
  private authPatch(
    current: IncomingWebhookRow,
    auth: IncomingWebhookRequestAuth,
  ): IncomingWebhookPatch {
    const hasSignature = current.signing_secret_enc !== null;
    const hasBearer = current.bearer_hash !== null;
    if ((authUsesSignature(auth) && !hasSignature) || (authUsesBearer(auth) && !hasBearer)) {
      throw validation(
        'auth',
        CREDENTIAL_REQUIRED,
        'To add a check, issue its credential: rotate the signing secret or set a Bearer token.',
      );
    }
    const patch: IncomingWebhookPatch = { auth };
    if (!authUsesSignature(auth)) {
      patch.signing_secret_enc = null;
      patch.signing_secret_prev_enc = null;
      patch.signing_secret_prev_expires_at = null;
    }
    if (!authUsesBearer(auth)) patch.bearer_hash = null;
    return patch;
  }

  private async uniqueName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.uniqueViolation && constraintOf(error) === NAME_INDEX) {
        throw validation(
          'name',
          WEBHOOK_NAME_TAKEN,
          'Another incoming webhook of this base has this name.',
        );
      }
      throw error;
    }
  }

  private async usagesOf(
    principal: Principal,
    scope: OrgScope,
    hookId: Id<'hok'>,
  ): Promise<IncomingWebhookUsage[]> {
    const usages: IncomingWebhookUsage[] = [];
    for (const row of await this.usage.list(scope, hookId)) {
      const base = await this.access.findBase(principal, row.baseId);
      const visible = base !== undefined && canSeeAutomation(base.access, row.triggerTableId);
      usages.push({ automation_id: row.automationId, name: visible ? row.name : null });
    }
    return usages;
  }

  private async read(
    principal: Principal,
    scope: OrgScope,
    hookId: Id<'hok'>,
  ): Promise<IncomingWebhookDto> {
    const row = await this.hooks.findListRow(orgScope(scope.organizationId), hookId);
    if (row === undefined) throw notFound();
    return this.dtoOf(principal, scope, row);
  }

  private async dtoOf(
    principal: Principal,
    scope: OrgScope,
    row: IncomingWebhookListRow,
  ): Promise<IncomingWebhookDto> {
    const now = Date.now();
    const future = (value: Date | null) =>
      value !== null && value.getTime() > now ? iso(value) : null;
    return {
      id: row.id,
      base_id: row.base_id,
      name: row.name,
      url: incomingWebhookUrl(this.config.publicUrl, this.credentials.unsealToken(row.token_enc)),
      auth: row.auth,
      enabled: row.enabled,
      rate_limit_per_sec: row.rate_limit_per_sec,
      signing_secret_rotating_until:
        row.signing_secret_prev_enc === null ? null : future(row.signing_secret_prev_expires_at),
      listen_until: future(row.listen_until),
      sample_captured_at: row.sample_captured_at === null ? null : iso(row.sample_captured_at),
      last_received_at: row.last_received_at === null ? null : iso(row.last_received_at),
      usages: await this.usagesOf(principal, scope, row.id),
      created_by:
        row.created_by === null ? null : { id: row.created_by, name: row.created_by_name ?? '' },
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  private async change(
    tx: Tx,
    hook: IncomingWebhookRow,
    type: 'incoming_webhook.created' | 'incoming_webhook.updated' | 'incoming_webhook.deleted',
    context: AuditContext,
    values: {
      readonly before?: JsonObject;
      readonly after?: JsonObject;
      readonly data?: JsonObject;
    },
  ): Promise<void> {
    await recordChange(tx, {
      type,
      organizationId: hook.organization_id,
      baseId: hook.base_id,
      entityType: 'incoming_webhook',
      entityId: hook.id,
      context,
      before: values.before ?? null,
      after: values.after ?? null,
      ...(values.data === undefined ? {} : { data: values.data }),
    });
  }

  private async auditOnly(
    tx: Tx,
    hook: IncomingWebhookRow,
    action: 'incoming_webhook.secret_rotated' | 'incoming_webhook.token_regenerated',
    context: AuditContext,
    values: { readonly before?: JsonObject; readonly after?: JsonObject },
  ): Promise<void> {
    await audit.write(tx, {
      action,
      organizationId: hook.organization_id,
      baseId: hook.base_id,
      entityType: 'incoming_webhook',
      entityId: hook.id,
      before: values.before ?? null,
      after: values.after ?? null,
      context,
    });
  }
}

type IncomingWebhookRequestAuth = NonNullable<UpdateIncomingWebhookRequest['auth']>;
