import { isApiError, type ApiError } from '../api/client';
import { devWarn } from '../dev-log';

import type { ProblemErrorItem } from '@cellhive/contracts';
import type { i18n as I18n, TOptions } from 'i18next';

/** The parts of an i18next instance the translator needs. */
export type Translator = Pick<I18n, 't' | 'exists'>;

export interface TranslatedDetail {
  path: string;
  message: string;
}

export interface TranslatedError {
  /** Main message, translated by `code`. */
  message: string;
  /** One translated line per `errors[]` item. */
  details: TranslatedDetail[];
  /** `req_…` to quote when reporting the problem (FRONTEND §8.1). */
  requestId: string | undefined;
}

export interface TranslateOptions {
  /**
   * Screen-specific wording by code, e.g. `UNAUTHENTICATED` on the sign-in
   * form means "wrong email or password", not "session expired".
   */
  overrides?: Readonly<Record<string, string>>;
}

function translateKey(
  translator: Translator,
  key: string,
  options: TOptions,
  fallback: string | undefined,
): string {
  if (translator.exists(key, options)) return translator.t(key, options);
  devWarn(`Missing translation "${key}"`);
  return fallback ?? translator.t('errors:client.UNEXPECTED_RESPONSE');
}

/**
 * Translates one `errors[]` item by its detail code (`errors:detail.<CODE>`,
 * CONTRACTS §6) with `params`; `origin`/`format`/`reason` select a context variant such as
 * `TOO_SMALL_string` ("at least 10 characters"), `INVALID_FORMAT_email` or
 * `DISPLAY_NAME_NOT_ALLOWED_url`. Unknown codes fall back to
 * the English message of the server.
 */
export function translateDetail(
  translator: Translator,
  item: Pick<ProblemErrorItem, 'code' | 'params'> & { message?: string },
): string {
  const params = item.params ?? {};
  // `origin` (TOO_SMALL/TOO_BIG), `format` (INVALID_FORMAT) or `reason`
  // (T556: DISPLAY_NAME_NOT_ALLOWED, BUTTON_IN_USE of a duplicate) picks a
  // variant; a variant without its own string falls back to the plain code.
  const variant = [params['origin'], params['format'], params['reason']].find(
    (value) => typeof value === 'string',
  );
  const options: TOptions = { ...params, ...(variant === undefined ? {} : { context: variant }) };
  return translateKey(translator, `errors:detail.${item.code}`, options, item.message);
}

/**
 * "Try again in …" for a `Retry-After` in seconds, in the largest unit that
 * reads well (S2 QA: a lockout said "900 seconds"): seconds under a minute,
 * minutes under an hour (rounded up), hours beyond.
 */
export function retryAfterText(translator: Translator, seconds: number): string {
  if (seconds < 60) return translator.t('errors:retryAfter', { count: Math.ceil(seconds) });
  if (seconds < 3600) {
    return translator.t('errors:retryAfterMinutes', { count: Math.ceil(seconds / 60) });
  }
  return translator.t('errors:retryAfterHours', { count: Math.ceil(seconds / 3600) });
}

/**
 * Turns any thrown value into translated text (FRONTEND §8.1): API errors by
 * `code` (+ `errors[].code`), everything else as an unexpected error.
 */
export function translateError(
  error: unknown,
  translator: Translator,
  options: TranslateOptions = {},
): TranslatedError {
  if (!isApiError(error)) {
    return {
      message: translator.t('errors:client.UNEXPECTED_RESPONSE'),
      details: [],
      requestId: undefined,
    };
  }
  const apiError: ApiError = error;
  const override = options.overrides?.[apiError.code];
  const params: TOptions = {
    ...(apiError.retry_after === undefined ? {} : { seconds: apiError.retry_after }),
  };
  const key =
    override ??
    (apiError.code === 'NETWORK_ERROR' || apiError.code === 'UNEXPECTED_RESPONSE'
      ? `errors:client.${apiError.code}`
      : `errors:codes.${apiError.code}`);
  let message = translateKey(translator, key, params, apiError.title);
  if (apiError.retry_after !== undefined && apiError.retry_after > 0) {
    message = `${message} ${retryAfterText(translator, apiError.retry_after)}`;
  }
  return {
    message,
    details: apiError.errors.map((item) => ({
      path: item.path,
      message: translateDetail(translator, item),
    })),
    requestId: apiError.request_id,
  };
}
