import { orgBusChannel } from '@cellhive/server-core';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { cacheReady, closeCacheClient } from '../../common/infra/connections.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { CACHE_CLIENT } from '../../common/tokens.js';

import type { Id } from '@cellhive/contracts';
import type { Redis } from 'ioredis';

export type BusMessageHandler = (channel: string, message: string) => void;

interface OrgListener {
  count: number;
  /** Valkey confirmed the subscription: messages from then on are received. */
  settled: boolean;
  readonly ready: Promise<void>;
}

/**
 * The receiving side of the realtime bus on this instance: a dedicated
 * Valkey connection (a connection in subscriber mode cannot run other
 * commands) subscribed to `rt:org:<id>` of each organization that has at
 * least one local subscription, with reference counting. ioredis
 * re-subscribes by itself after a reconnect; messages published while the
 * connection was down are lost (clients resync when they reconnect).
 */
@Injectable()
export class RealtimeBusSubscriber implements OnApplicationShutdown {
  #client: Redis | undefined;
  #handler: BusMessageHandler | undefined;
  readonly #listeners = new Map<Id<'org'>, OrgListener>();

  constructor(
    @Inject(CACHE_CLIENT) private readonly cache: Redis,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** Receives every message of the subscribed organizations. */
  onMessage(handler: BusMessageHandler): void {
    this.#handler = handler;
  }

  /** Organizations listened to right now. */
  get organizations(): number {
    return this.#listeners.size;
  }

  /**
   * Listens to the organization's bus (resolves once Valkey confirmed the
   * subscription). Returns whether messages of the organization published
   * before this call may have been missed: this call started listening, or
   * waited for a subscription another call started and Valkey had not
   * confirmed yet (T706 review).
   */
  async acquire(organizationId: Id<'org'>): Promise<boolean> {
    let listener = this.#listeners.get(organizationId);
    const started = listener === undefined || !listener.settled;
    if (listener === undefined) {
      const created: OrgListener = {
        count: 0,
        settled: false,
        ready: this.subscribe(organizationId),
      };
      created.ready.then(
        () => {
          created.settled = true;
        },
        () => {
          if (this.#listeners.get(organizationId) === created) {
            this.#listeners.delete(organizationId);
          }
        },
      );
      this.#listeners.set(organizationId, created);
      listener = created;
    }
    listener.count += 1;
    try {
      await listener.ready;
    } catch (error) {
      listener.count -= 1;
      throw error;
    }
    return started;
  }

  /** Stops listening once the last local subscription of the organization is gone. */
  release(organizationId: Id<'org'>): void {
    const listener = this.#listeners.get(organizationId);
    if (listener === undefined) return;
    listener.count -= 1;
    if (listener.count > 0) return;
    this.#listeners.delete(organizationId);
    this.#client?.unsubscribe(orgBusChannel(organizationId)).catch((err: unknown) => {
      this.logger.warn({ err, org_id: organizationId }, 'realtime bus unsubscribe failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#listeners.clear();
    if (client !== undefined) await closeCacheClient(client);
  }

  private async subscribe(organizationId: Id<'org'>): Promise<void> {
    const client = this.client();
    await cacheReady(client);
    await client.subscribe(orgBusChannel(organizationId));
  }

  private client(): Redis {
    if (this.#client === undefined) {
      const client = this.cache.duplicate({ connectionName: 'cellhive-api-realtime' });
      client.on('message', (channel: string, message: string) => {
        this.#handler?.(channel, message);
      });
      client.on('error', (err: Error) => {
        this.logger.debug({ err, dependency: 'cache' }, 'realtime bus connection error');
      });
      this.#client = client;
    }
    return this.#client;
  }
}
