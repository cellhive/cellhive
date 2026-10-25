import { isApiError } from '../../../../lib/api/client';

import type { TelegramDeliveryMode } from '@cellhive/contracts';

/*
 * Local copies of `TELEGRAM_DELIVERY_MODES`, `PUBLIC_URL_NOT_HTTPS` and
 * `TELEGRAM_WEBHOOK_CONFLICT` (`@cellhive/contracts`, pinned equal by the
 * unit test): importing the values would add them to the shared contracts
 * chunk of the app shell (FRONTEND §11.1 budget), types cost nothing.
 */
/** How the notification bot receives updates, polling (the default) first. */
export const DELIVERY_MODES = [
  'polling',
  'webhook',
] as const satisfies readonly TelegramDeliveryMode[];
export const PUBLIC_URL_NOT_HTTPS_CODE = 'PUBLIC_URL_NOT_HTTPS';
export const WEBHOOK_CONFLICT_CODE = 'TELEGRAM_WEBHOOK_CONFLICT';

/**
 * Why switching the notification bot to the webhook mode was refused, when
 * the screen has guidance for it (BACKLOG T614, CONTRACTS §22.7):
 * `public_url` — `PUBLIC_URL` is not `https` on a port Telegram delivers to
 * (the server never says so beforehand, so the option is turned off for the
 * rest of the visit once it answered this); `conflict` — the bot already has
 * a webhook pointing elsewhere, which Cellhive never overwrites. Anything
 * else is shown as the translated problem (`ErrorAlert`).
 */
export type DeliveryModeError = 'public_url' | 'conflict';

export function deliveryModeErrorOf(error: unknown): DeliveryModeError | null {
  if (!isApiError(error) || error.status !== 422) return null;
  if (error.errors.some((item) => item.code === PUBLIC_URL_NOT_HTTPS_CODE)) return 'public_url';
  if (error.errors.some((item) => item.code === WEBHOOK_CONFLICT_CODE)) return 'conflict';
  return null;
}

/**
 * Whether a save of the bot's token moved the notification bot back to
 * `polling` (T609: a token of another bot while in `webhook` mode drops the
 * webhook) — the page then tells the admin to turn the webhook on again.
 */
export function fellBackToPolling(
  before: TelegramDeliveryMode | null | undefined,
  after: TelegramDeliveryMode | null | undefined,
): boolean {
  return before === 'webhook' && after === 'polling';
}
