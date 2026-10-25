import { Inject, Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';

import { MetricsService } from '../metrics/metrics.service.js';

import { RealtimeBusSubscriber } from './bus-subscriber.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { SubscriptionRegistry } from './subscription-registry.js';

/**
 * WebSocket gauges on `/metrics` (SPEC §19), read when scraped. Never an
 * organization, a user or a token as label; `ws_connections` is split by
 * how the handshake authenticated (`auth = session | api_token`, T706).
 */
@Injectable()
export class RealtimeMetrics {
  constructor(
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(RealtimeGateway) gateway: RealtimeGateway,
    @Inject(SubscriptionRegistry) registry: SubscriptionRegistry,
    @Inject(RealtimeBusSubscriber) bus: RealtimeBusSubscriber,
  ) {
    new Gauge({
      name: 'ws_connections',
      help: 'Open WebSocket connections on this instance',
      labelNames: ['auth'],
      registers: [metrics.registry],
      collect() {
        const counts = gateway.connectionCounts();
        this.set({ auth: 'session' }, counts.session);
        this.set({ auth: 'api_token' }, counts.api_token);
      },
    });
    new Gauge({
      name: 'ws_subscriptions',
      help: 'Realtime channel subscriptions on this instance',
      registers: [metrics.registry],
      collect() {
        this.set(registry.size);
      },
    });
    new Gauge({
      name: 'realtime_bus_organizations',
      help: 'Organizations whose realtime bus this instance listens to',
      registers: [metrics.registry],
      collect() {
        this.set(bus.organizations);
      },
    });
  }
}
