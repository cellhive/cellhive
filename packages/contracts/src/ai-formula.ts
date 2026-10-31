import { z } from 'zod';

import { computedResultTypeSchema } from './computed-fields.js';
import { idOf } from './ids.js';

/**
 * "Write the formula with AI" (CONTRACTS §29.2, SPEC §12.2 #1, ADR-39;
 * BACKLOG T907): a description becomes a formula checked exactly like a
 * save, against what the caller may read. Nothing is stored.
 */

/** Longest description of the formula to write. */
export const AI_FORMULA_MAX_DESCRIPTION_LENGTH = 1_000;
/** Longest formula in display form (SPEC §9.5, `MAX_FORMULA_LENGTH` of the formula engine). */
export const AI_FORMULA_MAX_FORMULA_LENGTH = 4_000;
/** `max_output_tokens` of each call. */
export const AI_FORMULA_MAX_OUTPUT_TOKENS = 600;

export const aiFormulaRequestSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(AI_FORMULA_MAX_DESCRIPTION_LENGTH).meta({
      description: 'What the formula should compute, in any language',
      example: 'Profit: amount minus cost, 0 when the order is not done',
    }),
    current: z
      .string()
      .max(AI_FORMULA_MAX_FORMULA_LENGTH)
      .nullable()
      .default(null)
      .meta({
        description:
          'The formula in the editor (display form, names), possibly broken: the model may ' +
          'fix or extend it',
      }),
    field_id: idOf('fld')
      .nullable()
      .default(null)
      .meta({
        description:
          'The formula field being edited, if any: left out of the schema sent to the model, ' +
          'and the answer may not refer to it, directly or through a cycle',
      }),
  })
  .meta({ id: 'AiFormulaRequest' });
export type AiFormulaRequest = z.output<typeof aiFormulaRequestSchema>;

export const aiFormulaSchema = z
  .strictObject({
    formula: z.string().meta({
      description:
        'The formula in display form (names), checked like `POST /tables/{tableId}/fields` ' +
        'would check it for the caller; not saved',
      example: '[amount] - [cost]',
    }),
    result_type: computedResultTypeSchema,
    explanation: z.string().meta({ description: 'What the formula does, written by the model' }),
    attempts: z.int().min(1).max(3).meta({ description: 'Provider calls: 1 + repair rounds' }),
  })
  .meta({ id: 'AiFormula' });
export type AiFormula = z.infer<typeof aiFormulaSchema>;
