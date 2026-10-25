import {
  SECRET_NOT_USABLE,
  type AutomationDefinition,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { flattenActions } from '../../definition/validate.js';

import type { OrgScope } from '../../../db/repository.js';
import type { SecretsRepository } from '../../../secrets/secrets.repository.js';

/**
 * Save-time check of `send_telegram` that needs the database (BACKLOG
 * T516): the secret must be a `telegram_bot` secret of the organization
 * whose scope includes the base. Missing, of another organization or kind,
 * or out of scope are the same `SECRET_NOT_USABLE` (no existence leak).
 * The rest is `validateAutomationDefinition`.
 */
export async function checkSendTelegramSecrets(
  secrets: Pick<SecretsRepository, 'findUsable'>,
  scope: OrgScope,
  input: { readonly baseId: Id<'bse'>; readonly definition: AutomationDefinition },
): Promise<ProblemErrorItem[]> {
  const errors: ProblemErrorItem[] = [];
  for (const { action, path } of flattenActions(input.definition.actions)) {
    if (action.type !== 'send_telegram') continue;
    const secret = await secrets.findUsable(
      scope,
      action.config.secret_id,
      input.baseId,
      'telegram_bot',
    );
    if (secret === undefined) {
      errors.push({
        path: `${path}.config.secret_id`,
        code: SECRET_NOT_USABLE,
        message: 'This bot cannot be used by automations of this base',
      });
    }
  }
  return errors;
}
