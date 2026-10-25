import { z } from 'zod';

import {
  automationActionIdSchema,
  automationFilterSchema,
  automationValueSchema,
} from '../automation-values.js';

/** Most conditions of one `if` step. */
export const MAX_IF_CONDITIONS = 10;

/** Operators of a value condition (SPEC §11.3). */
export const IF_VALUE_OPERATORS = [
  'is',
  'is_not',
  'contains',
  'is_empty',
  'is_not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;

/** A Filter DSL condition on the latest trigger record. */
export const ifFilterConditionSchema = z
  .strictObject({ filter: automationFilterSchema })
  .meta({ id: 'IfFilterCondition' });

/** A comparison of two values (SPEC §11.3, §11.4). */
export const ifValueConditionSchema = z
  .strictObject({
    value: automationValueSchema,
    operator: z.enum(IF_VALUE_OPERATORS),
    compare: automationValueSchema.nullable().default(null),
  })
  .meta({ id: 'IfValueCondition' });

export const ifConditionSchema = z.union([ifFilterConditionSchema, ifValueConditionSchema]);

/**
 * The one-level `if` step (SPEC §11.3, §11.5) with branches of
 * `branchAction` (every action type except `if`: no nesting). Built by
 * `automations.ts`, which owns the action union. Frame of BACKLOG T502;
 * evaluated by the run engine (T505, `actions/if` of server-core).
 */
export function ifActionSchemaOf<T extends z.ZodType>(branchAction: T) {
  return z
    .strictObject({
      id: automationActionIdSchema,
      type: z.literal('if'),
      config: z.strictObject({
        match: z.enum(['and', 'or']).default('and'),
        conditions: z.array(ifConditionSchema).min(1).max(MAX_IF_CONDITIONS),
        on_false: z.enum(['else', 'stop']).default('else').meta({
          description: '`stop` ends the run as `succeeded` when the conditions do not hold',
        }),
        then: z.array(branchAction).default([]),
        else: z.array(branchAction).default([]),
      }),
    })
    .meta({ id: 'IfAction' });
}
