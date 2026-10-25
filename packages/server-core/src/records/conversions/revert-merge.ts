import { columnTypeOf } from '@cellhive/field-types';
import { sql } from 'kysely';

import { withTxScope, type OrgScope } from '../../db/repository.js';
import { storedDefinitionOf } from '../../schema/conversion-ddl.js';
import { assertDataTableName, assertOldColumnName, DATA_SCHEMA } from '../../schema/names.js';
import { schemaLockKey } from '../../schema/policy.js';

import { valueExpr } from './backfill.js';

import type { Tx } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { FieldConversionsRepository } from '../../schema/field-conversions.repository.js';
import type { TablesRepository } from '../../schema/tables.repository.js';
import type { Id } from '@cellhive/contracts';

/** Values written per statement. */
const MERGE_CHUNK = 5000;

export interface RevertMergeDeps {
  readonly conversions: FieldConversionsRepository;
  readonly tables: TablesRepository;
  readonly lockTimeoutMs: number;
}

/**
 * First step of a revert that keeps later edits (T403, BACKLOG S4 design
 * decision #7): writes the edited cells, converted back to the old type
 * (`previewRevert().keptEdits`), into the conversion's old column, which
 * nobody reads until the revert swaps it back. `SchemaService` then
 * re-checks under its lock that nobody wrote the field since (else the
 * caller merges again). No record event or audit entry: the revert itself
 * is one `field.converted`. Reached only through
 * `RecordMutationService.mergeRevertEdits`. Returns the cells written.
 */
export async function mergeRevertEdits(
  tx: Tx,
  scope: OrgScope,
  deps: RevertMergeDeps,
  jobId: Id<'job'>,
  edits: readonly { readonly id: Id<'rec'>; readonly value: JsonValue }[],
): Promise<number> {
  const txScope = withTxScope(scope, tx);
  const located = await deps.conversions.getByJob(txScope, jobId);
  if (located === undefined || edits.length === 0) return 0;
  const { rows: previous } = await sql<{ previous: string }>`
    SELECT current_setting('lock_timeout') AS previous,
           set_config('lock_timeout', ${`${String(deps.lockTimeoutMs)}ms`}, true)
  `.execute(tx);
  await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(located.table_id)}, 0))`.execute(
    tx,
  );
  await sql`SELECT set_config('lock_timeout', ${previous[0]?.previous ?? '0'}, true)`.execute(tx);
  const conversion = await deps.conversions.lockByJob(txScope, jobId);
  if (conversion?.status !== 'succeeded' || conversion.old_column_name === null) return 0;
  const table = await deps.tables.getById(txScope, conversion.table_id);
  if (table === undefined) return 0;
  const from = storedDefinitionOf(conversion.from_definition);
  const column = sql.id(assertOldColumnName(conversion.old_column_name));
  const expr = valueExpr(from.type, columnTypeOf(from));
  let written = 0;
  for (let start = 0; start < edits.length; start += MERGE_CHUNK) {
    const chunk = edits.slice(start, start + MERGE_CHUNK).map((edit) => ({
      id: edit.id,
      val: edit.value,
    }));
    const result = await sql`
      UPDATE ${sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name))} AS t
         SET ${column} = ${expr}
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(id text, val jsonb)
       WHERE t.__id = v.id
    `.execute(tx);
    written += Number(result.numAffectedRows ?? 0n);
  }
  return written;
}
