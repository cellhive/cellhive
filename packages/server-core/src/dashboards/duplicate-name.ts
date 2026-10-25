import { MAX_DASHBOARD_NAME_LENGTH } from '@cellhive/contracts';

import { DUPLICATE_NAME_SUFFIXES } from '../automation/duplicate/duplicate.js';

/** `vi` for a Vietnamese locale (`vi`, `vi-VN`…), `en` otherwise. */
function languageOf(locale: string | null | undefined): keyof typeof DUPLICATE_NAME_SUFFIXES {
  return typeof locale === 'string' && /^vi(?:[-_]|$)/iu.test(locale) ? 'vi' : 'en';
}

/** `name` cut (whole characters, trailing spaces dropped) to leave room for `suffix`. */
function withSuffix(name: string, suffix: string): string {
  const room = MAX_DASHBOARD_NAME_LENGTH - suffix.length;
  let kept = '';
  for (const char of name.trim()) {
    if (kept.length + char.length > room) break;
    kept += char;
  }
  return `${kept.trimEnd()}${suffix}`;
}

/**
 * Default name of a dashboard copy (BACKLOG T805): "«name» (copy)" /
 * "«name» (bản sao)" in the caller's language, then "… (copy) 2",
 * "… (copy) 3"… while `taken` says the name is used (ignoring case is the
 * caller's check). Stays within `MAX_DASHBOARD_NAME_LENGTH`.
 */
export function duplicateDashboardName(
  name: string,
  locale: string | null | undefined,
  taken: (candidate: string) => boolean,
): string {
  const suffix = DUPLICATE_NAME_SUFFIXES[languageOf(locale)];
  const first = withSuffix(name, suffix);
  if (!taken(first)) return first;
  for (let n = 2; ; n += 1) {
    const candidate = withSuffix(name, `${suffix} ${String(n)}`);
    if (!taken(candidate)) return candidate;
  }
}
