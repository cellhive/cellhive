import {
  SUBMISSION_LIMIT_REACHED,
  SUBMIT_TOKEN_INVALID,
  SUBMITTED_TOO_FAST,
  type ProblemErrorItem,
  type SubmissionLimit,
} from '@cellhive/contracts';

import { isApiError } from '../../../lib/api/client';

/**
 * Reading the answer to a refused submission (CONTRACTS §17): problems on
 * one question (`errors[].path` = `fields.<field_id>`), the submission
 * limit (`409 SUBMISSION_LIMIT_REACHED`), and the anti-spam token.
 */

const FIELD_PATH = /^fields\.(fld_[A-Za-z0-9]+)(?:$|[.[])/u;

export interface SubmitProblems {
  /** First problem of each question, by field id. */
  readonly fields: Readonly<Record<string, ProblemErrorItem>>;
  /** Problems not tied to a question. */
  readonly other: readonly ProblemErrorItem[];
}

/** Splits `errors[]` of a `422`/`403` between questions and the rest. */
export function splitProblems(errors: readonly ProblemErrorItem[]): SubmitProblems {
  const fields: Record<string, ProblemErrorItem> = {};
  const other: ProblemErrorItem[] = [];
  for (const item of errors) {
    const match = FIELD_PATH.exec(item.path);
    const fieldId = match?.[1];
    if (fieldId === undefined) other.push(item);
    else fields[fieldId] ??= item;
  }
  return { fields, other };
}

export interface LimitReached {
  readonly limit: SubmissionLimit | null;
  /** When this person may submit again; `null` for `once`. */
  readonly nextAllowedAt: string | null;
}

/** `409 SUBMISSION_LIMIT_REACHED` with its `params`, else `null`. */
export function limitReached(error: unknown): LimitReached | null {
  if (!isApiError(error) || error.code !== 'SUBMISSION_LIMIT_REACHED') return null;
  const params = error.errors.find((item) => item.code === SUBMISSION_LIMIT_REACHED)?.params;
  const limit = params?.['limit'];
  const next = params?.['next_allowed_at'];
  return {
    limit:
      limit === 'once' || limit === 'daily' || limit === 'weekly' || limit === 'monthly'
        ? limit
        : null,
    nextAllowedAt: typeof next === 'string' && !Number.isNaN(Date.parse(next)) ? next : null,
  };
}

export type TokenProblem =
  { readonly kind: 'invalid' } | { readonly kind: 'too_fast'; readonly retryAfterMs: number };

/** A refused submit token (`SUBMIT_TOKEN_INVALID` / `SUBMITTED_TOO_FAST`), else `null`. */
export function tokenProblem(error: unknown): TokenProblem | null {
  if (!isApiError(error) || error.status !== 422) return null;
  for (const item of error.errors) {
    if (item.code === SUBMIT_TOKEN_INVALID) return { kind: 'invalid' };
    if (item.code === SUBMITTED_TOO_FAST) {
      const wait = item.params?.['retry_after_ms'];
      return {
        kind: 'too_fast',
        retryAfterMs: typeof wait === 'number' && wait > 0 ? Math.min(wait, 60_000) : 1000,
      };
    }
  }
  return null;
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/**
 * "in 3 days", "in 5 hours", "in 1 minute" in the largest unit that reads
 * well (minutes rounded up), in the UI language.
 */
export function relativeTime(target: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const delta = Math.max(target - now, 0);
  for (const [unit, size] of UNITS) {
    if (delta >= size || unit === 'minute') {
      const count = unit === 'minute' ? Math.ceil(delta / size) : Math.round(delta / size);
      return format.format(Math.max(count, 1), unit);
    }
  }
  return format.format(1, 'minute');
}
