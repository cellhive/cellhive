import { type AutomationDefinition, type ProblemErrorItem } from '@cellhive/contracts';

import { requireAi, type AiSettingsState } from '../../../ai/settings/settings.js';
import { AppError } from '../../../errors/app-error.js';
import { flattenActions } from '../../definition/validate.js';

import type { OrgScope } from '../../../db/repository.js';

const AI_ACTION_TYPES: ReadonlySet<string> = new Set(['ai_generate_text', 'ai_classify']);

/**
 * Save-time check of the AI actions that needs the database (BACKLOG
 * T911, CONTRACTS §29.6): AI available and `allow_record_data` on, else
 * `AI_NOT_CONFIGURED` / `AI_RECORD_DATA_DISABLED` at each AI action
 * (`…actions[i].type`) under `422 AUTOMATION_INVALID`. The rest (prompt,
 * target field) is `validateAutomationDefinition`.
 */
export async function checkAiActions(
  settings: { find(scope: OrgScope): Promise<AiSettingsState | undefined> },
  scope: OrgScope,
  definition: AutomationDefinition,
): Promise<ProblemErrorItem[]> {
  const steps = flattenActions(definition.actions).filter(({ action }) =>
    AI_ACTION_TYPES.has(action.type),
  );
  if (steps.length === 0) return [];
  try {
    requireAi(await settings.find(scope), { recordData: true });
    return [];
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return steps.map(({ path }) => ({
      path: `${path}.type`,
      code: error.code,
      message: error.detail ?? 'AI cannot be used by automations of this organization',
    }));
  }
}
