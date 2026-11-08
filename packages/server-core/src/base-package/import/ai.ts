import { mentionsAny } from './phantoms.js';
import { asDefinition } from './pipeline.js';
import { reportAiField } from './report.js';

import type { BaseImportContext } from './pipeline.js';

/**
 * AI fields of a `.chbase` import (T1019, S9 research §2.6, CONTRACTS
 * §12.2, §29.5): their values came in as text/select values; once every
 * field the prompts may read exists (formula/lookup ones included),
 * `options.ai` of each is set and checked as when an AI field is saved —
 * same record only, no attachment, button, other AI field or itself, not a
 * primary field — except whether AI is available in the organization (an
 * import is not a generation). Nothing is queued: a value is generated
 * only once AI is available and a row changes or is generated again. Each
 * one is listed in `ai_fields`. A prompt naming an id of `missing_ids` is
 * kept as at the source.
 */
export async function importAiOptions(
  context: BaseImportContext,
  phantoms: ReadonlySet<string>,
  tick: () => Promise<void>,
): Promise<void> {
  const { plan, baseId, target, report } = context;
  for (const { table, field } of plan.deferred.aiFields) {
    if (field.ai === null) continue;
    const ai = field.ai;
    await target.checkpoint();
    await asDefinition(field.location.at('options', 'ai').toString(), () =>
      target.setFieldAi(baseId, {
        tableId: table.id,
        fieldId: field.id,
        ai,
        broken: mentionsAny(ai, phantoms),
      }),
    );
    reportAiField(report, { tableId: table.id, fieldId: field.id, name: field.name });
    await tick();
  }
}
