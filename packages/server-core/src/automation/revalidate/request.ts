import { orgScope, withTxScope, type OrgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';
import { AutomationsRepository } from '../repository/automations.repository.js';

import type { Db, Tx } from '../../db/create-db.js';
import type { RunAsAccessCheck } from '../engine/run-engine.js';
import type { Id } from '@cellhive/contracts';

/** Task of the `run_as` check (ADR-25 §5, BACKLOG T507). */
export const REVALIDATE_RUN_AS_TASK = 'automation.revalidate_run_as';

/**
 * Wait before a check requested by a permission change: changes made
 * together (a role saved, then its assignments) share one job
 * (`preserve_run_at`, ADR-18 §5).
 */
export const REVALIDATE_RUN_AS_DEBOUNCE_MS = 2_000;

/**
 * More bases with enabled automations than this in one permission change
 * (an organization role changed, a member left) → one job for the whole
 * organization instead of one per base.
 */
export const REVALIDATE_RUN_AS_MAX_BASE_JOBS = 20;

/** Job key of the check of one base, or of the whole organization. */
export function revalidateRunAsJobKey(target: Id<'bse'> | Id<'org'>): string {
  return `${REVALIDATE_RUN_AS_TASK}:${target}`;
}

/**
 * Queues the `run_as` check (ADR-25 §5 a) of the bases whose
 * `permission_version` just moved — or that left or returned from the
 * trash — in the caller's transaction (`BasesRepository` calls it with
 * every bump: roles, assignments, groups, workspace and organization
 * members, a member removed, base owner, tables and fields). Only bases
 * with an enabled automation get a job, so most changes add none: one job
 * per base (job key per base, debounced), or one for the organization when
 * more than {@link REVALIDATE_RUN_AS_MAX_BASE_JOBS} bases are concerned.
 */
export async function requestRunAsRevalidation(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  baseIds: readonly Id<'bse'>[],
): Promise<number> {
  if (baseIds.length === 0) return 0;
  const concerned = await new AutomationsRepository(db).baseIdsWithEnabled(
    withTxScope(scope, tx),
    baseIds,
  );
  if (concerned.length === 0) return 0;
  const runAt = new Date(Date.now() + REVALIDATE_RUN_AS_DEBOUNCE_MS);
  const targets: (Id<'bse'> | null)[] =
    concerned.length > REVALIDATE_RUN_AS_MAX_BASE_JOBS ? [null] : concerned;
  for (const baseId of targets) {
    await enqueue(
      tx,
      REVALIDATE_RUN_AS_TASK,
      { organization_id: scope.organizationId, base_id: baseId, after: null },
      {
        runAt,
        jobKey: revalidateRunAsJobKey(baseId ?? scope.organizationId),
        jobKeyMode: 'preserve_run_at',
      },
    );
  }
  return targets.length;
}

/**
 * The run engine's hook (ADR-25 §5 b, T505 {@link RunAsAccessCheck}): an
 * action found that `run_as` lost a table, a field or the base, so the run
 * failed `permission_denied` — the base of the automation is checked at
 * once (same job key as a permission change: one pending check per base).
 */
export function runAsRevalidation(db: Db): RunAsAccessCheck {
  return {
    async requestCheck(tx, input) {
      const scope = withTxScope(orgScope(input.organizationId), tx);
      const baseId = await new AutomationsRepository(db).baseIdOf(scope, input.automationId);
      if (baseId === undefined) return;
      await enqueue(
        tx,
        REVALIDATE_RUN_AS_TASK,
        { organization_id: input.organizationId, base_id: baseId, after: null },
        { jobKey: revalidateRunAsJobKey(baseId) },
      );
    },
  };
}
