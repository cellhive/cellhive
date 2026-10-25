import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * `meta.automation_time_cursors` (migration 0033, BACKLOG T508): per
 * automation with a time trigger, the end of the window the scanner already
 * handled. Read under a row lock and moved forward in the same transaction
 * as the runs of the window, so two ticks never handle one window twice and
 * a stopped worker resumes where it stopped. Scoped by `organization_id`.
 */
export class AutomationTimeCursorsRepository
  extends TenantRepository<'automation_time_cursors'>
  implements TenantRepositoryContract<AutomationTimeCursorsRepository>
{
  constructor(db: Db) {
    super(db, 'automation_time_cursors');
  }

  /**
   * The cursor of an automation, locked until the transaction ends; created
   * at `initial` when missing (the first scan). Needs a transaction scope.
   */
  async lock(scope: OrgScope, automationId: Id<'aut'>, initial: Date): Promise<Date> {
    if (scope.tx === undefined) throw new TypeError('lock needs a transaction scope');
    const { rows } = await sql<{ scanned_until: Date }>`
      INSERT INTO meta.automation_time_cursors AS c (organization_id, automation_id, scanned_until)
      VALUES (${scope.organizationId}, ${automationId}, ${initial})
      ON CONFLICT (automation_id) DO UPDATE SET scanned_until = c.scanned_until
       WHERE c.organization_id = excluded.organization_id
      RETURNING scanned_until
    `.execute(this.executor(scope));
    const row = rows[0];
    if (row === undefined) throw new Error('automation time cursor of another organization');
    return row.scanned_until;
  }

  /** Moves the cursor of an automation to `until` (never backwards). */
  async advance(scope: OrgScope, automationId: Id<'aut'>, until: Date): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_time_cursors')
      .set({ scanned_until: sql<Date>`greatest(scanned_until, ${until}::timestamptz)` })
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .execute();
  }

  /** The cursor of an automation, if any (tests, diagnostics). */
  async get(scope: OrgScope, automationId: Id<'aut'>): Promise<Date | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.automation_time_cursors')
      .select('scanned_until')
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .executeTakeFirst();
    return row?.scanned_until;
  }
}
