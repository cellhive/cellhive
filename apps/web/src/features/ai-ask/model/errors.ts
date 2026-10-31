import { isApiError } from '../../../lib/api/client';
import { translateError, type Translator } from '../../../lib/errors/translate';

/** Codes with a sentence of the panel (BACKLOG T914); others use `errors:codes`. */
const OWN_ERRORS = [
  'AI_QUOTA_EXCEEDED',
  'AI_TIMEOUT',
  'AI_NOT_CONFIGURED',
  'AI_INVALID_OUTPUT',
  'QUERY_TIMEOUT',
] as const;

/** Worth asking the same question again as it is. */
const RETRYABLE: ReadonlySet<string> = new Set([
  'AI_TIMEOUT',
  'QUERY_TIMEOUT',
  'AI_PROVIDER_ERROR',
  'RATE_LIMITED',
  'NETWORK_ERROR',
]);

export interface AskError {
  readonly message: string;
  /** "Try again" makes sense (a timeout, the provider, a rate limit); not for quota or setup. */
  readonly retry: boolean;
}

/**
 * The sentence of a failed question (T914): quota (with when it resets,
 * from `Retry-After`), timeouts of the AI and of the numbers, AI not set up,
 * no valid plan in 3 tries, too many groups — the rest by code.
 */
export function askErrorOf(error: unknown, translator: Translator): AskError {
  if (!isApiError(error)) {
    return { message: translateError(error, translator).message, retry: true };
  }
  const detail = error.errors[0];
  if (detail?.code === 'WIDGET_TOO_LARGE') {
    return {
      message: translator.t('aiAsk:errors.WIDGET_TOO_LARGE', detail.params ?? {}),
      retry: false,
    };
  }
  const { message } = translateError(error, translator, {
    overrides: Object.fromEntries(OWN_ERRORS.map((code) => [code, `aiAsk:errors.${code}`])),
  });
  return { message, retry: RETRYABLE.has(error.code) || error.status >= 500 };
}
