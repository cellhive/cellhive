import { useCallback, type BaseSyntheticEvent, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../api/client';
import { translateDetail } from '../errors/translate';

import type { FieldError, FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/** A detail code with parameters, as in `errors[]` of CONTRACTS §6. */
export interface Detail {
  code: string;
  params?: Record<string, unknown>;
}

const DETAIL_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Maps a zod issue to the detail code the server would send for it
 * (`@cellhive/server-core` `zodIssuesToProblemErrors`), so client-side and
 * server-side validation messages share one set of translations.
 */
export function issueToDetail(issue: z.core.$ZodIssue): Detail {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === ''
        ? { code: 'REQUIRED' }
        : { code: `EXPECTED_${issue.expected.toUpperCase()}` };
    case 'too_small':
      return issue.input === '' || (issue.origin === 'string' && issue.minimum === 1)
        ? { code: 'REQUIRED' }
        : {
            code: 'TOO_SMALL',
            params: { minimum: Number(issue.minimum), origin: issue.origin },
          };
    case 'too_big':
      return { code: 'TOO_BIG', params: { maximum: Number(issue.maximum), origin: issue.origin } };
    case 'invalid_format':
      return issue.input === ''
        ? { code: 'REQUIRED' }
        : { code: 'INVALID_FORMAT', params: { format: issue.format } };
    case 'custom': {
      const code: unknown = issue.params?.['code'];
      return { code: typeof code === 'string' && DETAIL_CODE.test(code) ? code : 'INVALID' };
    }
    default:
      return { code: 'INVALID' };
  }
}

/**
 * `onSubmit` for `<form>`: react-hook-form's `handleSubmit` returns a promise
 * that React ignores; errors are handled by the mutation.
 */
export function submitWith(
  handler: (event?: BaseSyntheticEvent) => Promise<void>,
): (event: SyntheticEvent<HTMLFormElement>) => void {
  return (event) => {
    void handler(event);
  };
}

/**
 * react-hook-form stores only strings; the detail is kept as JSON and
 * translated at render time, so switching language re-translates messages.
 */
export function encodeDetail(detail: Detail): string {
  return JSON.stringify(detail);
}

export function decodeDetail(message: string | undefined): Detail | null {
  if (message === undefined || message === '') return null;
  try {
    const value = JSON.parse(message) as unknown;
    if (typeof value === 'object' && value !== null && 'code' in value) {
      return value as Detail;
    }
  } catch {
    // not an encoded detail
  }
  return null;
}

/**
 * A react-hook-form resolver for a zod schema (usually from
 * `@cellhive/contracts`) that yields detail codes instead of English text.
 */
export function zodResolver<T extends FieldValues>(schema: z.ZodType<unknown, T>): Resolver<T> {
  return (values) => {
    // `reportInput` lets empty inputs map to REQUIRED; nothing leaves the browser.
    const result = schema.safeParse(values, { reportInput: true });
    // The parsed (e.g. trimmed) values are what the form submits.
    if (result.success) return { values: result.data as T, errors: {} };
    const errors: Record<string, FieldError> = {};
    for (const issue of result.error.issues) {
      const name = issue.path.map(String).join('.');
      if (name in errors) continue;
      const detail = issueToDetail(issue);
      errors[name] = { type: detail.code, message: encodeDetail(detail) };
    }
    return { values: {}, errors: errors as FieldErrors<T> };
  };
}

/** Translates a field error produced by {@link zodResolver} or {@link applyServerErrors}. */
export function useFieldErrorText(): (error: FieldError | undefined) => string | undefined {
  const { i18n } = useTranslation('errors');
  return useCallback(
    (error) => {
      if (error === undefined) return undefined;
      const detail = decodeDetail(error.message);
      return translateDetail(i18n, detail ?? { code: 'INVALID' });
    },
    [i18n],
  );
}

/**
 * Puts `422 VALIDATION_FAILED` details whose `path` is a form field next to
 * that field. Returns the paths it placed, to leave out of the form alert.
 */
export function applyServerErrors(
  error: unknown,
  fields: readonly string[],
  setError: (name: never, error: { type: string; message: string }) => void,
): string[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_FAILED') return [];
  const placed: string[] = [];
  for (const item of error.errors) {
    if (!fields.includes(item.path) || placed.includes(item.path)) continue;
    const detail: Detail =
      item.params === undefined ? { code: item.code } : { code: item.code, params: item.params };
    setError(item.path as never, { type: 'server', message: encodeDetail(detail) });
    placed.push(item.path);
  }
  return placed;
}
