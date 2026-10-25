/**
 * The single way out to user-configured URLs (BACKLOG S5c "Một cửa cho mạng
 * ra", ADR-35 §3): parse → resolve and vet every address → connect to the
 * vetted address only, never following redirects; plus the per-destination
 * pacer of outbound calls.
 */
export {
  classifyAddress,
  isLoopbackAddress,
  neverAllowedBlockList,
  NEVER_ALLOWED_RANGES,
  PRIVATE_RANGES,
  type AddressClass,
} from './address-class.js';
export {
  isOutboundHttpError,
  OutboundHttpError,
  SSRF_BLOCK_REASONS,
  ssrfBlocked,
  type OutboundErrorCode,
  type SsrfBlockReason,
} from './errors.js';
export {
  guardedRequest,
  OUTBOUND_CONNECT_TIMEOUT_MS,
  OUTBOUND_MAX_RESPONSE_BYTES,
  OUTBOUND_TIMEOUT_MS,
  type GuardedRequestOptions,
  type GuardedResponse,
} from './guarded-request.js';
export {
  createValkeyHostPacer,
  HOST_PACER_BURST,
  HOST_PACER_LEASE_MS,
  HOST_PACER_MAX_IN_FLIGHT_PER_ORG,
  HOST_PACER_MAX_PAUSE_MS,
  HOST_PACER_RATE_PER_SEC,
  type HostPacer,
  type HostPacerDecision,
  type HostPacerLease,
  type HostPacerTarget,
  type ValkeyHostPacerOptions,
} from './host-pacer.js';
export {
  createSystemLookupLimiter,
  isLookupQueueTimeout,
  limitedSystemHostLookup,
  limitHostLookup,
  LookupQueueTimeoutError,
  MAX_CONCURRENT_SYSTEM_LOOKUPS,
  MAX_SYSTEM_LOOKUPS_PER_ORG,
  SYSTEM_LOOKUP_QUEUE_WAIT_MS,
  systemHostLookup,
  type HostLookup,
  type HostLookupContext,
} from './lookup.js';
export { recordSsrfBlocked, ssrfBlockedCounts } from './metrics.js';
export {
  resolveOutboundTarget,
  type OutboundAllowlistEntry,
  type OutboundAllowlistSource,
  type OutboundTarget,
  type PrivateAllowlistMode,
  type ResolveOutboundOptions,
} from './resolve-target.js';
export {
  DEFAULT_OUTBOUND_PORTS,
  MAX_OUTBOUND_URL_LENGTH,
  parseOutboundUrl,
  type OutboundUrl,
} from './url-policy.js';
