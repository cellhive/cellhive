/**
 * UI preferences kept in localStorage (theme, language, last organization,
 * last view of a table, unsaved view changes).
 * Never tokens, secrets or record values (FRONTEND §12). Storage can be
 * unavailable (private mode, blocked site data): reads fall back to `null`
 * and writes are dropped.
 *
 * (S3 QA) What depends on who is signed in — unsaved view changes, the last
 * view of a table, collapsed groups — is kept per user (the user id is part
 * of the key): several people may share a browser. The unsaved view changes
 * of a user are deleted when their session ends (sign-out, session expired).
 */
export const PREFERENCE_KEYS = {
  theme: 'cellhive.theme',
  language: 'cellhive.language',
  lastOrg: 'cellhive.lastOrg',
} as const;

/**
 * Column layout of a table's grid before saved views (T207). Since T310 the
 * layout lives in the view config: the key is read once, turned into
 * unsaved changes of the view being opened, and deleted.
 */
export function gridLayoutPreferenceKey(tableId: string): `cellhive.gridLayout.${string}` {
  return `cellhive.gridLayout.${tableId}`;
}

/**
 * The view a user last opened on this device for a table (FRONTEND §2:
 * `/b/:baseId/t/:tableId` goes there).
 */
export function lastViewPreferenceKey(
  userId: string,
  tableId: string,
): `cellhive.lastView.${string}.${string}` {
  return `cellhive.lastView.${userId}.${tableId}`;
}

const VIEW_DRAFT_PREFIX = 'cellhive.viewDraft.';

/**
 * Unsaved (temporary) changes of a view's config by a user on this device
 * (FRONTEND §3.2): column layout, filter/sort/group (T311). Only view
 * settings, never record values.
 */
export function viewDraftPreferenceKey(
  userId: string,
  viewId: string,
): `cellhive.viewDraft.${string}.${string}` {
  return `${VIEW_DRAFT_PREFIX}${userId}.${viewId}`;
}

/**
 * Collapsed groups of a grouped grid (T312) for one user and view on this
 * device: group keys (field ids and group values), never saved in the view.
 */
export function groupCollapsePreferenceKey(
  userId: string,
  viewId: string,
): `cellhive.groupCollapse.${string}.${string}` {
  return `cellhive.groupCollapse.${userId}.${viewId}`;
}

/**
 * Expanded branches of a sub-record tree (T417) for one user and view on
 * this device: how many levels open by default and the record ids toggled
 * against it — never saved in the view (like collapsed groups).
 */
export function treeExpandPreferenceKey(
  userId: string,
  viewId: string,
): `cellhive.treeExpand.${string}.${string}` {
  return `cellhive.treeExpand.${userId}.${viewId}`;
}

/**
 * The field type conversion whose "done" banner a user closed on this
 * device (T421b): the job id, so that the banner, shown again after a
 * reload while the conversion can be undone, stays closed — and a later
 * conversion of the field shows again.
 */
export function conversionDismissedPreferenceKey(
  userId: string,
  fieldId: string,
): `cellhive.conversionDone.${string}.${string}` {
  return `cellhive.conversionDone.${userId}.${fieldId}`;
}

const LINK_RECENT_PREFIX = 'cellhive.linkRecent.';

/**
 * Records a user recently linked through a link field (T413, BACKLOG S4
 * design decision #2): record ids only — titles are fetched again through
 * the API with the user's rights, so a record they lost access to (or that
 * was deleted) simply drops out. Deleted when the session ends.
 */
export function linkRecentPreferenceKey(
  userId: string,
  orgId: string,
  fieldId: string,
): `cellhive.linkRecent.${string}.${string}.${string}` {
  return `${LINK_RECENT_PREFIX}${userId}.${orgId}.${fieldId}`;
}

export type PreferenceKey =
  | (typeof PREFERENCE_KEYS)[keyof typeof PREFERENCE_KEYS]
  | ReturnType<typeof gridLayoutPreferenceKey>
  | ReturnType<typeof lastViewPreferenceKey>
  | ReturnType<typeof viewDraftPreferenceKey>
  | ReturnType<typeof groupCollapsePreferenceKey>
  | ReturnType<typeof treeExpandPreferenceKey>
  | ReturnType<typeof conversionDismissedPreferenceKey>
  | ReturnType<typeof linkRecentPreferenceKey>;

/** Every key in localStorage (none when storage is unavailable). */
function storedKeys(): string[] {
  try {
    const storage = window.localStorage;
    return Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? '');
  } catch {
    return [];
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

/**
 * Keys of the per-user preferences from before they were per user
 * (`cellhive.viewDraft.<viewId>`, `cellhive.lastView.<tableId>`): whose they
 * were is unknown, so they are deleted rather than given to whoever signs in.
 */
const UNSCOPED_KEY = /^cellhive\.(?:viewDraft|lastView)\.[^.]+$/u;

export function purgeUnscopedPreferences(): void {
  for (const key of storedKeys()) if (UNSCOPED_KEY.test(key)) removeStored(key);
}

/** Deletes a user's unsaved view changes on this device (their session ended). */
export function clearViewDrafts(userId: string): void {
  const prefix = `${VIEW_DRAFT_PREFIX}${userId}.`;
  for (const key of storedKeys()) if (key.startsWith(prefix)) removeStored(key);
}

/** Deletes a user's recently linked records on this device (their session ended, T413). */
export function clearLinkRecents(userId: string): void {
  const prefix = `${LINK_RECENT_PREFIX}${userId}.`;
  for (const key of storedKeys()) if (key.startsWith(prefix)) removeStored(key);
}

let preferenceUserId: string | null = null;
const userListeners = new Set<() => void>();

/** The signed-in user whose preferences are read and written; `null` while unknown. */
export function preferenceUser(): string | null {
  return preferenceUserId;
}

/** Called whenever the signed-in user is known (`me`); in-memory state of another user is dropped. */
export function setPreferenceUser(userId: string | null): void {
  if (userId !== null) purgeUnscopedPreferences();
  if (userId === preferenceUserId) return;
  preferenceUserId = userId;
  for (const listener of [...userListeners]) listener();
}

/** Listens for another signed-in user (or none): what was read for the previous one must go. */
export function onPreferenceUserChange(listener: () => void): () => void {
  userListeners.add(listener);
  return () => {
    userListeners.delete(listener);
  };
}

/**
 * The session ended (sign-out, expired: HTTP `401`, WebSocket `4401`): the
 * user's unsaved view changes and recently linked records are deleted, so
 * no one else signing in on this browser sees them.
 */
export function endPreferenceSession(): void {
  const userId = preferenceUserId;
  if (userId !== null) {
    clearViewDrafts(userId);
    clearLinkRecents(userId);
  }
  setPreferenceUser(null);
}

export function readPreference(key: PreferenceKey): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: PreferenceKey, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}
