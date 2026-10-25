import type { Id } from '@cellhive/contracts';

/** What a schema change did (`action` of the WS `schema.changed` message, CONTRACTS §7). */
export type SchemaChangeAction = 'created' | 'updated' | 'deleted' | 'restored' | 'converted';

/**
 * One committed schema change, handed to the realtime layer (SPEC §15)
 * **after** the transaction commits. Snake case: it maps one to one onto
 * the WS message `{ "type": "schema.changed", "channel": "table:<table_id>",
 * "entity", "entity_id", "action" }` (CONTRACTS §7); `organization_id` and
 * `base_id` let the gateway route it. It carries ids only: subscribers
 * refetch the schema they may see.
 */
export interface SchemaChange {
  readonly organization_id: Id<'org'>;
  readonly base_id: Id<'bse'>;
  readonly table_id: Id<'tbl'>;
  readonly entity: 'table' | 'field';
  readonly entity_id: Id<'tbl'> | Id<'fld'>;
  readonly action: SchemaChangeAction;
}

/**
 * Hook called by `SchemaService` after each committed schema change.
 * Realtime is best effort: a failing publisher never fails the change (the
 * schema is committed; clients resync on reconnect).
 */
export interface SchemaChangePublisher {
  publish(change: SchemaChange): void | Promise<void>;
}

/** Default publisher until the WS gateway (S2) is wired: drops everything. */
export const noopSchemaChangePublisher: SchemaChangePublisher = {
  publish: () => undefined,
};
