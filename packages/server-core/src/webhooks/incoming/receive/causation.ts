import {
  CAUSATION_HOOK_PATH_PREFIX,
  decodeCausationToken,
  type CausationTokenFailure,
  type DecodeCausationOptions,
} from '../../../automation/causation/token.js';
import { MAX_CAUSATION_DEPTH, type Causation } from '../../../events/event.js';

import { recordCausationRejected } from './metrics.js';

export interface InboundCausation {
  /** The causation of the `webhook.received` event; `undefined` = a new chain (depth 0). */
  readonly causation: Causation | undefined;
  /** A valid `X-Cellhive-Causation` header continued a chain (`causation_accepted`). */
  readonly accepted: boolean;
}

/**
 * The causation of a request to a hook from its `X-Cellhive-Causation`
 * header (ADR-27 §2, ADR-35 §5, CONTRACTS §10):
 *
 * - no header → a new chain;
 * - a valid token (T601 `decodeCausationToken` in path-prefix mode: the
 *   token is bound to this instance — host of `PUBLIC_URL` or the `Host`
 *   header after `TRUSTED_PROXIES`, plus the hook prefix `/api/v1/hooks` —
 *   and the request path must lie under that prefix; amendment 2026-10-18
 *   of ADR-27 §5 / ADR-35 §5, T616) → `{ root_event_id, depth + 1,
 *   automation_chain }`. A token copied to another hook of this instance,
 *   or forwarded by n8n, is therefore accepted: it can only deepen a chain;
 * - any other value → a new chain, counted in
 *   `automation_causation_rejected_total`. The request itself is never
 *   refused because of it.
 *
 * `depth + 1` is capped at `MAX_CAUSATION_DEPTH` (5): a token of depth 5 —
 * the deepest the sending run could have — gives 6, past
 * `causationSchema`. Re-parsing that would fail and fall back to depth 0,
 * re-opening the loop; capped at 5 the loop guard (`depth >=
 * automation_max_depth`, at most 5) still stops every automation.
 * Never logs the token.
 */
export function inboundCausation(
  header: string | readonly string[] | undefined,
  options: Omit<DecodeCausationOptions, 'pathPrefix'>,
): InboundCausation {
  if (header === undefined) return { causation: undefined, accepted: false };
  const result =
    typeof header === 'string'
      ? decodeCausationToken(header, { ...options, pathPrefix: CAUSATION_HOOK_PATH_PREFIX })
      : ({ ok: false, reason: 'malformed' } as const);
  if (!result.ok) {
    recordCausationRejected(result.reason satisfies CausationTokenFailure);
    return { causation: undefined, accepted: false };
  }
  return {
    causation: {
      root_event_id: result.causation.root_event_id,
      depth: Math.min(result.causation.depth + 1, MAX_CAUSATION_DEPTH),
      automation_chain: result.causation.automation_chain,
    },
    accepted: true,
  };
}
