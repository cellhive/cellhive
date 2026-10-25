import { isComputedRow } from '../computed/definition/definition.js';
import { withTxScope, type OrgScope } from '../db/repository.js';
import { FieldsRepository } from '../schema/fields.repository.js';

import { publishRealtime, realtimePublisherOf } from './bus.js';
import { REALTIME_ENVELOPE_VERSION } from './envelope.js';

import type { Db, Tx } from '../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * The base setting `strict_computed_permissions` changed (T457, T459): who
 * sees a formula as `locked` may change for every formula/lookup field of
 * the base, so each gets `schema.changed` (field `updated`, CONTRACTS §7)
 * after `tx` commits — clients refetch the schema (`locked`) and the values
 * they show. Only subscribers who see the field receive it.
 */
export async function publishComputedLocksChanged(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  baseId: Id<'bse'>,
): Promise<void> {
  if (realtimePublisherOf(db) === undefined) return;
  const fields = await new FieldsRepository(db).listActiveByBase(withTxScope(scope, tx), baseId);
  for (const field of fields.filter(isComputedRow)) {
    await publishRealtime(db, tx, {
      v: REALTIME_ENVELOPE_VERSION,
      type: 'schema.changed',
      organization_id: scope.organizationId,
      base_id: baseId,
      table_id: field.table_id,
      entity: 'field',
      entity_id: field.id,
      action: 'updated',
    });
  }
}
