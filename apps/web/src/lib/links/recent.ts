import { isId } from '@cellhive/contracts';

import { linkRecentPreferenceKey, readPreference, writePreference } from '../preferences';

/**
 * "Recent" of the link picker (T413, BACKLOG S4 design decision #2): the
 * last records a user linked through a field, on this device, newest
 * first. Only record ids are stored (`cellhive.linkRecent.<userId>.<orgId>.
 * <fieldId>`); the picker asks the API for their titles with the user's
 * rights (`link-candidates { ids }`), so records the user lost access to or
 * that were deleted simply do not come back. Cleared at sign-out
 * (`endPreferenceSession`).
 */

/** Most records remembered per field. */
export const LINK_RECENT_LIMIT = 10;

export interface LinkRecentScope {
  readonly userId: string;
  readonly orgId: string;
  readonly fieldId: string;
}

/** Remembered record ids, newest first (invalid content is ignored). */
export function readLinkRecents(scope: LinkRecentScope): string[] {
  const raw = readPreference(linkRecentPreferenceKey(scope.userId, scope.orgId, scope.fieldId));
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => isId('rec', id)))].slice(
      0,
      LINK_RECENT_LIMIT,
    );
  } catch {
    return [];
  }
}

/** `ids` just linked go first; the list keeps its most recent entries. */
export function mergeLinkRecents(current: readonly string[], ids: readonly string[]): string[] {
  return [...new Set([...ids, ...current])].slice(0, LINK_RECENT_LIMIT);
}

/** Remembers records the user just linked. */
export function rememberLinkRecents(scope: LinkRecentScope, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const next = mergeLinkRecents(readLinkRecents(scope), ids);
  writePreference(
    linkRecentPreferenceKey(scope.userId, scope.orgId, scope.fieldId),
    JSON.stringify(next),
  );
}

/** Drops ids the API did not return any more (deleted, no longer readable). */
export function forgetLinkRecents(scope: LinkRecentScope, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const gone = new Set(ids);
  const next = readLinkRecents(scope).filter((id) => !gone.has(id));
  writePreference(
    linkRecentPreferenceKey(scope.userId, scope.orgId, scope.fieldId),
    next.length === 0 ? null : JSON.stringify(next),
  );
}
