import {
  apiTokenPolicySchema,
  DEFAULT_API_TOKEN_POLICY,
  type ApiTokenPolicy,
  type Id,
} from '@cellhive/contracts';

import { publishRealtime } from '../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../realtime/envelope.js';

import type { Db, Tx } from '../db/create-db.js';
import type { JsonValue } from '../db/schema.js';

/**
 * `organizations.settings.api_tokens` (CONTRACTS §26.4); a missing or
 * unreadable value is the default (enabled, no lifetime limit).
 */
export function apiTokenPolicyOf(settings: JsonValue): ApiTokenPolicy {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return DEFAULT_API_TOKEN_POLICY;
  }
  const parsed = apiTokenPolicySchema.safeParse(settings['api_tokens']);
  return parsed.success ? parsed.data : DEFAULT_API_TOKEN_POLICY;
}

/**
 * Tells every api instance, after `tx` commits, that these tokens — or,
 * without `tokenIds`, every token of the organization (policy turned off)
 * — no longer authenticate, so their WebSocket connections close (T706).
 */
export async function publishApiTokensRevoked(
  db: Db,
  tx: Tx,
  organizationId: Id<'org'>,
  tokenIds?: readonly Id<'tok'>[],
): Promise<void> {
  if (tokenIds?.length === 0) return;
  await publishRealtime(db, tx, {
    v: REALTIME_ENVELOPE_VERSION,
    type: 'api_token.revoked',
    organization_id: organizationId,
    ...(tokenIds === undefined ? {} : { token_ids: [...tokenIds] }),
  });
}
