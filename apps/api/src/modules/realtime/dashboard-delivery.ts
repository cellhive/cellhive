import { DASHBOARD_DATA_CHANGED_GATHER_MS, dashboardChannel, type Id } from '@cellhive/contracts';

import type { Delivery, DeliveryStrategy } from './delivery.js';
import type { Subscriber, Subscription } from './realtime-connection.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { BaseAccess } from '../../common/access/access.service.js';
import type { DashboardChangedEnvelope, RecordChangesEnvelope } from '@cellhive/server-core';

/**
 * `dashboard.changed` (T807, CONTRACTS §7, §28.5) on `dashboard:<id>`: the
 * same message for every subscriber (they all read the dashboard — checked
 * when subscribing and at every permission change). The router then
 * re-checks the subscriptions, which reloads the tables the dashboard reads.
 */
export const dashboardChangedDelivery: DeliveryStrategy<DashboardChangedEnvelope> = {
  type: 'dashboard.changed',
  channels(envelope) {
    return [dashboardChannel(envelope.dashboard_id)];
  },
  deliver(envelope, subscribers) {
    const message = {
      type: 'dashboard.changed' as const,
      channel: dashboardChannel(envelope.dashboard_id),
      dashboard_id: envelope.dashboard_id,
      version: envelope.version,
    };
    return subscribers.map((subscriber) => ({ subscriber, message }));
  },
};

function tableVisible(base: BaseAccess | null, tableId: Id<'tbl'>): boolean {
  return base !== null && (base.access.is_admin || base.access.tables[tableId] !== undefined);
}

interface Pending {
  readonly organizationId: Id<'org'>;
  readonly dashboardId: Id<'dsh'>;
  readonly tableIds: Set<Id<'tbl'>>;
  readonly timer: NodeJS.Timeout;
}

/**
 * `dashboard.data_changed` (T807, CONTRACTS §7, §28.5, "Quyết định S7"
 * #10): records of a table that a dashboard's widgets read changed (every
 * write that bumps the table's `data_version` publishes `record.changes`;
 * so do computed recomputes and link title fan-outs). A hint only — no
 * value, no number, no record id: clients refetch the widgets over HTTP
 * with their own permissions, so a hint never needs filtering by read rule.
 *
 * Which dashboards read a table comes from the local subscriptions only
 * (`Subscription.tables`, loaded when subscribing and reloaded on
 * `dashboard.changed` and permission changes). Changes are gathered per
 * dashboard for {@link DASHBOARD_DATA_CHANGED_GATHER_MS}: one timer per
 * dashboard with subscribers on this instance, so 50 writes in 5 s give
 * one or two messages. When it fires, each current subscriber receives the
 * changed tables it sees (none → nothing).
 */
export class DashboardDataChangedStrategy implements DeliveryStrategy<RecordChangesEnvelope> {
  readonly type = 'record.changes' as const;
  readonly #registry: SubscriptionRegistry;
  readonly #gatherMs: number;
  readonly #pending = new Map<string, Pending>();

  constructor(registry: SubscriptionRegistry, options: { readonly gatherMs?: number } = {}) {
    this.#registry = registry;
    this.#gatherMs = options.gatherMs ?? DASHBOARD_DATA_CHANGED_GATHER_MS;
  }

  /** Dashboards with changes waiting for their timer (tests). */
  get pendingDashboards(): number {
    return this.#pending.size;
  }

  channels(envelope: RecordChangesEnvelope): readonly string[] {
    const channels = new Set<string>();
    for (const subscription of this.#registry.inOrganization(envelope.organization_id)) {
      if (subscription.target.kind === 'dashboard' && subscription.tables?.has(envelope.table_id)) {
        channels.add(subscription.channel);
      }
    }
    return [...channels];
  }

  deliver(
    envelope: RecordChangesEnvelope,
    subscribers: readonly Subscriber[],
  ): readonly Delivery[] {
    for (const subscriber of subscribers) {
      if (subscriber.target.kind !== 'dashboard') continue;
      const dashboardId = subscriber.target.id;
      const key = `${envelope.organization_id}\u0000${dashboardId}`;
      let pending = this.#pending.get(key);
      if (pending === undefined) {
        const timer = setTimeout(() => {
          this.flush(key);
        }, this.#gatherMs);
        timer.unref();
        pending = {
          organizationId: envelope.organization_id,
          dashboardId,
          tableIds: new Set(),
          timer,
        };
        this.#pending.set(key, pending);
      }
      pending.tableIds.add(envelope.table_id);
    }
    // Sent when the timer fires.
    return [];
  }

  /** Sends what was gathered for one dashboard now (the timer; tests). */
  flush(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    const channel = dashboardChannel(pending.dashboardId);
    const messages = new Map<string, ReturnType<typeof dataChanged>>();
    for (const subscription of this.#registry.subscribers(pending.organizationId, channel)) {
      const tableIds = [...pending.tableIds]
        .filter(
          (tableId) =>
            subscription.tables?.has(tableId) === true && tableVisible(subscription.base, tableId),
        )
        .sort();
      if (tableIds.length === 0) continue;
      const signature = tableIds.join(',');
      let message = messages.get(signature);
      if (message === undefined) {
        message = dataChanged(channel, pending.dashboardId, tableIds);
        messages.set(signature, message);
      }
      send(this.#registry, subscription, message);
    }
  }

  /** Flushes every dashboard (tests). */
  flushAll(): void {
    for (const key of [...this.#pending.keys()]) this.flush(key);
  }
}

function dataChanged(channel: string, dashboardId: Id<'dsh'>, tableIds: Id<'tbl'>[]) {
  return {
    type: 'dashboard.data_changed' as const,
    channel,
    dashboard_id: dashboardId,
    table_ids: tableIds,
  };
}

function send(
  registry: SubscriptionRegistry,
  subscription: Subscription,
  message: ReturnType<typeof dataChanged>,
): void {
  // Only while still subscribed (a re-check may have removed it meanwhile).
  if (registry.has(subscription)) subscription.connection.send(message);
}
