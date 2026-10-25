import { randomBytes } from 'node:crypto';

import {
  BOT_IN_USE,
  INVALID_BOT_TOKEN,
  PUBLIC_URL_NOT_HTTPS,
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_LINK_CREATIONS_PER_HOUR,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  TELEGRAM_LINK_TOKENS_MAX_PENDING,
  TELEGRAM_WEBHOOK_CONFLICT,
  telegramStartLink,
  UNKNOWN_SECRET,
  type Id,
  type OrgNotificationChannelsDto,
  type TelegramLinkDto,
  type UpdateOrgNotificationChannelsInput,
  type UserChannelDto,
  type UserChannelListDto,
} from '@cellhive/contracts';
import {
  auditUserChannel,
  deriveSecretKey,
  enqueueTelegramPoll,
  hashToken,
  isNotificationBotOfAnotherOrganization,
  NO_TELEGRAM_BOT,
  orgScope,
  orgTelegramSettingsOf,
  OrganizationsRepository,
  publishChannelChanged,
  resetChannelsForNewBot,
  SecretsRepository,
  TelegramBotApi,
  TelegramWebhookRegistrar,
  TelegramWebhooksRepository,
  unsealSecret,
  UserChannelLinkTokensRepository,
  UserChannelsRepository,
  withOrgTelegramSettings,
  type AppConfig,
  type Db,
  type JsonObject,
  type OrgScope,
  type OrgTelegramSettings,
  type SecretRow,
  type TelegramWebhookRegistration,
  type TelegramWebhookRow,
  type UserChannelState,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB, TELEGRAM_BOT_API } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type { Buffer } from 'node:buffer';

/** A sliding hour, for the link creation limit. */
const HOUR_MS = 3_600_000;

function invalidField(path: string, code: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, code, message }] });
}

function unknownSecret(): AppError {
  return invalidField(
    'telegram_secret_id',
    UNKNOWN_SECRET,
    'No Telegram bot of this organization has this id.',
  );
}

function botInUse(): AppError {
  return invalidField(
    'telegram_secret_id',
    BOT_IN_USE,
    'This bot already sends the notifications of another organization: create another bot.',
  );
}

/**
 * Audit/event snapshot of the notification bot: ids, the username and the
 * delivery mode (T609), never a token or the webhook URL.
 */
function botSnapshot(telegram: OrgTelegramSettings): JsonObject {
  return {
    telegram_bot_secret_id: telegram.secretId,
    telegram_bot_username: telegram.botUsername,
    telegram_delivery_mode:
      telegram.secretId === null ? null : (telegram.deliveryMode ?? 'polling'),
  };
}

/** A new link token: 24 random bytes as 32 characters of `[A-Za-z0-9_-]`. */
function newLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Notification channels (CONTRACTS §22.7; ADR-34 §3; BACKLOG T549):
 *
 * - the organization's **notification bot** (`GET|PATCH
 *   /orgs/:orgId/notification-channels`, owner/admin; members `403`,
 *   others `404`): one `telegram_bot` secret of the organization checked
 *   with `getMe`; changing or removing it puts every channel in `error`
 *   (`bot_changed`) and cancels pending links; audited `org.updated`;
 *   its delivery mode (T609, ADR-35 §7): `webhook` registers the bot's
 *   webhook (`getWebhookInfo` first — never over another URL — then
 *   `setWebhook` with a new path token and `secret_token`), `polling` or
 *   another bot removes the old one (`deleteWebhook`); Telegram is called
 *   outside the transaction, and a webhook this request set is removed
 *   again when the request fails afterwards;
 * - the caller's own channels (`/orgs/:orgId/me/channels…`, any member,
 *   non-members `404`): list, create a one-time `t.me` link (5 per hour, at
 *   most 5 pending, 10 minutes, stored as SHA-256; the poll job is queued
 *   in the same transaction), unlink (idempotent, cancels pending links).
 *
 * No route ever returns a chat id, a Telegram name or a bot token; tokens
 * of links are only in the response that creates them.
 */
@Injectable()
export class NotificationChannelsService {
  private readonly secretKey: Buffer;
  private readonly organizations: OrganizationsRepository;
  private readonly secrets: SecretsRepository;
  private readonly channels: UserChannelsRepository;
  private readonly tokens: UserChannelLinkTokensRepository;
  private readonly webhooks: TelegramWebhooksRepository;
  private readonly registrar: TelegramWebhookRegistrar;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(TELEGRAM_BOT_API) private readonly telegram: TelegramBotApi,
  ) {
    this.secretKey = deriveSecretKey(config.security.appMasterKey, 'org-secret');
    this.organizations = new OrganizationsRepository(db);
    this.secrets = new SecretsRepository(db);
    this.channels = new UserChannelsRepository(db);
    this.tokens = new UserChannelLinkTokensRepository(db);
    this.webhooks = new TelegramWebhooksRepository(db);
    this.registrar = new TelegramWebhookRegistrar(db, {
      masterKey: config.security.appMasterKey,
      publicUrl: config.publicUrl,
      api: telegram,
    });
  }

  // --- Organization: the notification bot --------------------------------

  async getOrgChannels(
    principal: Principal,
    organizationId: Id<'org'>,
  ): Promise<OrgNotificationChannelsDto> {
    await this.access.requireOrgAdmin(principal, organizationId);
    return this.orgDto(await this.botOf(organizationId), organizationId);
  }

  async updateOrgChannels(
    principal: Principal,
    organizationId: Id<'org'>,
    body: UpdateOrgNotificationChannelsInput,
    meta: RequestMeta,
  ): Promise<OrgNotificationChannelsDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const current = await this.botOf(organizationId);
    const plan = await this.targetOf(org.scope, current, body);
    const { target, botChanged } = plan;
    if (
      botChanged &&
      target.botId !== null &&
      (await this.organizations.hasOtherWithNotificationBot(target.botId, organizationId))
    ) {
      // Checked again under lock below; refused before Telegram is called.
      throw botInUse();
    }

    // Telegram first (never inside a transaction): the new webhook, then the old one removed.
    const currentRow = await this.webhooks.find(org.scope);
    let registration: Extract<TelegramWebhookRegistration, { ok: true }> | null = null;
    let registeredWith: string | null = null;
    if (target.deliveryMode === 'webhook' && target.secretId !== null) {
      registeredWith = plan.token ?? (await this.tokenOf(org.scope, target.secretId));
      registration = await this.registerWebhook(
        target.secretId,
        registeredWith,
        botChanged ? undefined : currentRow,
      );
    }
    const oldWebhookSecret =
      current.deliveryMode === 'webhook' && (botChanged || target.deliveryMode === 'polling')
        ? current.secretId
        : null;
    if (oldWebhookSecret !== null) {
      const oldToken = await this.tokenOf(org.scope, oldWebhookSecret).catch(() => null);
      const removed = oldToken === null ? { ok: true } : await this.registrar.unregister(oldToken);
      if (!removed.ok) {
        await this.undoRegistration(registration, registeredWith);
        throw new AppError('DEPENDENCY_UNAVAILABLE', {
          detail: 'Telegram did not answer; try again later.',
        });
      }
    }

    const context = mutationContextOf(meta, principal.userId);
    const now = new Date();
    try {
      await this.db.withTx(async (tx) => {
        const locked = await this.organizations.lockById(organizationId, tx);
        if (locked === undefined) throw notFound();
        const scope = orgScope(organizationId, tx);
        if (target.secretId !== null && body.telegram_secret_id !== undefined) {
          // Deleted since it was checked: same answer as an unknown one.
          const secret = await this.secrets.findById(scope, target.secretId, { forUpdate: true });
          if (secret?.kind !== 'telegram_bot') throw unknownSecret();
        }
        const before = orgTelegramSettingsOf(locked.settings);
        const after: OrgTelegramSettings = target.secretId === null ? NO_TELEGRAM_BOT : target;
        const changedBot = before.secretId !== after.secretId || before.botId !== after.botId;
        if (
          changedBot &&
          after.botId !== null &&
          (await isNotificationBotOfAnotherOrganization(this.db, tx, organizationId, after.botId))
        ) {
          throw botInUse();
        }
        const unchanged =
          !changedBot &&
          before.botUsername === after.botUsername &&
          before.status === after.status &&
          before.deliveryMode === after.deliveryMode &&
          (registration === null || registration.unchanged);
        if (unchanged) return;
        await this.organizations.update(
          organizationId,
          { settings: withOrgTelegramSettings(locked.settings, after) },
          tx,
        );
        if (changedBot) await resetChannelsForNewBot(this.db, tx, organizationId, now);
        if (registration !== null) await this.webhooks.upsert(scope, registration.webhook);
        else await this.webhooks.delete(scope);
        if (
          before.deliveryMode === 'webhook' &&
          after.deliveryMode === 'polling' &&
          after.secretId !== null &&
          !changedBot &&
          (await this.tokens.hasPendingForBot(scope, after.secretId, now))
        ) {
          // Back to polling with links waiting: the poller takes over at once.
          await enqueueTelegramPoll(tx, organizationId, after.secretId);
        }
        const beforeJson = botSnapshot(before);
        const afterJson = botSnapshot(after);
        const changes = diffOf(beforeJson, afterJson);
        if (Object.keys(changes).length === 0) return; // Status refreshed only: not an org change.
        await recordChange(tx, {
          type: 'org.updated',
          organizationId,
          entityType: 'org',
          entityId: organizationId,
          context,
          before: { settings: { notifications: beforeJson } },
          after: { settings: { notifications: afterJson } },
          changes: Object.fromEntries(
            Object.entries(changes).map(([key, change]) => [
              `settings.notifications.${key}`,
              change,
            ]),
          ),
        });
      });
    } catch (error) {
      await this.undoRegistration(registration, registeredWith);
      throw error;
    }
    return this.orgDto(await this.botOf(organizationId), organizationId);
  }

  // --- The caller's own channels -----------------------------------------

  async listMine(principal: Principal, organizationId: Id<'org'>): Promise<UserChannelListDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const bot = await this.botOf(organizationId);
    const rows = await this.channels.listForUser(org.scope, principal.userId);
    const pending =
      bot.secretId === null
        ? []
        : (await this.tokens.listPendingForUser(org.scope, principal.userId, new Date())).filter(
            (token) => token.secret_id === bot.secretId,
          );
    // `telegram` is the only kind of channel so far.
    const telegram = rows[0];
    const items: UserChannelDto[] = [];
    const item = this.telegramItem(telegram, pending.length > 0, bot);
    if (item !== null) items.push(item);
    return { items, available_kinds: this.linkable(bot) ? ['telegram'] : [] };
  }

  async createTelegramLink(
    principal: Principal,
    organizationId: Id<'org'>,
  ): Promise<TelegramLinkDto> {
    await this.access.requireOrg(principal, organizationId);
    const bot = await this.botOf(organizationId);
    if (!this.linkable(bot) || bot.secretId === null || bot.botUsername === null) {
      throw new AppError('TELEGRAM_NOT_CONFIGURED', {
        detail: 'This organization has no Telegram bot for notifications.',
      });
    }
    const { secretId, botUsername } = bot;
    const token = newLinkToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TOKEN_TTL_MS);
    await this.db.withTx(async (tx) => {
      const scope = orgScope(organizationId, tx);
      // One creation at a time per member, so the hourly limit holds under concurrency.
      const lockKey = `telegram-link:${organizationId}:${principal.userId}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(tx);
      const since = new Date(now.getTime() - HOUR_MS);
      const created = await this.tokens.countCreatedSince(scope, principal.userId, since);
      if (created >= TELEGRAM_LINK_CREATIONS_PER_HOUR) {
        const oldest = await this.tokens.oldestCreatedSince(scope, principal.userId, since);
        const retryAfterSeconds =
          oldest === undefined ? 60 : (oldest.getTime() + HOUR_MS - now.getTime()) / 1000;
        throw new AppError('RATE_LIMITED', {
          detail: `At most ${String(TELEGRAM_LINK_CREATIONS_PER_HOUR)} Telegram links per hour.`,
          retryAfterSeconds,
        });
      }
      await this.tokens.deleteSettledBefore(scope, principal.userId, since, now);
      await this.tokens.cancelPendingBeyond(
        scope,
        principal.userId,
        TELEGRAM_LINK_TOKENS_MAX_PENDING - 1,
        now,
      );
      await this.tokens.insert(scope, {
        tokenHash: hashToken(token),
        userId: principal.userId,
        secretId,
        createdAt: now,
        expiresAt,
      });
      // Webhook mode (T609): Telegram calls the webhook route, nothing to poll.
      if (bot.deliveryMode !== 'webhook') await enqueueTelegramPoll(tx, organizationId, secretId);
    });
    return { link: telegramStartLink(botUsername, token), expires_at: iso(expiresAt) };
  }

  async unlinkTelegram(
    principal: Principal,
    organizationId: Id<'org'>,
    meta: RequestMeta,
  ): Promise<void> {
    await this.access.requireOrg(principal, organizationId);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = orgScope(organizationId, tx);
      await this.tokens.cancelPending(scope, principal.userId, new Date());
      const removed = await this.channels.deleteForUser(scope, principal.userId, 'telegram');
      if (removed === undefined) return;
      await auditUserChannel(tx, {
        action: 'user_channel.unlinked',
        organizationId,
        userId: principal.userId,
        kind: 'telegram',
        source: 'api',
        context,
      });
      await publishChannelChanged(this.db, tx, {
        organizationId,
        userId: principal.userId,
        kind: 'telegram',
        status: 'unlinked',
      });
    });
  }

  // --- Internals ---------------------------------------------------------

  private async botOf(organizationId: Id<'org'>): Promise<OrgTelegramSettings> {
    const organization = await this.organizations.findById(organizationId);
    if (organization === undefined) throw notFound();
    return orgTelegramSettingsOf(organization.settings);
  }

  /** Members can link when the organization has a bot whose username is known. */
  private linkable(bot: OrgTelegramSettings): boolean {
    return bot.secretId !== null && bot.botUsername !== null;
  }

  private async orgDto(
    bot: OrgTelegramSettings,
    organizationId: Id<'org'>,
  ): Promise<OrgNotificationChannelsDto> {
    const webhook =
      bot.secretId !== null && bot.deliveryMode === 'webhook'
        ? await this.webhooks.find(orgScope(organizationId))
        : undefined;
    return {
      telegram: {
        secret_id: bot.secretId,
        bot_username: bot.secretId === null ? null : bot.botUsername,
        status: bot.secretId === null ? null : bot.status,
        delivery_mode: bot.secretId === null ? null : (bot.deliveryMode ?? 'polling'),
        webhook_status: webhook === undefined ? null : webhook.status,
        // T616: known before choosing the mode (the instance's `PUBLIC_URL`, not the bot).
        webhook_available: this.registrar.prefix() !== null,
      },
    };
  }

  /**
   * The bot and delivery mode a `PATCH` asks for: a new secret is checked
   * with `getMe` (its token kept for the webhook calls); without a bot,
   * `webhook` is refused and the mode is `polling`; `webhook` needs an https
   * `PUBLIC_URL` on a port Telegram accepts.
   */
  private async targetOf(
    scope: OrgScope,
    current: OrgTelegramSettings,
    body: UpdateOrgNotificationChannelsInput,
  ): Promise<{ target: OrgTelegramSettings; botChanged: boolean; token: string | null }> {
    let target: OrgTelegramSettings = current;
    let token: string | null = null;
    if (body.telegram_secret_id === null) {
      target = NO_TELEGRAM_BOT;
    } else if (body.telegram_secret_id !== undefined) {
      const secret = await this.secrets.findById(scope, body.telegram_secret_id);
      if (secret?.kind !== 'telegram_bot') throw unknownSecret();
      const bot = await this.checkBot(secret);
      token = bot.token;
      target = {
        secretId: body.telegram_secret_id,
        botId: bot.botId,
        botUsername: bot.username,
        status: 'ok',
        deliveryMode: current.deliveryMode ?? 'polling',
      };
    }
    const botChanged = target.secretId !== current.secretId || target.botId !== current.botId;
    const mode = body.telegram_delivery_mode ?? target.deliveryMode ?? 'polling';
    if (target.secretId === null) {
      if (body.telegram_delivery_mode === 'webhook') {
        throw new AppError('TELEGRAM_NOT_CONFIGURED', {
          detail: 'Choose a notification bot before its webhook mode.',
        });
      }
      return { target: NO_TELEGRAM_BOT, botChanged, token };
    }
    if (mode === 'webhook' && this.registrar.prefix() === null) {
      throw invalidField(
        'telegram_delivery_mode',
        PUBLIC_URL_NOT_HTTPS,
        'The webhook mode needs PUBLIC_URL to be https on port 443, 80, 88 or 8443.',
      );
    }
    // Switching mode is a fresh observation: the poller or the webhook check sets it again.
    const status = mode !== (current.deliveryMode ?? 'polling') ? 'ok' : target.status;
    return { target: { ...target, deliveryMode: mode, status }, botChanged, token };
  }

  /** `register` of the webhook, its failures as API errors. */
  private async registerWebhook(
    secretId: Id<'sec'>,
    token: string,
    current: TelegramWebhookRow | undefined,
  ): Promise<Extract<TelegramWebhookRegistration, { ok: true }>> {
    const registration = await this.registrar.register(secretId, token, current);
    if (registration.ok) return registration;
    switch (registration.reason) {
      case 'public_url_not_https':
        throw invalidField(
          'telegram_delivery_mode',
          PUBLIC_URL_NOT_HTTPS,
          'The webhook mode needs PUBLIC_URL to be https on port 443, 80, 88 or 8443.',
        );
      case 'conflict':
        throw invalidField(
          'telegram_delivery_mode',
          TELEGRAM_WEBHOOK_CONFLICT,
          'This bot already has a webhook pointing elsewhere: remove it there, or use another bot.',
        );
      case 'unauthorized':
        throw invalidField(
          'telegram_secret_id',
          INVALID_BOT_TOKEN,
          'Telegram does not accept the token of this bot.',
        );
      case 'unavailable':
        throw new AppError('DEPENDENCY_UNAVAILABLE', {
          detail: 'Telegram did not answer; try again later.',
          ...(registration.retryAfterMs === undefined
            ? {}
            : { retryAfterSeconds: registration.retryAfterMs / 1000 }),
        });
    }
  }

  /** Best effort: removes a webhook this request set when the request fails afterwards. */
  private async undoRegistration(
    registration: Extract<TelegramWebhookRegistration, { ok: true }> | null,
    token: string | null,
  ): Promise<void> {
    if (registration === null || registration.unchanged || token === null) return;
    await this.registrar.unregister(token).catch(() => undefined);
  }

  /** The token of a `telegram_bot` secret of the organization, unsealed in memory. */
  private async tokenOf(scope: OrgScope, secretId: Id<'sec'>): Promise<string> {
    const secret = await this.secrets.findById(scope, secretId);
    let token = '';
    if (secret?.kind === 'telegram_bot') {
      try {
        token = unsealSecret(this.secretKey, secret.ciphertext);
      } catch {
        token = '';
      }
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      throw invalidField(
        'telegram_secret_id',
        INVALID_BOT_TOKEN,
        'The token of this bot cannot be used: enter it again.',
      );
    }
    return token;
  }

  private telegramItem(
    row: UserChannelState | undefined,
    pending: boolean,
    bot: OrgTelegramSettings,
  ): UserChannelDto | null {
    const username = this.linkable(bot) ? bot.botUsername : null;
    if (row !== undefined) {
      // A chat linked through another bot than the current one cannot be reached any more.
      const stale = row.status === 'linked' && row.secret_id !== bot.secretId;
      const status = row.status === 'linked' && !stale ? 'linked' : 'error';
      if (status === 'error' && pending) return this.pendingItem(username);
      return {
        kind: 'telegram',
        status,
        error_reason: status === 'linked' ? null : stale ? 'bot_changed' : row.error_reason,
        linked_at: iso(row.linked_at),
        bot_username: username,
      };
    }
    return pending ? this.pendingItem(username) : null;
  }

  private pendingItem(username: string | null): UserChannelDto {
    return {
      kind: 'telegram',
      status: 'pending',
      error_reason: null,
      linked_at: null,
      bot_username: username,
    };
  }

  /**
   * `getMe` with the secret's token: `INVALID_BOT_TOKEN` when Telegram does
   * not know it, `503` when Telegram does not answer. The token never leaves
   * this function.
   */
  private async checkBot(
    secret: SecretRow,
  ): Promise<{ botId: number; username: string; token: string }> {
    let token: string;
    try {
      token = unsealSecret(this.secretKey, secret.ciphertext);
    } catch {
      token = '';
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      throw invalidField(
        'telegram_secret_id',
        INVALID_BOT_TOKEN,
        'The token of this bot cannot be used: enter it again.',
      );
    }
    const me = await this.telegram.getMe(token);
    if (me.ok) return { botId: me.botId, username: me.username, token };
    if (me.kind === 'unauthorized') {
      throw invalidField(
        'telegram_secret_id',
        INVALID_BOT_TOKEN,
        'Telegram does not accept the token of this bot.',
      );
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE', {
      detail: 'Telegram did not answer; try again later.',
      ...(me.kind === 'rate_limited' ? { retryAfterSeconds: me.retryAfterMs / 1000 } : {}),
    });
  }
}
