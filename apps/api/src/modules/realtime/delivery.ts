import {
  baseChannel,
  tableChannel,
  userChannel,
  type Id,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import { isViewVisible } from '@cellhive/permissions';

import { computedRecomputingDelivery } from './computed-recomputing-delivery.js';
import { dashboardChangedDelivery, DashboardDataChangedStrategy } from './dashboard-delivery.js';
import { fieldConvertingDelivery } from './field-converting-delivery.js';
import { RecordDeliveryStrategy } from './record-delivery.js';

import type { Subscriber } from './realtime-connection.js';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { BaseAccess } from '../../common/access/access.service.js';
import type {
  AutomationRunFinishedEnvelope,
  ChannelChangedEnvelope,
  IncomingWebhookSampleCapturedEnvelope,
  JobProgressEnvelope,
  NotificationCreatedEnvelope,
  RealtimeEnvelope,
  SchemaChangedEnvelope,
} from '@cellhive/server-core';

/** One message for one subscriber. */
export interface Delivery {
  readonly subscriber: Subscriber;
  readonly message: RealtimeServerMessage;
}

/**
 * How one type of bus envelope reaches local subscribers (SPEC §15). The
 * router hands a strategy the subscribers of the channels it names; the
 * strategy decides, per subscriber, which message (if any) it receives.
 * Envelopes carry stored-form data only; anything that depends on who
 * receives it (read rule, field permissions) is computed here, from
 * `Subscriber.base`, without database reads per subscriber.
 *
 * `permission.changed` is not a strategy: the router re-checks
 * subscriptions itself. Records: `RecordDeliveryStrategy` (T210).
 */
export interface DeliveryStrategy<E extends RealtimeEnvelope = RealtimeEnvelope> {
  readonly type: E['type'];
  /** Channels whose local subscribers may receive the envelope. */
  channels(envelope: E): readonly string[];
  deliver(
    envelope: E,
    subscribers: readonly Subscriber[],
  ): readonly Delivery[] | Promise<readonly Delivery[]>;
}

/** Injection token of the strategies (`DeliveryStrategy[]`). */
export const DELIVERY_STRATEGIES = Symbol('REALTIME_DELIVERY_STRATEGIES');

function tableVisible(base: BaseAccess | null, tableId: Id<'tbl'>): boolean {
  return base !== null && (base.access.is_admin || base.access.tables[tableId] !== undefined);
}

function fieldVisible(base: BaseAccess | null, tableId: Id<'tbl'>, fieldId: string): boolean {
  if (base === null) return false;
  if (base.access.is_admin) return true;
  const fields = base.access.tables[tableId]?.fields;
  return fields !== undefined && Object.hasOwn(fields, fieldId);
}

/**
 * A view is visible to a subscriber who sees its table and, for a personal
 * view, is its owner; for a shared view, has it in `visible_views` (admins
 * see every shared view). Personal views of others and views outside
 * `visible_views` are never named (BACKLOG T301).
 */
function viewVisible(
  subscriber: Subscriber,
  base: BaseAccess | null,
  envelope: SchemaChangedEnvelope,
): boolean {
  if (!tableVisible(base, envelope.table_id) || base === null) return false;
  const ownerId = envelope.owner_id ?? null;
  if (ownerId !== null) return subscriber.userId === ownerId;
  if (base.access.is_admin) return true;
  const table = base.access.tables[envelope.table_id];
  return table !== undefined && isViewVisible(table, envelope.entity_id);
}

/**
 * `schema.changed` (CONTRACTS §7) on `table:<id>`, and for table-level
 * changes on `base:<id>` too. The message is the same for everyone, but a
 * subscriber only receives it when the table (or field) is visible to them
 * now — or, for a deletion, was visible before the last re-check — so
 * hidden tables and `no_perm` fields are never named. Creating, deleting
 * and restoring tables and fields also bump `permission_version`; that
 * re-check reaches the router first because both are published in commit
 * order on the same bus.
 */
export const schemaChangedDelivery: DeliveryStrategy<SchemaChangedEnvelope> = {
  type: 'schema.changed',
  channels(envelope) {
    return envelope.entity === 'table'
      ? [tableChannel(envelope.table_id), baseChannel(envelope.base_id)]
      : [tableChannel(envelope.table_id)];
  },
  deliver(envelope, subscribers) {
    const visible = (subscriber: Subscriber, base: BaseAccess | null): boolean => {
      switch (envelope.entity) {
        case 'field':
          return fieldVisible(base, envelope.table_id, envelope.entity_id);
        case 'view':
          return viewVisible(subscriber, base, envelope);
        case 'table':
          return tableVisible(base, envelope.table_id);
      }
    };
    return subscribers
      .filter(
        (subscriber) =>
          visible(subscriber, subscriber.base) ||
          (envelope.action === 'deleted' && visible(subscriber, subscriber.previousBase)),
      )
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'schema.changed',
          channel: subscriber.channel,
          entity: envelope.entity,
          entity_id: envelope.entity_id,
          action: envelope.action,
          ...(envelope.ai_state === undefined ? {} : { ai_state: envelope.ai_state }),
        },
      }));
  },
};

/** `job.progress` on `user:<created_by>`, unchanged (only the creator can subscribe). */
export const jobProgressDelivery: DeliveryStrategy<JobProgressEnvelope> = {
  type: 'job.progress',
  channels(envelope) {
    return [userChannel(envelope.user_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => subscriber.userId === envelope.user_id)
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'job.progress',
          channel: subscriber.channel,
          job_id: envelope.job_id,
          progress: envelope.progress,
          status: envelope.status,
        },
      }));
  },
};

/**
 * `notification.created` on `user:<recipient>` only (T511): ids, no content;
 * the client refetches its list/unread count of `organization_id`.
 */
export const notificationCreatedDelivery: DeliveryStrategy<NotificationCreatedEnvelope> = {
  type: 'notification.created',
  channels(envelope) {
    return [userChannel(envelope.user_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => subscriber.userId === envelope.user_id)
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'notification.created',
          channel: subscriber.channel,
          notification_id: envelope.notification_id,
          organization_id: envelope.organization_id,
          notification_type: envelope.notification_type,
          base_id: envelope.base_id,
        },
      }));
  },
};

/**
 * `automation.run.finished` on `user:<clicked_by>` only (T517, ADR-32 §2):
 * the clicker of a button learns that its run ended; nobody else does.
 */
export const automationRunFinishedDelivery: DeliveryStrategy<AutomationRunFinishedEnvelope> = {
  type: 'automation.run.finished',
  channels(envelope) {
    return [userChannel(envelope.user_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => subscriber.userId === envelope.user_id)
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'automation.run.finished',
          channel: subscriber.channel,
          run_id: envelope.run_id,
          organization_id: envelope.organization_id,
          automation_id: envelope.automation_id,
          table_id: envelope.table_id,
          record_id: envelope.record_id,
          status: envelope.status,
        },
      }));
  },
};

/**
 * `channel.changed` on `user:<user_id>` only (T549, CONTRACTS §7, §22.7): a
 * personal notification channel of the subscriber was linked, unlinked or
 * put in `error`. Kind and status only; the client refetches its channels.
 */
export const channelChangedDelivery: DeliveryStrategy<ChannelChangedEnvelope> = {
  type: 'channel.changed',
  channels(envelope) {
    return [userChannel(envelope.user_id)];
  },
  deliver(envelope, subscribers) {
    return subscribers
      .filter((subscriber) => subscriber.userId === envelope.user_id)
      .map((subscriber) => ({
        subscriber,
        message: {
          type: 'channel.changed',
          channel: subscriber.channel,
          organization_id: envelope.organization_id,
          kind: envelope.kind,
          status: envelope.status,
        },
      }));
  },
};

/**
 * `incoming_webhook.sample_captured` on `user:<user_id>` only (T603,
 * CONTRACTS §7, §25.3): the sample request the subscriber listened for was
 * captured. Ids only; the client reads the sample.
 */
export const incomingWebhookSampleCapturedDelivery: DeliveryStrategy<IncomingWebhookSampleCapturedEnvelope> =
  {
    type: 'incoming_webhook.sample_captured',
    channels(envelope) {
      return [userChannel(envelope.user_id)];
    },
    deliver(envelope, subscribers) {
      return subscribers
        .filter((subscriber) => subscriber.userId === envelope.user_id)
        .map((subscriber) => ({
          subscriber,
          message: {
            type: 'incoming_webhook.sample_captured',
            channel: subscriber.channel,
            organization_id: envelope.organization_id,
            incoming_webhook_id: envelope.incoming_webhook_id,
          },
        }));
    },
  };

/**
 * Strategies registered by default, new for each router: the record
 * strategy holds writes split over several envelopes until their last part;
 * with the registry, record changes also become `dashboard.data_changed`
 * hints, gathered per dashboard (T807).
 */
export function defaultDeliveryStrategies(
  registry?: SubscriptionRegistry,
): readonly DeliveryStrategy[] {
  return [
    ...(registry === undefined ? [] : [new DashboardDataChangedStrategy(registry)]),
    dashboardChangedDelivery,
    schemaChangedDelivery,
    jobProgressDelivery,
    new RecordDeliveryStrategy(),
    fieldConvertingDelivery,
    computedRecomputingDelivery,
    notificationCreatedDelivery,
    automationRunFinishedDelivery,
    channelChangedDelivery,
    incomingWebhookSampleCapturedDelivery,
  ];
}
