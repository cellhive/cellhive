import {
  authOf,
  authUsesBearer,
  authUsesSignature,
  INCOMING_WEBHOOK_RATE_SCHEMA_MAX,
  MAX_INCOMING_WEBHOOK_NAME_LENGTH,
  WEBHOOK_IN_USE,
  type IncomingWebhookAuth,
  type IncomingWebhookUsage,
  type IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';

import { isApiError } from '../../../lib/api/client';

/** A check of the public route a hook can make (CONTRACTS §25.1 `auth`). */
export type AuthCheck = 'signature' | 'bearer';

/** The `auth` left after removing one check (`PATCH { auth }`, `DELETE …/bearer`). */
export function authWithout(auth: IncomingWebhookAuth, check: AuthCheck): IncomingWebhookAuth {
  return authOf(
    check === 'signature' ? false : authUsesSignature(auth),
    check === 'bearer' ? false : authUsesBearer(auth),
  );
}

/** Whether a hook has `check` on. */
export function hasCheck(auth: IncomingWebhookAuth, check: AuthCheck): boolean {
  return check === 'signature' ? authUsesSignature(auth) : authUsesBearer(auth);
}

/**
 * The automations named by `409 WEBHOOK_IN_USE` (`errors[0].params.usages`),
 * or `null` when `error` is something else.
 */
export function usagesOfInUseError(error: unknown): IncomingWebhookUsage[] | null {
  if (!isApiError(error) || error.code !== WEBHOOK_IN_USE) return null;
  for (const item of error.errors) {
    const usages = item.params?.['usages'];
    if (!Array.isArray(usages)) continue;
    return usages.filter(
      (usage): usage is IncomingWebhookUsage =>
        typeof usage === 'object' &&
        usage !== null &&
        typeof (usage as { automation_id?: unknown }).automation_id === 'string',
    );
  }
  return [];
}

/** A value shown once in the "save it now" dialog. */
export interface RevealedSecret {
  readonly kind: 'url' | 'signing_secret' | 'bearer_token';
  readonly value: string;
}

/**
 * What the "shown once" dialog lists for a response that issued secrets:
 * the URL when the hook was just created (it can be read again later, but
 * the sender needs it together with the secret), then each secret issued.
 */
export function revealedSecrets(
  hook: IncomingWebhookWithSecretsDto,
  withUrl: boolean,
): RevealedSecret[] {
  const items: RevealedSecret[] = [];
  if (withUrl) items.push({ kind: 'url', value: hook.url });
  if (hook.signing_secret !== null) {
    items.push({ kind: 'signing_secret', value: hook.signing_secret });
  }
  if (hook.bearer_token !== null) items.push({ kind: 'bearer_token', value: hook.bearer_token });
  return items;
}

/** Client checks of the name and rate fields; keys are i18n keys under `form.errors`. */
export function draftErrors(draft: {
  readonly name: string;
  readonly rate: string;
}): Partial<Record<'name' | 'rate', 'required' | 'tooLong' | 'rate'>> {
  const errors: Partial<Record<'name' | 'rate', 'required' | 'tooLong' | 'rate'>> = {};
  const name = draft.name.trim();
  if (name === '') errors.name = 'required';
  // Same count as the server (zod `max`: UTF-16 code units).
  else if (name.length > MAX_INCOMING_WEBHOOK_NAME_LENGTH) errors.name = 'tooLong';
  const rate = parseRate(draft.rate);
  if (rate === null) errors.rate = 'rate';
  return errors;
}

/** `rate` as an integer 1…1000, or `null` (the instance may allow less: `RATE_LIMIT_TOO_HIGH`). */
export function parseRate(rate: string): number | null {
  const trimmed = rate.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= INCOMING_WEBHOOK_RATE_SCHEMA_MAX ? value : null;
}

/** Byte size with a unit (`B`, `KB`, `MB`; 1 KB = 1 024 B), in the user's number format. */
export function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) {
    return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  }
  const kb = bytes / 1024;
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (kb < 1024) return `${format.format(kb)} KB`;
  return `${format.format(kb / 1024)} MB`;
}

/** A fresh `Idempotency-Key` for a call that issues a secret (CONTRACTS §1.1). */
export function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
