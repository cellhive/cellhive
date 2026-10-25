import {
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_POLL_JOB_MAX_MS,
  TELEGRAM_POLL_TIMEOUT_SECONDS,
  type Id,
} from '@cellhive/contracts';
import { sql } from 'kysely';

import { deriveSecretKey, unsealSecret } from '../../../auth/secret-box.js';
import {
  TelegramBotApi,
  type TelegramUpdate,
} from '../../../automation/actions/send-telegram/telegram-bot-api.js';
import { OrganizationsRepository } from '../../../db/repositories/organizations.repository.js';
import { orgScope } from '../../../db/repository.js';
import { SecretsRepository } from '../../../secrets/secrets.repository.js';
import { UserChannelLinkTokensRepository } from '../user-channel-link-tokens.repository.js';

import { setNotificationBotStatus } from './notification-bot.js';
import { orgTelegramSettingsOf } from './org-telegram-settings.js';
import { TelegramUpdateHandler, type TelegramBotContext } from './telegram-update-handler.js';

import type { TelegramClientOptions } from '../../../automation/actions/send-telegram/telegram-client.js';
import type { Db } from '../../../db/create-db.js';
import type { AccessDefaults } from '../../../import/member-access.js';
import type { Buffer } from 'node:buffer';

/**
 * Receives `/start <token>` and `/stop` for one notification bot (BACKLOG
 * T549, ADR-34 §3; T609, ADR-35 §7): the work of one
 * `notifications.telegram_poll` job, or of one sparse poll
 * (`notifications.telegram_sparse_poll`, `{ sparse: true }`).
 *
 * 1. Only one poller per bot at a time: a session advisory lock on a
 *    dedicated connection (`telegram-poll:<secret id>`); held → `busy`.
 *    Telegram itself refuses two `getUpdates` of one bot (`409`).
 * 2. The secret must still be the organization's notification bot, in
 *    `polling` mode (`webhook` → `webhook_mode`, nothing called); its
 *    token is unsealed in memory only.
 * 3. `getUpdates` long polls (≤ 25 s each) while links of this bot are
 *    pending and for at most ~55 s — or, sparse, one call that does not
 *    wait (QA S5b M4: `/stop` without pending links within 15 minutes);
 *    every update is confirmed (`offset`), the unrelated ones included; on
 *    the way out the last offset is confirmed with a non-waiting call.
 * 4. Each update goes to `TelegramUpdateHandler` (the same as the webhook
 *    route): link, unlink, and the reply queued as
 *    `notifications.telegram_reply` — sent through the bot's pacers and the
 *    "not valid" cap per chat (QA S5b M5), never from here.
 * 5. `409` with a webhook → organization status `webhook_conflict` (no
 *    retry storm: the job ends, the cron tries again in a minute while
 *    links are pending); `401` → `invalid_token`; `429` → wait
 *    `retry_after`; 5xx/timeout → short backoff.
 *
 * Nothing here logs or returns a token, a chat id, a Telegram name or the
 * text of an update: the result only counts.
 */

export interface TelegramLinkPollerOptions {
  /** `APP_MASTER_KEY`: the `org-secret` and `user-channel*` keys are derived from it. */
  readonly masterKey: Buffer | string;
  readonly defaults: AccessDefaults;
  /** Tests only: the fake Bot API. Production uses the fixed host. */
  readonly client?: TelegramClientOptions;
  /** Clock of token expiry and of the job's time budget (tests inject it). */
  readonly now?: () => Date;
  /** Waits (backoff, `retry_after`); tests make it instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Time budget of one job (default {@link TELEGRAM_POLL_JOB_MAX_MS}). */
  readonly maxDurationMs?: number;
  /** Long-poll wait of one `getUpdates` (default {@link TELEGRAM_POLL_TIMEOUT_SECONDS}). */
  readonly pollTimeoutSeconds?: number;
}

export type TelegramPollOutcome =
  /** No link of this bot is pending any more. */
  | 'done'
  /** Links are still pending when the time budget ran out: poll again. */
  | 'continue'
  /** Another poller holds this bot. */
  | 'busy'
  /** The secret is not (or no longer) the organization's notification bot. */
  | 'not_notification_bot'
  /** `409` from a webhook set on the bot elsewhere. */
  | 'webhook_conflict'
  /** `409` from another `getUpdates` consumer outside this instance. */
  | 'conflict'
  /** `401`/`404`, or the token cannot be unsealed. */
  | 'invalid_token'
  /** Another 4xx: the call itself was refused. */
  | 'rejected'
  /** The bot is in `webhook` mode (T609): Telegram calls the webhook route instead. */
  | 'webhook_mode';

export interface TelegramPollResult {
  readonly outcome: TelegramPollOutcome;
  /** Updates received (and confirmed). */
  readonly updates: number;
  readonly linked: number;
  /** `/start` answered "not valid". */
  readonly refused: number;
  /** `/stop` that removed a channel. */
  readonly stopped: number;
  /** Updates of no interest (group chats, other messages). */
  readonly ignored: number;
}

export interface TelegramPollRunOptions {
  /** One `getUpdates` that does not wait, pending links or not (sparse poll, T609). */
  readonly sparse?: boolean;
}

/** Backoff after a 5xx/timeout of `getUpdates`, doubled up to the cap. */
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;
/**
 * Below this budget no new long poll starts. A long poll always waits at
 * least 1 s (the last one may overrun the budget by less than that): calls
 * that do not wait would spin until the end of the budget (QA S5b L1).
 */
const MIN_POLL_BUDGET_MS = 1_000;
/** Non-waiting calls on the way out to confirm the last updates. */
const MAX_CONFIRM_CALLS = 3;

interface Counters {
  updates: number;
  linked: number;
  refused: number;
  stopped: number;
  ignored: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class TelegramLinkPoller {
  readonly #db: Db;
  readonly #options: TelegramLinkPollerOptions;
  readonly #client: TelegramBotApi;
  readonly #secretKey: Buffer;
  readonly #handler: TelegramUpdateHandler;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #secrets: SecretsRepository;
  readonly #tokens: UserChannelLinkTokensRepository;
  readonly #organizations: OrganizationsRepository;

  constructor(db: Db, options: TelegramLinkPollerOptions) {
    this.#db = db;
    this.#options = options;
    this.#client = new TelegramBotApi(options.client);
    this.#secretKey = deriveSecretKey(options.masterKey, 'org-secret');
    this.#now = options.now ?? (() => new Date());
    this.#handler = new TelegramUpdateHandler(db, {
      masterKey: options.masterKey,
      defaults: options.defaults,
      now: this.#now,
    });
    this.#sleep = options.sleep ?? defaultSleep;
    this.#secrets = new SecretsRepository(db);
    this.#tokens = new UserChannelLinkTokensRepository(db);
    this.#organizations = new OrganizationsRepository(db);
  }

  /** One job: polls the bot `secretId` of `organizationId` (see the class comment). */
  async poll(
    organizationId: Id<'org'>,
    secretId: Id<'sec'>,
    run: TelegramPollRunOptions = {},
  ): Promise<TelegramPollResult> {
    const counters: Counters = { updates: 0, linked: 0, refused: 0, stopped: 0, ignored: 0 };
    const lockKey = `telegram-poll:${secretId}`;
    return this.#db.kysely.connection().execute(async (connection) => {
      const { rows } = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked
      `.execute(connection);
      if (rows[0]?.locked !== true) return { outcome: 'busy', ...counters };
      try {
        const outcome = await this.#pollLocked(
          organizationId,
          secretId,
          run.sparse === true,
          counters,
        );
        return { outcome, ...counters };
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(connection);
      }
    });
  }

  async #pollLocked(
    organizationId: Id<'org'>,
    secretId: Id<'sec'>,
    sparse: boolean,
    counters: Counters,
  ): Promise<TelegramPollOutcome> {
    const scope = orgScope(organizationId);
    const organization = await this.#organizations.findById(organizationId);
    if (organization === undefined) return 'not_notification_bot';
    const bot = orgTelegramSettingsOf(organization.settings);
    if (bot.secretId !== secretId) return 'not_notification_bot';
    if (bot.deliveryMode === 'webhook') return 'webhook_mode';
    const secret = await this.#secrets.findById(scope, secretId);
    if (secret?.kind !== 'telegram_bot') return 'not_notification_bot';
    let token: string;
    try {
      token = unsealSecret(this.#secretKey, secret.ciphertext);
    } catch {
      token = '';
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      await setNotificationBotStatus(this.#db, organizationId, secretId, 'invalid_token');
      return 'invalid_token';
    }

    const started = this.#now().getTime();
    const budgetMs = this.#options.maxDurationMs ?? TELEGRAM_POLL_JOB_MAX_MS;
    const pollTimeout = this.#options.pollTimeoutSeconds ?? TELEGRAM_POLL_TIMEOUT_SECONDS;
    const context: TelegramBotContext = { organizationId, secretId };
    let statusSeen = false;
    let offset: number | null = null;
    let confirmed = true;
    let backoff = BACKOFF_START_MS;
    let outcome: TelegramPollOutcome;

    for (let calls = 0; ; calls += 1) {
      if (sparse && calls > 0) {
        // Sparse: one call; links still pending are the long poll's job.
        outcome = 'done';
        break;
      }
      if (!sparse && !(await this.#tokens.hasPendingForBot(scope, secretId, this.#now()))) {
        outcome = 'done';
        break;
      }
      const remaining = started + budgetMs - this.#now().getTime();
      if (!sparse && remaining < MIN_POLL_BUDGET_MS) {
        outcome = 'continue';
        break;
      }
      const timeoutSeconds = sparse
        ? 0
        : Math.max(1, Math.min(pollTimeout, Math.floor(remaining / 1000) - 1));
      const result = await this.#client.getUpdates(token, { offset, timeoutSeconds });
      if (result.ok) {
        backoff = BACKOFF_START_MS;
        if (!statusSeen) {
          statusSeen = true;
          await setNotificationBotStatus(this.#db, organizationId, secretId, 'ok');
        }
        for (const update of result.updates) {
          await this.#handle(context, update, counters);
          offset = Math.max(offset ?? 0, update.updateId + 1);
          confirmed = false;
        }
        continue;
      }
      if (result.kind === 'conflict') {
        if (result.reason === 'webhook') {
          await setNotificationBotStatus(this.#db, organizationId, secretId, 'webhook_conflict');
          outcome = 'webhook_conflict';
        } else {
          outcome = 'conflict';
        }
        break;
      }
      if (result.kind === 'unauthorized') {
        await setNotificationBotStatus(this.#db, organizationId, secretId, 'invalid_token');
        outcome = 'invalid_token';
        break;
      }
      if (result.kind === 'rejected') {
        outcome = 'rejected';
        break;
      }
      if (sparse) {
        // Telegram busy or rate limiting: the next sparse poll comes in 15 minutes.
        outcome = 'done';
        break;
      }
      const left = started + budgetMs - this.#now().getTime();
      const wait = result.kind === 'rate_limited' ? result.retryAfterMs : backoff;
      if (result.kind === 'unavailable') backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      if (wait >= left) {
        outcome = 'continue';
        break;
      }
      await this.#sleep(wait);
    }

    // Confirm what was handled, so the next job does not see it again.
    for (let call = 0; call < MAX_CONFIRM_CALLS && !confirmed && offset !== null; call += 1) {
      const result = await this.#client.getUpdates(token, { offset, timeoutSeconds: 0 });
      if (!result.ok) break;
      confirmed = result.updates.length === 0;
      for (const update of result.updates) {
        await this.#handle(context, update, counters);
        offset = Math.max(offset, update.updateId + 1);
      }
    }
    return outcome;
  }

  async #handle(
    context: TelegramBotContext,
    update: TelegramUpdate,
    counters: Counters,
  ): Promise<void> {
    counters.updates += 1;
    const outcome = await this.#handler.handle(context, update);
    if (outcome === 'linked') counters.linked += 1;
    else if (outcome === 'refused') counters.refused += 1;
    else if (outcome === 'stopped') counters.stopped += 1;
    else if (outcome === 'ignored') counters.ignored += 1;
  }
}
