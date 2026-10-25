import {
  SECRET_HOST_NOT_ALLOWED,
  SECRET_NOT_USABLE,
  type AutomationDefinition,
  type Id,
  type ProblemErrorItem,
  type SecretKind,
} from '@cellhive/contracts';

import { isOutboundHttpError } from '../../../net/errors.js';
import { parseOutboundUrl, type OutboundUrl } from '../../../net/url-policy.js';
import { secretHostDecision, secretHostPolicyOf } from '../../../secrets/allowed-hosts.js';
import { flattenActions } from '../../definition/validate.js';

import type { OrgScope } from '../../../db/repository.js';
import type { SecretsRepository } from '../../../secrets/secrets.repository.js';

/**
 * Save-time check of `http_request` and `run_n8n_workflow` that needs the
 * database (BACKLOG T606, T607, ADR-35 §8): the auth secret must be an
 * `http_header` secret, the signing secret a `webhook_signing` secret, of
 * the organization and whose scope includes the base. Missing, of another organization or kind, or out of
 * scope are the same `SECRET_NOT_USABLE` (no existence leak).
 *
 * T701 (ADR-36 §4): when the URL is a literal, its host (normalised by
 * `parseOutboundUrl`) must be an allowed host of each secret
 * (`SECRET_HOST_NOT_ALLOWED`, `params = { kind, reason }`). A URL from a
 * field, a template or an earlier step is checked when it is sent; a literal
 * that does not parse is `INVALID_URL` of the definition check.
 */
export async function checkHttpRequestSecrets(
  secrets: Pick<SecretsRepository, 'findUsable'>,
  scope: OrgScope,
  input: {
    readonly baseId: Id<'bse'>;
    readonly definition: AutomationDefinition;
    /** Clock of the transition period of secrets without a list (tests pin it). */
    readonly now?: Date;
  },
): Promise<ProblemErrorItem[]> {
  const errors: ProblemErrorItem[] = [];
  const now = input.now ?? new Date();
  const check = async (
    secretId: Id<'sec'>,
    kind: SecretKind,
    path: string,
    url: OutboundUrl | null,
  ): Promise<void> => {
    const row = await secrets.findUsable(scope, secretId, input.baseId, kind);
    if (row === undefined) {
      errors.push({
        path,
        code: SECRET_NOT_USABLE,
        message: 'This secret cannot be used by automations of this base',
        params: { kind },
      });
      return;
    }
    if (url === null) return;
    const decision = secretHostDecision(secretHostPolicyOf(row), url, now);
    if (!decision.allowed) {
      errors.push({
        path,
        code: SECRET_HOST_NOT_ALLOWED,
        message: 'This secret may not be sent to the host of this URL',
        params: { kind, reason: decision.reason },
      });
    }
  };
  for (const { action, path } of flattenActions(input.definition.actions)) {
    if (action.type !== 'run_n8n_workflow' && action.type !== 'http_request') continue;
    const url = literalUrlOf(action.config.url);
    // `run_n8n_workflow` (T607): its signing secret is required.
    if (action.type === 'run_n8n_workflow') {
      await check(
        action.config.signing_secret_id,
        'webhook_signing',
        `${path}.config.signing_secret_id`,
        url,
      );
      continue;
    }
    if (action.config.auth !== null) {
      await check(
        action.config.auth.secret_id,
        'http_header',
        `${path}.config.auth.secret_id`,
        url,
      );
    }
    if (action.config.signing_secret_id !== null) {
      await check(
        action.config.signing_secret_id,
        'webhook_signing',
        `${path}.config.signing_secret_id`,
        url,
      );
    }
  }
  return errors;
}

/** The normalised literal URL of a step, `null` for any other value or one that does not parse. */
function literalUrlOf(value: unknown): OutboundUrl | null {
  if (typeof value !== 'object' || value === null || !('literal' in value)) return null;
  const literal = (value as { readonly literal: unknown }).literal;
  if (typeof literal !== 'string') return null;
  try {
    return parseOutboundUrl(literal);
  } catch (error) {
    if (isOutboundHttpError(error)) return null;
    throw error;
  }
}
