import { z } from 'zod';

import { idOf } from '../ids.js';

/**
 * `form.submitted` (SPEC §11.2, CONTRACTS §8, §17): one run per accepted
 * submission of a form view. Frame of BACKLOG T502; dispatch is T503.
 */
export const formSubmittedTriggerSchema = z
  .strictObject({
    type: z.literal('form.submitted'),
    view_id: idOf('viw').meta({ description: 'A shared form view' }),
  })
  .meta({ id: 'FormSubmittedTrigger' });
