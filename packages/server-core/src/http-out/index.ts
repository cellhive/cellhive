/**
 * Outbound HTTP through the two-phase outbox (ADR-35 §4, BACKLOG T605):
 * phase 1 inserts a delivery in the step's transaction (`HttpOutbox`),
 * phase 2 delivers it from the job `http.deliver` (`HttpDeliverer`) without
 * holding a transaction during the call. Every call goes through `net/**`.
 */
export {
  createHttpCallSlots,
  databaseSecretSource,
  deliveryErrorOf,
  HTTP_CALL_SLOTS_RETRY_MS,
  HTTP_DELIVERY_USER_AGENT,
  HTTP_DNS_BUSY_RETRY_MS,
  httpCallSlotsFor,
  HttpDeliverer,
  responseRecord,
  type HttpCallSlots,
  type HttpDelivererOptions,
  type HttpDeliverResult,
  type HttpDeliverySecretSource,
} from './deliver.js';
export {
  HttpDeliveriesRepository,
  type HttpDeliveryLease,
  type HttpDeliveryOutcome,
  type NewHttpDelivery,
} from './http-deliveries.repository.js';
export {
  HttpOutbox,
  httpDeliverJobKey,
  rescueHttpDelivery,
  type HttpDeliveryRescue,
  type EnqueueActionDelivery,
  type EnqueuedHttpDelivery,
  type EnqueueHttpDelivery,
  type EnqueueTestDelivery,
} from './http-outbox.js';
export {
  HTTP_DELIVERY_DURATION_BUCKETS,
  HTTP_DELIVERY_OUTCOMES,
  httpDeliveriesRescuedCount,
  httpDeliveryMetrics,
  recordHttpDeliveriesRescued,
  SECRET_HOST_BLOCK_REASONS,
  secretHostBlockedCounts,
  type HttpDeliveryMetricsSnapshot,
  type HttpDeliveryOutcomeLabel,
  type SecretHostBlockReason,
} from './metrics.js';
export {
  deriveDeliveryKey,
  openDeliveryRequest,
  sealDeliveryRequest,
  type HttpDeliveryRequest,
} from './request-crypto.js';
export {
  decideRetry,
  parseRetryAfter,
  retryDelayAfter,
  type DeliveryAttemptResult,
  type DeliveryFailure,
  type RetryDecision,
  type RetryInput,
} from './retry-policy.js';
export { httpDeliverySummaryOf, unpacedHostPacer } from './summary.js';
