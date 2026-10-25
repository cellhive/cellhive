import { z } from 'zod';

import { automationFilterSchema } from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * `record.matches` (BACKLOG S5 decision 7, T510): fires when a record goes
 * from not matching `condition` to matching it — created or restored
 * matching, or changed into it (recomputed stored formula/lookup values
 * included) — and not again while it keeps matching; leaving and entering
 * again fires again. The condition is validated like a filter of the table
 * (at least one condition, no `changed*`, no virtual formula/lookup) and
 * tested as `run_as`; time passing alone never fires it.
 */
export const recordMatchesTriggerSchema = z
  .strictObject({
    type: z.literal('record.matches'),
    table_id: idOf('tbl'),
    condition: automationFilterSchema,
    skip_bulk: z.boolean().default(false).meta({
      description:
        'Ignore bulk changes and imports (ADR-26 §2–3): no run and no circuit-breaker count for them',
    }),
  })
  .meta({
    id: 'RecordMatchesTrigger',
    description:
      'Fires once when a record enters `condition` (created, restored or changed into it, ' +
      'recomputed values included); not again while it keeps matching. `condition`: at least ' +
      'one condition, no `changed*`, no virtual formula/lookup',
  });
