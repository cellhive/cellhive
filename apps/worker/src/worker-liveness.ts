import { createHash } from 'node:crypto';

import pg from 'pg';

import type { Logger } from 'pino';

/** `application_name` of the connection that holds a worker's liveness lock. */
export const WORKER_LIVENESS_APPLICATION_NAME = 'cellhive-worker-liveness';

/** Wait before reconnecting after the liveness connection dropped. */
const RECONNECT_DELAY_MS = 1_000;

/**
 * Key of the session advisory lock that says "worker `workerId` is alive"
 * (T702): the first 8 bytes of its SHA-256 as a signed 64-bit integer. A
 * collision with another id only ever makes that one look alive (safe).
 */
export function workerLivenessKey(workerId: string): string {
  return createHash('sha256').update(workerId).digest().readBigInt64BE(0).toString();
}

/** Thrown when another session already holds the key of a new worker id. */
export class WorkerLivenessTakenError extends Error {
  constructor() {
    super('worker liveness lock already held');
    this.name = 'WorkerLivenessTakenError';
  }
}

export interface WorkerLivenessOptions {
  readonly connectionString: string;
  readonly workerId: string;
  readonly logger: Logger;
  /** Tests shorten it. */
  readonly reconnectDelayMs?: number;
}

/**
 * Proof of life of one worker process in PostgreSQL (T702, ADR-36 §5):
 * a session-level advisory lock on `workerLivenessKey(workerId)`, held on
 * a dedicated connection for the life of the runner. The server drops it
 * when the process dies (its socket closes), so another worker starting on
 * the same host can tell a dead worker from a live one whatever PID
 * namespace either runs in. If the connection drops while we live, it is
 * reopened and the lock taken again (logged).
 */
export class WorkerLivenessLock {
  private client: pg.Client | null = null;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly key: string;
  private readonly delayMs: number;

  private constructor(private readonly options: WorkerLivenessOptions) {
    this.key = workerLivenessKey(options.workerId);
    this.delayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  }

  /** Takes the lock; `WorkerLivenessTakenError` when the key is held already. */
  static async acquire(options: WorkerLivenessOptions): Promise<WorkerLivenessLock> {
    const lock = new WorkerLivenessLock(options);
    if (!(await lock.connect())) {
      await lock.close();
      throw new WorkerLivenessTakenError();
    }
    return lock;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    // Ending the session releases the advisory lock.
    await client?.end().catch(() => undefined);
  }

  /** Opens a connection and tries the lock; `false` when another session holds it. */
  private async connect(): Promise<boolean> {
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      application_name: WORKER_LIVENESS_APPLICATION_NAME,
    });
    let lost = false;
    const onLost = (): void => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = null;
      this.reconnectLater(true);
    };
    client.on('error', onLost);
    try {
      await client.connect();
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS ok',
        [this.key],
      );
      if (rows[0]?.ok !== true) {
        lost = true;
        await client.end().catch(() => undefined);
        return false;
      }
    } catch (err) {
      lost = true;
      await client.end().catch(() => undefined);
      throw err;
    }
    client.on('end', onLost);
    if (this.closed) {
      lost = true;
      await client.end().catch(() => undefined);
      return true;
    }
    this.client = client;
    return true;
  }

  private reconnectLater(first: boolean): void {
    if (this.closed || this.timer !== null) return;
    if (first) {
      this.options.logger.warn(
        { worker_id: this.options.workerId },
        'worker liveness lock lost, reacquiring',
      );
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      this.connect().then(
        (ok) => {
          if (this.closed) return;
          if (ok) {
            this.options.logger.info(
              { worker_id: this.options.workerId },
              'worker liveness lock reacquired',
            );
          } else {
            this.reconnectLater(false);
          }
        },
        (err: unknown) => {
          this.options.logger.warn(
            { worker_id: this.options.workerId, error_code: (err as { code?: unknown }).code },
            'worker liveness lock not reacquired yet',
          );
          this.reconnectLater(false);
        },
      );
    }, this.delayMs);
    this.timer.unref();
  }
}

/**
 * Whether worker `workerId` is alive: its liveness lock is held by some
 * session. Probes with `pg_try_advisory_lock` on `client` and releases the
 * lock at once when it was free (the worker is dead).
 */
export async function isWorkerAlive(
  client: Pick<pg.ClientBase, 'query'>,
  workerId: string,
): Promise<boolean> {
  const key = workerLivenessKey(workerId);
  const { rows } = await client.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS ok',
    [key],
  );
  if (rows[0]?.ok !== true) return true;
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
  return false;
}
