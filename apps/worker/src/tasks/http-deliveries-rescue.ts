import {
  listStuckHttpDeliveries,
  orgScope,
  recordHttpDeliveriesRescued,
  rescueHttpDelivery,
  type Db,
  type HttpDeliveryRescue,
} from '@cellhive/server-core';

import type { Id } from '@cellhive/contracts';
import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Deliveries looked at per run (BACKLOG T702); the rest wait for the next minute. */
export const HTTP_DELIVERIES_RESCUE_LIMIT = 500;

export interface HttpDeliveriesRescueDeps {
  readonly db: Db;
  readonly logger: Logger;
  /** Clock of the lookup (tests pin it). */
  readonly now?: () => Date;
  /** Rows per run (tests shrink it); default `HTTP_DELIVERIES_RESCUE_LIMIT`. */
  readonly limit?: number;
}

/**
 * `http.deliveries_rescue` (BACKLOG T702, ADR-36 §5, CONTRACTS §12.2), cron
 * every minute, no payload: deliveries `pending` more than 60 s past their
 * time or `sending` more than 30 s past their lease (cross-tenant lookup
 * `listStuckHttpDeliveries`, ids only, at most 500) get their job
 * `http.deliver` back — per organization, in one transaction of that
 * organization's scope (`rescueHttpDelivery`: `job_key = http:<id>`,
 * `preserve_run_at`, a live job is left alone). The job leases the row as
 * usual (ADR-35 §4), so two rescues at once, or a rescue racing the
 * original job, deliver once. One organization failing does not stop the
 * others. Logs counts and organization ids only.
 */
export function createHttpDeliveriesRescueTask(
  deps: HttpDeliveriesRescueDeps,
): Task<'http.deliveries_rescue'> {
  const now = deps.now ?? (() => new Date());
  return async () => {
    const stuck = await listStuckHttpDeliveries(deps.db.kysely, {
      now: now(),
      limit: deps.limit ?? HTTP_DELIVERIES_RESCUE_LIMIT,
    });
    if (stuck.length === 0) return;
    const byOrg = new Map<Id<'org'>, Id<'hdl'>[]>();
    for (const row of stuck) {
      const ids = byOrg.get(row.organization_id) ?? [];
      ids.push(row.id);
      byOrg.set(row.organization_id, ids);
    }
    const totals: Record<HttpDeliveryRescue | 'failed', number> = {
      queued: 0,
      job_live: 0,
      not_stuck: 0,
      failed: 0,
    };
    for (const [organizationId, ids] of byOrg) {
      const scope = orgScope(organizationId);
      try {
        const counts = await deps.db.withTx(async (tx) => {
          const perOrg: Record<HttpDeliveryRescue, number> = {
            queued: 0,
            job_live: 0,
            not_stuck: 0,
          };
          for (const id of ids) {
            perOrg[await rescueHttpDelivery(deps.db, tx, scope, id)] += 1;
          }
          return perOrg;
        });
        totals.queued += counts.queued;
        totals.job_live += counts.job_live;
        totals.not_stuck += counts.not_stuck;
        recordHttpDeliveriesRescued(counts.queued);
        if (counts.queued > 0) {
          deps.logger.info({ org_id: organizationId, ...counts }, 'http deliveries rescued');
        }
      } catch (err) {
        totals.failed += ids.length;
        // Code and name only: a PostgreSQL error's detail may quote row values.
        const error = err as { code?: unknown; name?: unknown } | null;
        deps.logger.warn(
          {
            org_id: organizationId,
            deliveries: ids.length,
            error_code: typeof error?.code === 'string' ? error.code : null,
            error_name: typeof error?.name === 'string' ? error.name : null,
          },
          'http deliveries rescue failed',
        );
      }
    }
    deps.logger.info(
      { found: stuck.length, organizations: byOrg.size, ...totals },
      'http deliveries rescue done',
    );
  };
}
