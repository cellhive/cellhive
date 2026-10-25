import { Inject, Injectable } from '@nestjs/common';

import { RealtimeBusSubscriber } from './bus-subscriber.js';

import type { Subscription } from './realtime-connection.js';
import type { Id } from '@cellhive/contracts';

/**
 * Local subscriptions of this instance, indexed by organization and
 * channel, so that an envelope of the organization's bus reaches exactly
 * the subscribers of the channels it concerns. Adding the first
 * subscription of an organization starts listening to its bus.
 */
@Injectable()
export class SubscriptionRegistry {
  readonly #byOrg = new Map<Id<'org'>, Map<string, Set<Subscription>>>();
  /** Registered subscriptions and the organizations whose bus they hold. */
  readonly #held = new Map<Subscription, Set<Id<'org'>>>();

  constructor(@Inject(RealtimeBusSubscriber) private readonly bus: RealtimeBusSubscriber) {}

  /** Subscriptions on this instance. */
  get size(): number {
    return this.#held.size;
  }

  /**
   * Registers the subscription on its connection and in the index, then
   * waits until the bus of each of its organizations is listened to. On
   * failure (Valkey down) nothing stays registered and the error is thrown.
   * Resolves to whether the bus of one of its organizations was not
   * listened to before (messages published earlier were not received).
   */
  async add(subscription: Subscription): Promise<boolean> {
    const held = new Set<Id<'org'>>();
    this.#held.set(subscription, held);
    subscription.connection.subscriptions.set(subscription.channel, subscription);
    for (const orgId of subscription.orgIds) {
      let channels = this.#byOrg.get(orgId);
      if (channels === undefined) {
        channels = new Map();
        this.#byOrg.set(orgId, channels);
      }
      let subscribers = channels.get(subscription.channel);
      if (subscribers === undefined) {
        subscribers = new Set();
        channels.set(subscription.channel, subscribers);
      }
      subscribers.add(subscription);
    }
    const results = await Promise.allSettled(
      subscription.orgIds.map(async (orgId) => {
        const started = await this.bus.acquire(orgId);
        // Removed while waiting: give the organization back at once.
        if (this.#held.get(subscription) === held) held.add(orgId);
        else this.bus.release(orgId);
        return started;
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure !== undefined) {
      this.remove(subscription);
      throw failure.reason;
    }
    return results.some((result) => result.status === 'fulfilled' && result.value);
  }

  /** Unregisters the subscription (no-op when it is not registered any more). */
  remove(subscription: Subscription): void {
    const held = this.#held.get(subscription);
    if (held === undefined) return;
    this.#held.delete(subscription);
    if (subscription.connection.subscriptions.get(subscription.channel) === subscription) {
      subscription.connection.subscriptions.delete(subscription.channel);
    }
    for (const orgId of subscription.orgIds) {
      const channels = this.#byOrg.get(orgId);
      const subscribers = channels?.get(subscription.channel);
      if (channels === undefined || subscribers === undefined) continue;
      subscribers.delete(subscription);
      if (subscribers.size === 0) channels.delete(subscription.channel);
      if (channels.size === 0) this.#byOrg.delete(orgId);
    }
    for (const orgId of held) this.bus.release(orgId);
  }

  /**
   * Keeps the subscription only on the bus of `orgIds` (a `user:` channel
   * whose user left organizations): it stops receiving the others' messages
   * at once. Never adds an organization.
   */
  retain(subscription: Subscription, orgIds: readonly Id<'org'>[]): void {
    const held = this.#held.get(subscription);
    if (held === undefined) return;
    const kept = new Set(orgIds);
    const dropped = subscription.orgIds.filter((orgId) => !kept.has(orgId));
    if (dropped.length === 0) return;
    subscription.orgIds = subscription.orgIds.filter((orgId) => kept.has(orgId));
    for (const orgId of dropped) {
      const channels = this.#byOrg.get(orgId);
      const subscribers = channels?.get(subscription.channel);
      if (channels !== undefined && subscribers !== undefined) {
        subscribers.delete(subscription);
        if (subscribers.size === 0) channels.delete(subscription.channel);
        if (channels.size === 0) this.#byOrg.delete(orgId);
      }
      if (held.delete(orgId)) this.bus.release(orgId);
    }
  }

  /** Whether the subscription is still registered. */
  has(subscription: Subscription): boolean {
    return this.#held.has(subscription);
  }

  /** Subscribers of `channel` whose messages come from the organization's bus. */
  subscribers(organizationId: Id<'org'>, channel: string): readonly Subscription[] {
    const subscribers = this.#byOrg.get(organizationId)?.get(channel);
    return subscribers === undefined ? [] : [...subscribers];
  }

  /** Every subscription fed by the organization's bus. */
  inOrganization(organizationId: Id<'org'>): readonly Subscription[] {
    const channels = this.#byOrg.get(organizationId);
    if (channels === undefined) return [];
    return [...channels.values()].flatMap((subscribers) => [...subscribers]);
  }
}
