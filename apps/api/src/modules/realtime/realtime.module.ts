import { Module } from '@nestjs/common';

import { DashboardModule } from '../dashboard/dashboard.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';

import { RealtimeBusSubscriber } from './bus-subscriber.js';
import { ChannelAuthorizer } from './channel-authorizer.js';
import { defaultDeliveryStrategies, DELIVERY_STRATEGIES } from './delivery.js';
import { RealtimeLimits } from './realtime-limits.js';
import { RealtimeRouter } from './realtime-router.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeMetrics } from './realtime.metrics.js';
import { SubscriptionRegistry } from './subscription-registry.js';

/**
 * Realtime (SPEC §15, CONTRACTS §7): the WebSocket gateway on `/ws`, the
 * local subscription registry, the receiving side of the Valkey bus and the
 * router that turns bus envelopes into client messages. Publishing lives in
 * `RealtimeBusModule`.
 */
@Module({
  imports: [MetricsModule, DashboardModule],
  providers: [
    RealtimeLimits,
    RealtimeBusSubscriber,
    SubscriptionRegistry,
    ChannelAuthorizer,
    {
      provide: DELIVERY_STRATEGIES,
      inject: [SubscriptionRegistry],
      useFactory: (registry: SubscriptionRegistry) => defaultDeliveryStrategies(registry),
    },
    RealtimeRouter,
    RealtimeGateway,
    RealtimeMetrics,
  ],
  exports: [RealtimeLimits, RealtimeGateway, SubscriptionRegistry],
})
export class RealtimeModule {}
