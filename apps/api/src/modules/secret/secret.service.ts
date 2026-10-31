import {
  BOT_IN_USE,
  canonicalAllowedHosts,
  INVALID_BOT_TOKEN,
  isHostBoundSecretKind,
  INVALID_SECRET_VALUE,
  isValidSecretValue,
  newId,
  SECRET_IN_USE,
  SECRET_LIMIT_REACHED,
  SECRET_NAME_TAKEN,
  SECRET_ROTATION_OVERLAP_HOURS,
  SECRETS_MAX_PER_ORG,
  type BaseSecretList,
  type BaseSecretListQuery,
  type CreateSecretRequest,
  type Id,
  type ProblemErrorItem,
  type SecretDto,
  type SecretKind,
  type SecretList,
  type SecretWithValueDto,
  type SecretUsages,
  type UpdateSecretRequest,
} from '@cellhive/contracts';
import {
  AiSettingsRepository,
  AuditWriter,
  canSeeAutomation,
  deriveSecretKey,
  generateSigningSecret,
  isNotificationBotOfAnotherOrganization,
  isNotificationBotSecret,
  managesAnyAutomation,
  OrganizationsRepository,
  orgScope,
  orgTelegramSettingsOf,
  resetChannelsForNewBot,
  sealSecret,
  unsealSecret,
  SecretsRepository,
  SecretUsageRepository,
  SQLSTATE,
  sqlStateOf,
  withOrgTelegramSettings,
  type AppConfig,
  type Db,
  type JsonObject,
  type OrgScope,
  type SecretListRow,
  type SecretPatch,
  type SecretRow,
  type TelegramBotApi,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { type RequestMeta } from '../../common/auth/request-meta.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB, TELEGRAM_BOT_API } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { Buffer } from 'node:buffer';

function invalidField(path: string, code: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, code, message }] });
}

/** Audit snapshot: never the value or the ciphertext (host-bound kinds: their allowed hosts, T701). */
function snapshotOf(
  secret: Pick<SecretRow, 'kind' | 'name' | 'base_scope' | 'allowed_hosts'>,
  baseIds: readonly Id<'bse'>[],
): JsonObject {
  return {
    kind: secret.kind,
    name: secret.name,
    base_scope: secret.base_scope,
    base_ids: [...baseIds],
    ...(isHostBoundSecretKind(secret.kind) ? { allowed_hosts: [...secret.allowed_hosts] } : {}),
  };
}

const audit = new AuditWriter();

/** How long the previous value of a replaced `webhook_signing` secret keeps signing. */
const ROTATION_OVERLAP_MS = SECRET_ROTATION_OVERLAP_HOURS * 60 * 60 * 1000;

/**
 * Secrets of an organization (BACKLOG T516, T606; CONTRACTS §24): Telegram
 * bot tokens, HTTP auth header values and Standard Webhooks signing secrets
 * (`webhook_signing`: the server can generate one, returned once; a new
 * value keeps the previous one signing 24 hours). Managed by organization
 * owners/admins only (members
 * `403`, other organizations `404`); automation managers of a base only
 * list the secrets in scope, by name. Values are sealed (AES-256-GCM, key
 * `org-secret` from `APP_MASTER_KEY`) and never returned, logged or
 * audited. Changes are audited (`secret.created|updated|deleted`, CONTRACTS
 * §8: audit only, no event). The organization's notification bot (T549,
 * §22.7) is a usage: it cannot be deleted, and a new token of another bot
 * puts members' Telegram channels in `error` (`bot_changed`). HTTP secrets
 * carry the hosts they may be sent to (`allowed_hosts`, T701, ADR-36 §4):
 * required when created; setting them ends the transition period of a
 * secret stored before lists existed (`legacy_hosts_until`).
 */
@Injectable()
export class SecretService {
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
    @Inject(SecretUsageRepository) private readonly usage: SecretUsageRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(TELEGRAM_BOT_API) private readonly telegram: TelegramBotApi,
    @Inject(AiSettingsRepository) private readonly aiSettings: AiSettingsRepository,
  ) {
    this.key = deriveSecretKey(config.security.appMasterKey, 'org-secret');
  }

  // --- Reads -------------------------------------------------------------

  async list(principal: Principal, organizationId: Id<'org'>): Promise<SecretList> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const rows = await this.secrets.list(org.scope);
    const bases = await this.secrets.baseIdsOf(
      org.scope,
      rows.map((row) => row.id),
    );
    return { items: rows.map((row) => this.dtoOf(row, bases.get(row.id) ?? [])) };
  }

  /** `GET /bases/:baseId/secrets`: automation managers of the base, names only. */
  async listForBase(
    principal: Principal,
    baseId: Id<'bse'>,
    query: BaseSecretListQuery,
  ): Promise<BaseSecretList> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) {
      throw permissionDenied('Only automation managers of the base can list its secrets.');
    }
    const rows = await this.secrets.listUsableInBase(base.org.scope, baseId, query.kind);
    return { items: rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name })) };
  }

  /** Automations (not deleted) using the secret; names only when the caller sees them. */
  async usages(principal: Principal, secretId: Id<'sec'>): Promise<SecretUsages> {
    const { scope } = await this.requireSecret(principal, secretId);
    return this.usagesOf(principal, scope, secretId);
  }

  // --- Writes ------------------------------------------------------------

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    body: CreateSecretRequest,
    meta: RequestMeta,
  ): Promise<SecretWithValueDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    // `generate` (only `webhook_signing`, checked by the schema): made here, returned once.
    const generated = body.generate === true ? generateSigningSecret() : undefined;
    const value = (generated ?? body.value ?? '').trim();
    this.assertValue(body.kind, value);
    const baseIds = body.base_scope === 'selected' ? [...new Set(body.base_ids)].sort() : [];
    await this.assertBases(org.scope, baseIds);
    if ((await this.secrets.count(org.scope)) >= SECRETS_MAX_PER_ORG) {
      throw invalidField(
        'name',
        SECRET_LIMIT_REACHED,
        `An organization has at most ${String(SECRETS_MAX_PER_ORG)} secrets.`,
      );
    }
    const context = mutationContextOf(meta, principal.userId);
    const created = await this.uniqueName(() =>
      this.db.withTx(async (tx) => {
        const scope = orgScope(organizationId, tx);
        const row = await this.secrets.create(scope, {
          id: newId('sec'),
          kind: body.kind,
          name: body.name,
          ciphertext: sealSecret(this.key, value),
          base_scope: body.base_scope,
          // The schema requires 1–20 patterns for host-bound kinds and refuses them for others.
          allowed_hosts: isHostBoundSecretKind(body.kind)
            ? canonicalAllowedHosts(body.allowed_hosts ?? [])
            : [],
          created_by: principal.userId,
        });
        await this.secrets.replaceBases(scope, row.id, baseIds);
        await this.audit(tx, row, 'secret.created', context, { after: snapshotOf(row, baseIds) });
        return row;
      }),
    );
    const dto = await this.read(org.scope, created.id);
    return generated === undefined ? dto : { ...dto, value: generated };
  }

  async update(
    principal: Principal,
    secretId: Id<'sec'>,
    body: UpdateSecretRequest,
    meta: RequestMeta,
  ): Promise<SecretWithValueDto> {
    const { scope: readScope, secret: current } = await this.requireSecret(principal, secretId);
    if (body.generate === true && current.kind !== 'webhook_signing') {
      throw invalidField(
        'generate',
        INVALID_SECRET_VALUE,
        'Only webhook signing secrets can be generated.',
      );
    }
    if (body.allowed_hosts !== undefined && !isHostBoundSecretKind(current.kind)) {
      throw invalidField(
        'allowed_hosts',
        'UNRECOGNIZED_KEY',
        'Only http_header, webhook_signing and ai_api_key secrets have allowed hosts.',
      );
    }
    if (current.kind === 'ai_api_key' && body.base_scope === 'selected') {
      throw invalidField(
        'base_scope',
        'NOT_ALLOWED',
        'An AI API key belongs to the whole organization.',
      );
    }
    const generated = body.generate === true ? generateSigningSecret() : undefined;
    const newValue = generated ?? body.value?.trim();
    if (newValue !== undefined) this.assertValue(current.kind, newValue);
    const currentBaseIds =
      (await this.secrets.baseIdsOf(readScope, [secretId])).get(secretId) ?? [];
    const baseScope = body.base_scope ?? current.base_scope;
    let baseIds = currentBaseIds;
    if (baseScope === 'all') baseIds = [];
    else if (body.base_ids !== undefined) baseIds = [...new Set(body.base_ids)].sort();
    await this.assertBases(readScope, baseIds);

    const patch: SecretPatch = {};
    if (body.name !== undefined && body.name !== current.name) patch.name = body.name;
    if (baseScope !== current.base_scope) patch.base_scope = baseScope;
    if (body.allowed_hosts !== undefined) {
      const hosts = canonicalAllowedHosts(body.allowed_hosts);
      if (hosts.join(',') !== current.allowed_hosts.join(',')) patch.allowed_hosts = hosts;
      // A list ends the transition period of a secret stored before lists existed.
      if (current.legacy_hosts_until !== null) {
        patch.allowed_hosts = hosts;
        patch.legacy_hosts_until = null;
      }
    }
    if (newValue !== undefined) {
      patch.ciphertext = sealSecret(this.key, newValue);
      if (current.kind === 'webhook_signing') {
        // ADR-35 §8: the previous value signs too for 24 hours (one previous value kept).
        patch.previous_ciphertext = current.ciphertext;
        patch.previous_expires_at = new Date(Date.now() + ROTATION_OVERLAP_MS);
      }
    }
    const basesChanged = baseIds.join(',') !== currentBaseIds.join(',');
    if (Object.keys(patch).length === 0 && !basesChanged) return this.read(readScope, secretId);

    // A new token of the notification bot naming another bot is a bot change (T549).
    const newBot =
      newValue === undefined || current.kind !== 'telegram_bot'
        ? null
        : await this.notificationBotOfToken(current.organization_id, secretId, newValue);
    // The webhook (T609) belongs to the old bot: the switch goes back to polling and removes it.
    const oldWebhookToken = newBot === null ? null : await this.webhookTokenOf(current);

    const context = mutationContextOf(meta, principal.userId);
    await this.uniqueName(() =>
      this.db.withTx(async (tx) => {
        if (newBot !== null) {
          await this.switchNotificationBot(tx, current.organization_id, secretId, newBot);
        }
        const scope = orgScope(current.organization_id, tx);
        const updated =
          Object.keys(patch).length === 0
            ? current
            : await this.secrets.update(scope, secretId, patch);
        if (updated === undefined) throw notFound();
        if (basesChanged) await this.secrets.replaceBases(scope, secretId, baseIds);
        await this.audit(tx, updated, 'secret.updated', context, {
          before: snapshotOf(current, currentBaseIds),
          after: {
            ...snapshotOf(updated, baseIds),
            ...(newValue === undefined ? {} : { value_replaced: true }),
            ...(newValue !== undefined && updated.previous_expires_at !== null
              ? { previous_value_expires_at: updated.previous_expires_at.toISOString() }
              : {}),
          },
        });
      }),
    );
    if (oldWebhookToken !== null) {
      // Best effort, after commit: a webhook left on a bot Cellhive no longer uses only gets `404`.
      await this.telegram.deleteWebhook(oldWebhookToken).catch(() => undefined);
    }
    const dto = await this.read(readScope, secretId);
    return generated === undefined ? dto : { ...dto, value: generated };
  }

  /**
   * The current token of the notification bot `secret` when its organization
   * is in webhook mode (T609), else `null`; unsealed in memory only.
   */
  private async webhookTokenOf(secret: SecretRow): Promise<string | null> {
    const organization = await this.organizations.findById(secret.organization_id);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (bot.secretId !== secret.id || bot.deliveryMode !== 'webhook') return null;
    try {
      return unsealSecret(this.key, secret.ciphertext);
    } catch {
      return null;
    }
  }

  /** `409 SECRET_IN_USE` while automations (not deleted) name it. */
  async remove(principal: Principal, secretId: Id<'sec'>, meta: RequestMeta): Promise<void> {
    const { scope, secret } = await this.requireSecret(principal, secretId);
    const context = mutationContextOf(meta, principal.userId);
    const blocked = await this.db.withTx(async (tx) => {
      const txScope = orgScope(secret.organization_id, tx);
      // The organization first (it names the notification bot, T549), then the
      // secret: the order `PATCH …/notification-channels` follows too.
      const notificationBot = await isNotificationBotSecret(
        this.db,
        secret.organization_id,
        secretId,
        { tx, lock: true },
      );
      // One delete at a time per secret; the usages are read in the same transaction.
      const locked = await this.secrets.findById(txScope, secretId, { forUpdate: true });
      if (locked === undefined) throw notFound();
      if (notificationBot) return true;
      // The key of the AI settings (T906); a save racing this delete leaves no key (FK `SET NULL`).
      if (await this.aiSettings.usesKey(txScope, secretId)) return true;
      if ((await this.usage.list(txScope, secretId)).length > 0) return true;
      const baseIds = (await this.secrets.baseIdsOf(txScope, [secretId])).get(secretId) ?? [];
      await this.secrets.delete(txScope, secretId);
      await this.audit(tx, locked, 'secret.deleted', context, {
        before: snapshotOf(locked, baseIds),
      });
      return false;
    });
    if (!blocked) return;
    const usages = await this.usagesOf(principal, scope, secretId);
    const message = usages.items.some((item) => item.kind === 'notification_channel')
      ? 'This bot sends the notifications of the organization: choose another one first.'
      : usages.items.some((item) => item.kind === 'ai_settings')
        ? 'This is the API key of the AI settings: change them first.'
        : 'Automations use this secret: change them first.';
    throw new AppError('SECRET_IN_USE', {
      detail: message,
      errors: [
        {
          path: '',
          code: SECRET_IN_USE,
          message,
          params: { usages: usages.items, total: usages.total },
        },
      ],
    });
  }

  // --- Internals ---------------------------------------------------------

  /**
   * When `secretId` is the organization's notification bot and `token`
   * belongs to another bot (its id prefix differs), that bot as `getMe` sees
   * it; `null` otherwise. A token Telegram refuses is `INVALID_BOT_TOKEN`
   * (members' channels would stop working); no answer is `503`.
   */
  private async notificationBotOfToken(
    organizationId: Id<'org'>,
    secretId: Id<'sec'>,
    token: string,
  ): Promise<{ botId: number; username: string } | null> {
    const organization = await this.organizations.findById(organizationId);
    const bot = orgTelegramSettingsOf(organization?.settings);
    if (bot.secretId !== secretId) return null;
    const botId = Number(token.slice(0, token.indexOf(':')));
    if (bot.botId === botId) return null;
    const me = await this.telegram.getMe(token);
    if (me.ok) return { botId: me.botId, username: me.username };
    if (me.kind === 'unauthorized') {
      throw invalidField(
        'value',
        INVALID_BOT_TOKEN,
        'Telegram does not accept this token, and this bot sends notifications.',
      );
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      detail: 'Telegram did not answer; try again later.',
    });
  }

  /**
   * The notification bot's token now names `bot`: the organization's
   * settings follow and every personal channel goes to `error`
   * (`bot_changed`), in the transaction that replaces the token. Audited
   * with the secret (`secret.updated`, `value_replaced`).
   */
  private async switchNotificationBot(
    tx: Tx,
    organizationId: Id<'org'>,
    secretId: Id<'sec'>,
    bot: { readonly botId: number; readonly username: string },
  ): Promise<void> {
    const organization = await this.organizations.lockById(organizationId, tx);
    if (organization === undefined) return;
    const current = orgTelegramSettingsOf(organization.settings);
    if (current.secretId !== secretId) return;
    if (await isNotificationBotOfAnotherOrganization(this.db, tx, organizationId, bot.botId)) {
      throw invalidField(
        'value',
        BOT_IN_USE,
        'This bot already sends the notifications of another organization: create another bot.',
      );
    }
    await this.organizations.update(
      organizationId,
      {
        settings: withOrgTelegramSettings(organization.settings, {
          secretId,
          botId: bot.botId,
          botUsername: bot.username,
          status: 'ok',
        }),
      },
      tx,
    );
    await resetChannelsForNewBot(this.db, tx, organizationId, new Date());
  }

  /**
   * The secret in one of the caller's organizations: one of another
   * organization is `404`; a member who is not an owner/admin `403`.
   */
  private async requireSecret(
    principal: Principal,
    secretId: Id<'sec'>,
  ): Promise<{ scope: OrgScope; secret: SecretRow }> {
    for (const membership of await this.access.memberships(principal)) {
      const secret = await this.secrets.findById(orgScope(membership.organizationId), secretId);
      if (secret === undefined) continue;
      const org = await this.access.requireOrgAdmin(principal, membership.organizationId);
      return { scope: org.scope, secret };
    }
    throw notFound();
  }

  private async usagesOf(
    principal: Principal,
    scope: OrgScope,
    secretId: Id<'sec'>,
  ): Promise<SecretUsages> {
    const rows = await this.usage.list(scope, secretId);
    const items: SecretUsages['items'] = [];
    if (await isNotificationBotSecret(this.db, scope.organizationId, secretId)) {
      items.push({ kind: 'notification_channel' });
    }
    if (await this.aiSettings.usesKey(scope, secretId)) items.push({ kind: 'ai_settings' });
    for (const row of rows) {
      const base = await this.access.findBase(principal, row.baseId);
      const visible = base !== undefined && canSeeAutomation(base.access, row.triggerTableId);
      items.push({
        kind: 'automation',
        automation_id: row.automationId,
        base_id: row.baseId,
        name: visible ? row.name : null,
      });
    }
    return { items, total: items.length };
  }

  private async read(scope: OrgScope, secretId: Id<'sec'>): Promise<SecretDto> {
    const row = (await this.secrets.list(scope)).find((item) => item.id === secretId);
    if (row === undefined) throw notFound();
    const baseIds = (await this.secrets.baseIdsOf(scope, [secretId])).get(secretId) ?? [];
    return this.dtoOf(row, baseIds);
  }

  private dtoOf(row: SecretListRow, baseIds: readonly Id<'bse'>[]): SecretDto {
    return {
      id: row.id,
      organization_id: row.organization_id,
      kind: row.kind,
      name: row.name,
      base_scope: row.base_scope,
      base_ids: [...baseIds],
      allowed_hosts: [...row.allowed_hosts],
      legacy_hosts_until: row.legacy_hosts_until === null ? null : iso(row.legacy_hosts_until),
      previous_value_expires_at:
        row.previous_expires_at !== null && row.previous_expires_at.getTime() > Date.now()
          ? iso(row.previous_expires_at)
          : null,
      created_by:
        row.created_by === null ? null : { id: row.created_by, name: row.created_by_name ?? '' },
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  /**
   * The value has the shape its kind needs (never echoed in the error):
   * `telegram_bot` a Bot API token (`INVALID_BOT_TOKEN`), `http_header`
   * printable ASCII ≤ 4,096, `webhook_signing` `whsec_` + 24–64 bytes
   * (`INVALID_SECRET_VALUE`).
   */
  private assertValue(kind: SecretKind, value: string): void {
    if (isValidSecretValue(kind, value)) return;
    if (kind === 'telegram_bot') {
      throw invalidField('value', INVALID_BOT_TOKEN, 'This is not a Telegram bot token.');
    }
    throw invalidField(
      'value',
      INVALID_SECRET_VALUE,
      kind === 'webhook_signing'
        ? 'A signing secret is whsec_ followed by 24 to 64 bytes in base64.'
        : 'A header value or API key is printable ASCII text without line breaks (at most 4,096 characters).',
    );
  }

  private async assertBases(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<void> {
    const existing = await this.secrets.existingBaseIds(scope, baseIds);
    const errors = baseIds.flatMap((baseId, index): ProblemErrorItem[] =>
      existing.has(baseId)
        ? []
        : [{ path: `base_ids[${String(index)}]`, code: 'UNKNOWN_BASE', message: 'Unknown base.' }],
    );
    if (errors.length > 0) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Some bases do not exist.', errors });
    }
  }

  /** Maps the unique `(organization_id, lower(name))` violation to `SECRET_NAME_TAKEN`. */
  private async uniqueName<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.uniqueViolation) {
        throw invalidField('name', SECRET_NAME_TAKEN, 'Another secret has this name.');
      }
      throw error;
    }
  }

  private async audit(
    tx: Tx,
    secret: Pick<SecretRow, 'id' | 'organization_id'>,
    action: 'secret.created' | 'secret.updated' | 'secret.deleted',
    context: ReturnType<typeof mutationContextOf>,
    values: { readonly before?: JsonObject; readonly after?: JsonObject },
  ): Promise<void> {
    await audit.write(tx, {
      action,
      organizationId: secret.organization_id,
      baseId: null,
      entityType: 'secret',
      entityId: secret.id,
      before: values.before ?? null,
      after: values.after ?? null,
      context,
    });
  }
}
