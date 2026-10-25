import { z } from 'zod';

import {
  automationActionIdSchema,
  automationFilterSchema,
  automationValueSchema,
} from '../automation-values.js';

/** Bounds of `delay` (1 minute – 30 days, SPEC §11.5). */
export const MIN_DELAY_MINUTES = 1;
export const MAX_DELAY_MINUTES = 43_200;

/**
 * `delay` (SPEC §11.5, ADR-18; BACKLOG T506): the run goes `waiting` (no
 * worker held, waiting time is not running time) until `minutes` from the
 * step, or until the instant `until` resolves to; then, unless the
 * trigger record was deleted meanwhile (`skipped` `record_deleted`), it
 * re-reads the trigger record and ends the run `skipped`
 * (`recheck_not_matched`) when `recheck_condition` no longer matches.
 * Exactly one of `minutes` and `until`.
 */
export const delayActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('delay'),
    config: z
      .strictObject({
        minutes: z
          .int()
          .min(MIN_DELAY_MINUTES)
          .max(MAX_DELAY_MINUTES)
          .nullable()
          .default(null)
          .meta({ description: 'Wait this long (1 minute – 30 days); `null` when `until` is set' }),
        until: automationValueSchema
          .nullable()
          .default(null)
          .meta({
            description:
              'Wait until this date (`YYYY-MM-DD` = midnight, `YYYY-MM-DDTHH:mm` in the ' +
              'organization zone, or an ISO instant), e.g. `{ "field": "fld_due" }`; at most ' +
              '30 days ahead (else the step fails `invalid_value`), already past = no wait',
          }),
        recheck_condition: automationFilterSchema.nullable().default(null).meta({
          description: 'Filter on the trigger record, re-evaluated when the delay ends',
        }),
      })
      .refine((config) => (config.minutes === null) !== (config.until === null), {
        message: 'Set exactly one of minutes and until',
        path: ['minutes'],
      }),
  })
  .meta({ id: 'DelayAction' });
export type DelayAction = z.infer<typeof delayActionSchema>;
