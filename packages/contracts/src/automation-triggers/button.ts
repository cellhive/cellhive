import { z } from 'zod';

import { automationFilterSchema } from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * `button.clicked` (ADR-32 §2): a click on a button field runs the
 * automation as `run_as`. `min_permission` and `enabled_when` are part of
 * the definition, so changing them moves `run_as` (ADR-25 §2). `field_id`
 * must be a `button` field (`INVALID_FIELD_TYPE`), with no other automation
 * attached (`BUTTON_IN_USE`); clicks: `buttons.ts` and CONTRACTS §21 (T517).
 */
export const buttonClickedTriggerSchema = z
  .strictObject({
    type: z.literal('button.clicked'),
    table_id: idOf('tbl'),
    field_id: idOf('fld'),
    min_permission: z.enum(['edit', 'read']).default('edit').meta({
      description: 'Least permission on the record needed to click (`read` must be explicit)',
    }),
    enabled_when: automationFilterSchema.nullable().default(null),
  })
  .meta({ id: 'ButtonClickedTrigger' });
