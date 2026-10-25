import {
  AUTOMATION_DISALLOWED_FUNCTIONS,
  isTemplateReferenceId,
  NO_TRIGGER_RECORD,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import { checkTemplate, type TemplateCheck, SchemaSnapshot } from '@cellhive/formula-engine';

import { NO_RECORD_TABLE } from './snapshot.js';
import { withWebhookReferences } from './webhook-data.js';

/**
 * Checks an automation template (BACKLOG T504, SPEC §11.4): formula
 * expressions between `{{ }}` against `snapshot` (what the saver — the
 * future `run_as` — reads, plus the trigger and step references of T505), `REGEX*` refused (`UNSUPPORTED_FUNCTION`,
 * S4b-followup §1.4), no whole-table reference (`CROSS_TABLE_NOT_SUPPORTED`).
 * Problems become `errors[]` items under `path` with `params.position`.
 */
export interface AutomationTemplateCheck {
  readonly check: TemplateCheck;
  readonly errors: ProblemErrorItem[];
}

export function checkAutomationTemplate(
  source: string,
  snapshot: SchemaSnapshot,
  path: string,
  form: 'stored' | 'display' = 'stored',
): AutomationTemplateCheck {
  // `[@body.<path>]`… of a `webhook.received` row (T604): declared per template.
  const check = checkTemplate(source, withWebhookReferences(snapshot, source), {
    form,
    disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
    allowTables: false,
    referenceIds: isTemplateReferenceId,
  });
  const noRecord = snapshot.tableId === NO_RECORD_TABLE;
  const errors = check.errors.map((problem): ProblemErrorItem => {
    const reference = problem.params['id'] ?? problem.params['name'];
    if (
      noRecord &&
      problem.code === 'UNKNOWN_FIELD' &&
      !(typeof reference === 'string' && isTemplateReferenceId(reference))
    ) {
      return {
        path,
        code: NO_TRIGGER_RECORD,
        message:
          'This trigger has no record: a template can only use constants, NOW(), TODAY(), the trigger data and earlier steps',
        params: { position: problem.params.position },
      };
    }
    return { path, code: problem.code, message: problem.message, params: { ...problem.params } };
  });
  return { check, errors };
}
