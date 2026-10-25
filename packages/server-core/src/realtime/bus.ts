import { afterCommit, type Db, type Tx } from '../db/create-db.js';

import { orgBusChannel, type RealtimeEnvelope } from './envelope.js';

/**
 * Publishes envelopes on the realtime bus (SPEC §15). Realtime is best
 * effort: `publish` never rejects; failures go to the publisher's own error
 * handler (clients resync when they reconnect).
 */
export interface RealtimePublisher {
  publish(envelope: RealtimeEnvelope): Promise<void>;
}

/** The part of a Valkey client (ioredis) the bus needs to publish. */
export interface BusClient {
  publish(channel: string, message: string): Promise<unknown>;
}

/** `RealtimePublisher` on Valkey pub/sub: one channel per organization (`rt:org:<id>`). */
export class ValkeyRealtimeBus implements RealtimePublisher {
  constructor(
    private readonly client: BusClient,
    private readonly onError: (error: unknown, envelope: RealtimeEnvelope) => void = () =>
      undefined,
  ) {}

  async publish(envelope: RealtimeEnvelope): Promise<void> {
    try {
      await this.client.publish(orgBusChannel(envelope.organization_id), JSON.stringify(envelope));
    } catch (error) {
      this.onError(error, envelope);
    }
  }
}

/** Drops everything (CLI, tests, processes without Valkey). */
export const noopRealtimePublisher: RealtimePublisher = {
  publish: () => Promise.resolve(),
};

const attached = new WeakMap<Db, RealtimePublisher>();

/**
 * Makes `publisher` the realtime bus of everything built on `db`:
 * repositories that change what realtime subscribers see
 * (`BasesRepository` permission versions, `JobsRepository` job state)
 * publish through it after their transaction commits. Each process (api,
 * worker) attaches its bus once at start; without one they publish nothing.
 */
export function attachRealtimePublisher(db: Db, publisher: RealtimePublisher): void {
  attached.set(db, publisher);
}

export function realtimePublisherOf(db: Db): RealtimePublisher | undefined {
  return attached.get(db);
}

/**
 * Publishes `envelope` on `db`'s bus: after `tx` commits when the change
 * runs in a transaction (nothing on rollback), at once otherwise. A no-op
 * without an attached bus.
 */
export async function publishRealtime(
  db: Db,
  tx: Tx | undefined,
  envelope: RealtimeEnvelope,
): Promise<void> {
  const publisher = attached.get(db);
  if (publisher === undefined) return;
  if (tx === undefined) {
    await publisher.publish(envelope);
    return;
  }
  afterCommit(tx, () => publisher.publish(envelope));
}
