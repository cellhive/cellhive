import { publishRealtime } from '../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../realtime/envelope.js';

import type { Db, Tx } from '../db/create-db.js';
import type { SchemaChangeAction } from '../schema/schema-change-publisher.js';
import type { Id } from '@cellhive/contracts';

/** A committed change of a view, told to the `table:` subscribers who can see it. */
export interface ViewChange {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly viewId: Id<'viw'>;
  /** Owner of a personal view (after the change); `null` for a shared view. */
  readonly ownerId: Id<'usr'> | null;
  readonly action: Exclude<SchemaChangeAction, 'restored'>;
}

/**
 * Publishes `schema.changed` with `entity: "view"` (CONTRACTS §7) once `tx`
 * is committed. The envelope carries the owner of a personal view so that
 * each api instance sends it to that owner only; a shared view reaches the
 * subscribers whose `visible_views` include it.
 */
export async function publishViewChanged(db: Db, tx: Tx, change: ViewChange): Promise<void> {
  await publishRealtime(db, tx, {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'schema.changed',
    organization_id: change.organizationId,
    base_id: change.baseId,
    table_id: change.tableId,
    entity: 'view',
    entity_id: change.viewId,
    action: change.action,
    owner_id: change.ownerId,
  });
}
