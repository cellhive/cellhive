import { aiFieldStateChanges, aiFieldStateSchemaChange } from '@cellhive/server-core';

import type { AppLogger } from '../../common/logging/app-logger.js';
import type { Id } from '@cellhive/contracts';
import type { Db, OrgScope, SchemaChangePublisher } from '@cellhive/server-core';

/**
 * After the commit that resumed AI fields paused by a provider error
 * (`resumeAiProviderPause`: AI settings saved with another provider, or the
 * key's value replaced — BACKLOG T1002, CONTRACTS §29.5): `schema.changed`
 * of each field with its `ai_state` (§7).
 * Best effort, like every schema change: a failed publish is logged, the
 * change stays committed (clients resync on reconnect).
 */
export async function announceAiFieldStates(
  deps: {
    readonly db: Db;
    readonly publisher: SchemaChangePublisher;
    readonly logger: AppLogger;
  },
  scope: OrgScope,
  fieldIds: readonly Id<'fld'>[],
): Promise<void> {
  if (fieldIds.length === 0) return;
  try {
    for (const change of await aiFieldStateChanges(deps.db, scope, fieldIds)) {
      await deps.publisher.publish(aiFieldStateSchemaChange(change));
    }
  } catch (error) {
    deps.logger.warn({ err: error }, 'ai state publish failed');
  }
}
