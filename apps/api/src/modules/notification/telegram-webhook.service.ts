import { TELEGRAM_WEBHOOK_MAX_BODY_BYTES } from '@cellhive/contracts';
import {
  sqlStateOf,
  TelegramWebhookReceiver,
  type AppConfig,
  type Db,
  type TelegramWebhookReceipt,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { notFound } from '../../common/access/access.service.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

/** `Retry-After` of a `503`: Telegram retries on its own schedule anyway. */
const RETRY_AFTER_SECONDS = 5;

/**
 * `POST /api/v1/telegram/webhook/:pathToken` (BACKLOG T609, ADR-35 §7,
 * CONTRACTS §22.7) — public, called by Telegram only, not in the public
 * OpenAPI: unknown path token (or a bot no longer in webhook mode) → `404`;
 * wrong `X-Telegram-Bot-Api-Secret-Token` (compared in constant time) →
 * `401`; body over 1 MiB → `413`; otherwise the update is handled in one
 * transaction (`TelegramUpdateHandler`, the poller's logic) and the route
 * answers `200` — also for updates of no interest and invalid link tokens,
 * so Telegram does not send them again. The reply to the user is a queued
 * job, never sent in the request. A database failure → `503` (Telegram
 * sends the update again). Logs the outcome only: never the path token,
 * the secret header or the update.
 */
@Injectable()
export class TelegramWebhookService {
  private readonly receiver: TelegramWebhookReceiver;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.receiver = new TelegramWebhookReceiver(db, {
      masterKey: config.security.appMasterKey,
      defaults: { timeZone: config.defaults.timezone, locale: config.defaults.locale },
    });
  }

  async receive(
    pathToken: string,
    secretHeader: string | undefined,
    contentLength: number | null,
    body: unknown,
  ): Promise<void> {
    let receipt: TelegramWebhookReceipt;
    try {
      receipt = await this.receiver.receive(pathToken, secretHeader, () => {
        if (contentLength !== null && contentLength > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
          throw new AppError('PAYLOAD_TOO_LARGE', {
            detail: `A Telegram update is at most ${String(TELEGRAM_WEBHOOK_MAX_BODY_BYTES)} bytes.`,
          });
        }
        return body;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn(
        { sqlstate: sqlStateOf(error) ?? null, error_class: errorClassOf(error) },
        'telegram webhook update not handled',
      );
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        detail: 'The update could not be stored; Telegram will send it again.',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    if (receipt === 'not_found') throw notFound();
    if (receipt === 'unauthorized') {
      throw new AppError('UNAUTHENTICATED', { detail: 'Not a request of Telegram.' });
    }
    this.logger.debug({ outcome: receipt }, 'telegram webhook update');
  }
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
