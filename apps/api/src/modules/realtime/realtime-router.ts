import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  orgOfBusChannel,
  parseRealtimeEnvelope,
  type ApiTokenRevokedEnvelope,
  type DashboardChangedEnvelope,
  type PermissionChangedEnvelope,
  type RealtimeEnvelope,
  type SessionRevokedEnvelope,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../../common/logging/app-logger.js';

import { RealtimeBusSubscriber } from './bus-subscriber.js';
import { ChannelAuthorizer } from './channel-authorizer.js';
import { DELIVERY_STRATEGIES, type Delivery, type DeliveryStrategy } from './delivery.js';
import { RECORD_DELIVERY_SLICE_MS } from './record-delivery.js';
import { SubscriptionRegistry } from './subscription-registry.js';

import type { RealtimeConnection, Subscriber, Subscription } from './realtime-connection.js';
import type { Id } from '@cellhive/contracts';

/**
 * Re-validates the credential of a connection (the gateway's check);
 * `false` when it no longer authenticates — the connection is closed then.
 */
export type CredentialCheck = (connection: RealtimeConnection) => Promise<boolean>;

/**
 * Routes envelopes of the realtime bus to local subscriptions (SPEC §15).
 * Envelopes of one organization are handled one after the other, in the
 * order they were published, so that a permission re-check completes
 * before the messages that follow it are filtered.
 */
@Injectable()
export class RealtimeRouter {
  /** Strategies by envelope type (record changes feed tables and dashboards, T807). */
  readonly #strategies = new Map<string, DeliveryStrategy[]>();
  readonly #queues = new Map<Id<'org'>, Promise<void>>();
  #permissionEpoch = 0;
  #onApiTokenRevoked: ((envelope: ApiTokenRevokedEnvelope) => void) | undefined;
  #onSessionRevoked: ((envelope: SessionRevokedEnvelope) => void) | undefined;
  #credentialCheck: CredentialCheck | undefined;

  constructor(
    @Inject(RealtimeBusSubscriber) bus: RealtimeBusSubscriber,
    @Inject(SubscriptionRegistry) private readonly registry: SubscriptionRegistry,
    @Inject(ChannelAuthorizer) private readonly authorizer: ChannelAuthorizer,
    @Inject(DELIVERY_STRATEGIES) strategies: readonly DeliveryStrategy[],
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    for (const strategy of strategies) {
      const list = this.#strategies.get(strategy.type) ?? [];
      list.push(strategy);
      this.#strategies.set(strategy.type, list);
    }
    bus.onMessage((channel, message) => {
      this.receive(channel, message);
    });
  }

  /**
   * Increases with every `permission.changed` received. A subscription made
   * while it moved must be checked again: the change may have been handled
   * before the subscription was registered.
   */
  get permissionEpoch(): number {
    return this.#permissionEpoch;
  }

  /**
   * Receives `api_token.revoked` (T706) as soon as it arrives, outside the
   * organization's queue: closing connections needs no ordering with the
   * messages around it, and must not wait behind a long delivery.
   */
  onApiTokenRevoked(handler: (envelope: ApiTokenRevokedEnvelope) => void): void {
    this.#onApiTokenRevoked = handler;
  }

  /**
   * Receives `session.revoked` as soon as it arrives, outside the
   * organization's queue, like `api_token.revoked`.
   */
  onSessionRevoked(handler: (envelope: SessionRevokedEnvelope) => void): void {
    this.#onSessionRevoked = handler;
  }

  /**
   * The check run on connections opened with an API token before their
   * subscriptions are re-checked on `permission.changed` (ADR-36 §2: expiry
   * is noticed at every re-check too).
   */
  setCredentialCheck(check: CredentialCheck): void {
    this.#credentialCheck = check;
  }

  /** A raw message of the bus. */
  receive(channel: string, message: string): void {
    const organizationId = orgOfBusChannel(channel);
    const envelope =
      organizationId === undefined ? undefined : parseRealtimeEnvelope(message, organizationId);
    if (organizationId === undefined || envelope === undefined) {
      this.logger.debug({ bus_channel: channel }, 'realtime envelope ignored');
      return;
    }
    if (envelope.type === 'api_token.revoked') {
      this.#onApiTokenRevoked?.(envelope);
      return;
    }
    if (envelope.type === 'session.revoked') {
      this.#onSessionRevoked?.(envelope);
      return;
    }
    if (envelope.type === 'permission.changed') this.#permissionEpoch += 1;
    const previous = this.#queues.get(organizationId) ?? Promise.resolve();
    const next = previous
      .then(() => this.dispatch(envelope))
      .catch((err: unknown) => {
        this.logger.error(
          { err, org_id: organizationId, envelope_type: envelope.type },
          'realtime dispatch failed',
        );
      })
      .finally(() => {
        if (this.#queues.get(organizationId) === next) this.#queues.delete(organizationId);
      });
    this.#queues.set(organizationId, next);
  }

  async dispatch(envelope: RealtimeEnvelope): Promise<void> {
    if (envelope.type === 'permission.changed') {
      await this.recheck(envelope);
      return;
    }
    for (const strategy of this.#strategies.get(envelope.type) ?? []) {
      const candidates = new Map<Subscriber, Subscription>();
      for (const channel of strategy.channels(envelope)) {
        for (const subscription of this.registry.subscribers(envelope.organization_id, channel)) {
          candidates.set(subscription, subscription);
        }
      }
      if (candidates.size === 0) continue;
      const deliveries = await strategy.deliver(envelope, [...candidates.keys()]);
      await this.send(deliveries, candidates);
    }
    if (envelope.type === 'schema.changed' && envelope.entity === 'view') {
      await this.reloadView(envelope.organization_id, envelope.entity_id);
    }
    if (envelope.type === 'dashboard.changed') await this.reloadDashboard(envelope);
  }

  /**
   * A dashboard changed (T807): its subscriptions are checked again before
   * the next envelope of the organization, which reloads the tables its
   * widgets read; a dashboard gone to the trash (or no longer readable)
   * removes them with `error NOT_FOUND`.
   */
  private async reloadDashboard(envelope: DashboardChangedEnvelope): Promise<void> {
    const channel = `dashboard:${envelope.dashboard_id}`;
    const byConnection = new Map<RealtimeConnection, Subscription[]>();
    for (const subscription of this.registry.subscribers(envelope.organization_id, channel)) {
      const list = byConnection.get(subscription.connection) ?? [];
      list.push(subscription);
      byConnection.set(subscription.connection, list);
    }
    await Promise.all(
      [...byConnection].map(([connection, subscriptions]) =>
        this.recheckConnection(connection, subscriptions, { notify: false }),
      ),
    );
  }

  /**
   * A view changed (config, sharing, deletion): subscriptions scoped by it
   * load it again before the next envelope of the organization is routed,
   * so record messages follow its new filter (T313). One that cannot read
   * it any more is removed with `error NOT_FOUND` naming the view.
   */
  private async reloadView(organizationId: Id<'org'>, viewId: string): Promise<void> {
    const byConnection = new Map<RealtimeConnection, Subscription[]>();
    for (const subscription of this.registry.inOrganization(organizationId)) {
      if (subscription.viewRequest?.id !== viewId) continue;
      const list = byConnection.get(subscription.connection) ?? [];
      list.push(subscription);
      byConnection.set(subscription.connection, list);
    }
    await Promise.all(
      [...byConnection].map(([connection, subscriptions]) =>
        this.recheckConnection(connection, subscriptions, { notify: false }),
      ),
    );
  }

  private async send(
    deliveries: readonly Delivery[],
    candidates: ReadonlyMap<Subscriber, Subscription>,
  ): Promise<void> {
    // Many messages (a bulk write seen by many subscribers): yield now and
    // then so that sending never holds the event loop for long.
    let sliceStart = performance.now();
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index] as (typeof deliveries)[number];
      const subscription = candidates.get(delivery.subscriber);
      // Only to the subscribers handed over, and only while still subscribed.
      if (subscription !== undefined && this.registry.has(subscription)) {
        subscription.connection.send(delivery.message);
      }
      if (index % 256 === 255 && performance.now() - sliceStart >= RECORD_DELIVERY_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
    }
  }

  /**
   * Re-checks every local subscription of the bases (SPEC §14.1, §15):
   * each `base:` subscription gets `permission.changed` (the client
   * refetches what it shows); a subscription that is not readable any more
   * is then removed and its client gets `error NOT_FOUND` naming the
   * channel. `user:` subscriptions fed by the organization are re-checked
   * too (memberships move `permission_version` of every base): a user who
   * left it stops receiving its messages.
   */
  private async recheck(envelope: PermissionChangedEnvelope): Promise<void> {
    const baseIds = new Set<string>(envelope.base_ids);
    const byConnection = new Map<RealtimeConnection, Subscription[]>();
    for (const subscription of this.registry.inOrganization(envelope.organization_id)) {
      const concerned =
        subscription.target.kind === 'user' ||
        (subscription.baseId !== null && baseIds.has(subscription.baseId));
      if (!concerned) continue;
      const list = byConnection.get(subscription.connection) ?? [];
      list.push(subscription);
      byConnection.set(subscription.connection, list);
    }
    await Promise.all(
      [...byConnection].map(async ([connection, subscriptions]) => {
        const check = this.#credentialCheck;
        if (connection.auth === 'api_token' && check !== undefined && !(await check(connection))) {
          return;
        }
        await this.recheckConnection(connection, subscriptions);
      }),
    );
  }

  /**
   * Re-authorizes subscriptions of one connection (one access lookup per
   * base). `notify: false` skips `permission.changed` for the ones that stay.
   */
  async recheckConnection(
    connection: RealtimeConnection,
    subscriptions: readonly Subscription[],
    options: { readonly notify?: boolean } = {},
  ): Promise<void> {
    const principal = connection.freshPrincipal();
    for (const subscription of subscriptions) {
      if (connection.isClosed() || !this.registry.has(subscription)) continue;
      let grant;
      try {
        grant = await this.authorizer.authorize(
          principal,
          subscription.target,
          subscription.viewRequest,
        );
      } catch (err) {
        // Fail closed: without a verdict the subscription cannot stay.
        this.logger.warn({ err, user_id: connection.userId }, 'realtime re-check failed');
        this.registry.remove(subscription);
        connection.send({
          type: 'error',
          req_id: null,
          code: 'DEPENDENCY_UNAVAILABLE',
          channel: subscription.channel,
        });
        continue;
      }
      if (!this.registry.has(subscription)) continue;
      const notifyBase = subscription.target.kind === 'base' && options.notify !== false;
      if (grant === undefined || grant.view === 'not_found') {
        this.registry.remove(subscription);
        // The client learns that access changed, then that the channel is gone.
        if (notifyBase) {
          connection.send({ type: 'permission.changed', channel: subscription.channel });
        }
        const view = subscription.viewRequest;
        connection.send({
          type: 'error',
          req_id: null,
          code: 'NOT_FOUND',
          channel: subscription.channel,
          // Only the view went away (T313): the client opens another view.
          ...(grant === undefined || view === null ? {} : { view_id: view.id }),
        });
        continue;
      }
      // Organizations left since (a `user:` channel) stop feeding it.
      this.registry.retain(subscription, grant.orgIds);
      subscription.previousBase = subscription.base;
      subscription.base = grant.base;
      subscription.variables = grant.variables;
      subscription.view = grant.view;
      subscription.tables = grant.tables;
      if (notifyBase) {
        connection.send({ type: 'permission.changed', channel: subscription.channel });
      }
    }
  }
}
