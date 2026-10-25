/**
 * Prefill through the URL (BACKLOG S3 decision 9, CONTRACTS §17):
 * `?prefill_<field_id>=<text>` starts a question with a value and
 * `&hide_<field_id>=1` hides it. The server does not tell them apart from
 * typed values: hidden values are sent, typecast and validated like others.
 */

export const PREFILL_PREFIX = 'prefill_';
export const HIDE_PREFIX = 'hide_';

const FIELD_ID = /^fld_[A-Za-z0-9]+$/u;

/** Longest prefilled text taken from a URL (a form value never needs more). */
export const MAX_PREFILL_LENGTH = 10_000;

export interface PrefillParams {
  /** Raw text by field id. */
  readonly values: Readonly<Record<string, string>>;
  /** Field ids to hide. */
  readonly hidden: ReadonlySet<string>;
}

/** Reads `prefill_…` / `hide_…` from a query string; other parameters are ignored. */
export function parsePrefill(search: string | undefined): PrefillParams {
  const values: Record<string, string> = {};
  const hidden = new Set<string>();
  if (search === undefined || search === '') return { values, hidden };
  const params = new URLSearchParams(search);
  for (const [key, value] of params) {
    if (key.startsWith(PREFILL_PREFIX)) {
      const fieldId = key.slice(PREFILL_PREFIX.length);
      if (FIELD_ID.test(fieldId)) values[fieldId] = value.slice(0, MAX_PREFILL_LENGTH);
    } else if (key.startsWith(HIDE_PREFIX)) {
      const fieldId = key.slice(HIDE_PREFIX.length);
      if (FIELD_ID.test(fieldId) && (value === '1' || value === 'true')) hidden.add(fieldId);
    }
  }
  return { values, hidden };
}

export interface PrefillEntry {
  readonly fieldId: string;
  readonly value: string;
  readonly hide: boolean;
}

/**
 * `url` with the prefill parameters of `entries` (entries without a value
 * are skipped; existing prefill parameters are replaced).
 */
export function buildPrefillUrl(url: string, entries: readonly PrefillEntry[]): string {
  const target = new URL(url);
  for (const key of [...target.searchParams.keys()]) {
    if (key.startsWith(PREFILL_PREFIX) || key.startsWith(HIDE_PREFIX)) {
      target.searchParams.delete(key);
    }
  }
  for (const entry of entries) {
    if (entry.value === '') continue;
    target.searchParams.append(`${PREFILL_PREFIX}${entry.fieldId}`, entry.value);
    if (entry.hide) target.searchParams.append(`${HIDE_PREFIX}${entry.fieldId}`, '1');
  }
  return target.toString();
}
