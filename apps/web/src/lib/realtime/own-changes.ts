/**
 * Schema changes this tab made itself (S2 QA: one field created from a tab
 * cost ~14 requests — the mutation refetched the table, then the
 * `schema.changed` and `permission.changed` it caused refetched it again).
 * A schema mutation announces the messages it will cause; the channel
 * handlers (`channels.ts`) skip that many, since the mutation already
 * refetched exactly what changed. Announcements expire, so a message that
 * never comes (socket down) cannot swallow someone else's change for long.
 */

/** How long an announced message is waited for, ms. */
export const OWN_CHANGE_TTL_MS = 5000;

interface Expected {
  schema: number;
  permission: number;
  readonly until: number;
}

const expected = new Map<string, Expected>();

function live(tableId: string, now: number): Expected | undefined {
  const entry = expected.get(tableId);
  if (entry === undefined) return undefined;
  if (entry.until < now || (entry.schema <= 0 && entry.permission <= 0)) {
    expected.delete(tableId);
    return undefined;
  }
  return entry;
}

/**
 * Before a schema request of this tab on `tableId`: it will cause `schema`
 * `schema.changed` messages on `table:{id}` and `permission` `permission.changed`
 * on the base (creating, deleting or restoring a field bumps `permission_version`).
 */
export function expectOwnSchemaChange(
  tableId: string,
  counts: { readonly schema: number; readonly permission: number },
  now = Date.now(),
): void {
  const current = live(tableId, now);
  expected.set(tableId, {
    schema: (current?.schema ?? 0) + counts.schema,
    permission: (current?.permission ?? 0) + counts.permission,
    until: now + OWN_CHANGE_TTL_MS,
  });
}

/** The announced request failed: it causes no message. */
export function retractOwnSchemaChange(
  tableId: string,
  counts: { readonly schema: number; readonly permission: number },
  now = Date.now(),
): void {
  const entry = live(tableId, now);
  if (entry === undefined) return;
  entry.schema = Math.max(0, entry.schema - counts.schema);
  entry.permission = Math.max(0, entry.permission - counts.permission);
}

/** A `schema.changed` on `table:{id}` announced by this tab: consumed, `true`. */
export function takeOwnSchemaChange(tableId: string, now = Date.now()): boolean {
  const entry = live(tableId, now);
  if (entry === undefined || entry.schema <= 0) return false;
  entry.schema -= 1;
  return true;
}

/** A `permission.changed` on a base announced by this tab for one of its tables: consumed, `true`. */
export function takeOwnPermissionChange(tableIds: readonly string[], now = Date.now()): boolean {
  for (const tableId of tableIds) {
    const entry = live(tableId, now);
    if (entry !== undefined && entry.permission > 0) {
      entry.permission -= 1;
      return true;
    }
  }
  return false;
}

/** Forgets every announcement (tests). */
export function resetOwnChanges(): void {
  expected.clear();
}
