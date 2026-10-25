import { randomInt } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import process from 'node:process';

import { createQueueLogger, JOB_QUEUE_SCHEMA, migrateJobQueue } from '@cellhive/server-core';
import { makeWorkerUtils } from 'graphile-worker';

import { isWorkerAlive } from './worker-liveness.js';

import type { Logger } from 'pino';

/** Every worker id of Cellhive starts with this (BACKLOG T702, ADR-36 §5). */
export const WORKER_ID_PREFIX = 'ob-';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 8;
/** A DNS label at most; a container hostname is 12 hex characters. */
const MAX_HOST_LENGTH = 63;
const PID_AND_RANDOM = /^([1-9][0-9]{0,9})-([0-9A-Za-z]{8})$/u;

/**
 * The host part of worker ids: `hostname` (default: the machine's — the
 * container id in Docker, the pod name in Kubernetes) with anything other
 * than letters, digits, `.` and `-` replaced by `-`, at most 63 characters.
 */
export function workerHost(hostname: string = osHostname()): string {
  const cleaned = hostname
    .trim()
    .replace(/[^A-Za-z0-9.-]/g, '-')
    .slice(0, MAX_HOST_LENGTH);
  return cleaned === '' ? 'unknown' : cleaned;
}

/** `ob-<host>-`: the prefix shared by every worker process of one host. */
export function workerIdPrefix(host: string): string {
  return `${WORKER_ID_PREFIX}${host}-`;
}

/** `ob-<host>-<pid>-<8 base62>`: the id this process locks jobs with (`locked_by`). */
export function createWorkerId(
  host: string,
  options: { readonly pid?: number; readonly random?: (max: number) => number } = {},
): string {
  const random = options.random ?? ((max: number) => randomInt(max));
  let suffix = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) suffix += BASE62[random(BASE62.length)] ?? '0';
  return `${workerIdPrefix(host)}${String(options.pid ?? process.pid)}-${suffix}`;
}

/**
 * The pid of `lockedBy` when it is a worker id of `host` — exactly
 * `ob-<host>-<pid>-<8 base62>`, so host `a` never claims the ids of host
 * `a-b` — or `null`.
 */
export function workerIdPidOnHost(lockedBy: string, host: string): number | null {
  const prefix = workerIdPrefix(host);
  if (!lockedBy.startsWith(prefix)) return null;
  const match = PID_AND_RANDOM.exec(lockedBy.slice(prefix.length));
  return match === null ? null : Number(match[1]);
}

export interface UnlockDeadWorkersOptions {
  readonly connectionString: string;
  /** This process's id; never unlocked. */
  readonly workerId: string;
  /** `workerHost()` of this process. */
  readonly host: string;
  readonly logger: Logger;
}

export interface UnlockDeadWorkersResult {
  /** Worker ids of this host, other than ours, whose process is gone. */
  readonly workers: readonly string[];
  /** Jobs they held, now unlocked. */
  readonly jobs: number;
}

/**
 * At start, before this process takes any job (BACKLOG T702, ADR-36 §5):
 * jobs locked by another worker id of this host (`ob-<host>-<pid>-…`)
 * whose process is dead — its liveness advisory lock (`WorkerLivenessLock`)
 * is free — are unlocked at once through graphile-worker's public
 * `forceUnlockWorkers` instead of waiting for its 4-hour lock timeout. A
 * live process (e.g. the api with `MODE=all` next to `apps/worker` in
 * `pnpm dev`, or another container of the same pod in its own PID
 * namespace) still holds its lock and keeps its jobs. Workers of other
 * hosts are never considered (defence in depth: they keep the 4-hour
 * mark). Reads only `locked_by` of graphile-worker's public `jobs` view —
 * no payload, no tenant data. Logs the counts.
 */
export async function unlockDeadWorkersOfHost(
  options: UnlockDeadWorkersOptions,
): Promise<UnlockDeadWorkersResult> {
  const logger = options.logger.child({ component: 'job-queue' });
  // The view must exist before it is read (a no-op when up to date; `run` does it too).
  await migrateJobQueue({ connectionString: options.connectionString, logger });
  const utils = await makeWorkerUtils({
    connectionString: options.connectionString,
    schema: JOB_QUEUE_SCHEMA,
    logger: createQueueLogger(logger),
  });
  try {
    // One connection: each probe takes and releases a lock in the same session.
    const { dead, alive } = await utils.withPgClient(async (client) => {
      const { rows } = await client.query<{ locked_by: string; jobs: number }>(
        `SELECT locked_by, count(*)::int AS jobs
           FROM ${client.escapeIdentifier(JOB_QUEUE_SCHEMA)}.jobs
          WHERE starts_with(locked_by, $1) AND locked_by <> $2
          GROUP BY locked_by
          ORDER BY locked_by`,
        [workerIdPrefix(options.host), options.workerId],
      );
      const found: { locked_by: string; jobs: number }[] = [];
      let live = 0;
      for (const row of rows) {
        if (workerIdPidOnHost(row.locked_by, options.host) === null) continue;
        if (await isWorkerAlive(client, row.locked_by)) live += 1;
        else found.push(row);
      }
      return { dead: found, alive: live };
    });
    const workers = dead.map((row) => row.locked_by);
    const jobs = dead.reduce((sum, row) => sum + row.jobs, 0);
    if (workers.length > 0) await utils.forceUnlockWorkers([...workers]);
    options.logger.info(
      { worker_id: options.workerId, dead_workers: workers.length, live_workers: alive, jobs },
      'jobs of dead workers on this host unlocked',
    );
    return { workers, jobs };
  } finally {
    await utils.release();
  }
}
