import { z } from 'zod';

import { AGGREGATE_PLAN_TYPES } from './aggregate-plan.js';
import { timeZoneSchema } from './auth.js';
import { widgetDataSchema } from './dashboard-data.js';
import {
  dateBucketSchema,
  MAX_WIDGET_TITLE_LENGTH,
  metricAggregationSchema,
  PREVIOUS_PERIOD_RANGES,
  widgetConfigSchema,
} from './dashboard-widgets.js';
import { idOf } from './ids.js';

/**
 * AI Q&A on a table (CONTRACTS §29.4, SPEC §12.2 #3, ADR-39; BACKLOG T909):
 * a question becomes a plan by name, the plan a temporary widget, the answer
 * its numbers computed with the asker's permissions. A narrative only when
 * the organization lets AI see record data. Nothing is stored or cached.
 */

/** Longest question. */
export const AI_ASK_MAX_QUESTION_LENGTH = 500;
/** `max_output_tokens` of the plan call (and of each repair round). */
export const AI_ASK_PLAN_MAX_OUTPUT_TOKENS = 600;
/** `max_output_tokens` of the narrative call. */
export const AI_ASK_NARRATIVE_MAX_OUTPUT_TOKENS = 400;
/** Groups a plan may ask for (`limit`), and aggregated rows the narrative call gets. */
export const AI_ASK_MAX_GROUPS = 50;
/** Conditions of a plan's filter. */
export const AI_ASK_MAX_CONDITIONS = 10;

export const aiAskRequestSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(AI_ASK_MAX_QUESTION_LENGTH).meta({
      description: 'A question about the records of the table, in any language',
      example: 'Doanh thu theo tháng',
    }),
    timezone: timeZoneSchema
      .nullable()
      .default(null)
      .meta({
        description:
          'IANA zone of date buckets, relative dates and periods; default the zone of the ' +
          'user, then of the organization',
      }),
  })
  .meta({ id: 'AiAskRequest' });
export type AiAskRequest = z.output<typeof aiAskRequestSchema>;

const fieldRefSchema = z
  .strictObject({ id: idOf('fld'), name: z.string() })
  .meta({ id: 'AiAskField', description: 'A field of the table the asker reads' });

export const aiAskInterpretationSchema = z
  .strictObject({
    metric: metricAggregationSchema,
    field: fieldRefSchema
      .nullable()
      .meta({ description: 'Field of the metric; `null` for `count`' }),
    dimension: fieldRefSchema.nullable().meta({ description: 'Grouped by; `null` for a KPI' }),
    bucket: dateBucketSchema.nullable().meta({ description: 'Date bucket of the dimension' }),
    series: fieldRefSchema.nullable(),
    series_bucket: dateBucketSchema.nullable(),
    filter_logic: z.enum(['and', 'or']),
    filters: z.array(
      z.strictObject({
        field: fieldRefSchema,
        operator: z.string().meta({
          description:
            'Tuple operator of CONTRACTS §3: `==`, `!=`, `>`, `>=`, `<`, `<=`, `intersects`, ' +
            '`disjoint`, `empty`, `non_empty`',
        }),
        value: z.unknown().meta({
          description:
            'As planned: option names, numbers, text, `ExactDate(…)`, `Today`, `CurrentUser`…; ' +
            '`null` for `empty`/`non_empty`',
        }),
      }),
    ),
    compare: z
      .enum(PREVIOUS_PERIOD_RANGES)
      .nullable()
      .meta({ description: 'KPI compared with the previous period of this length' }),
  })
  .meta({
    id: 'AiAskInterpretation',
    description:
      'How the question was understood, built from the plan without the model: what the ' +
      'numbers are, whatever the narrative says',
  });
export type AiAskInterpretation = z.infer<typeof aiAskInterpretationSchema>;

export const aiAskSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('ok'),
      interpretation: aiAskInterpretationSchema,
      widget: z.strictObject({
        type: z.enum(AGGREGATE_PLAN_TYPES),
        title: z.string().max(MAX_WIDGET_TITLE_LENGTH),
        config: widgetConfigSchema.meta({
          description:
            'Widget config with ids (CONTRACTS §28.2), as a dashboard widget would store it',
        }),
      }),
      data: widgetDataSchema,
      narrative: z
        .string()
        .nullable()
        .meta({
          description:
            'Plain text written by the model from the aggregated numbers; `null` unless the ' +
            'organization lets AI see record data (or the call failed, or nothing matched)',
        }),
    }),
    z.strictObject({
      status: z.literal('unanswerable').meta({
        description:
          'The question cannot be answered from the fields the asker reads (never says which)',
      }),
    }),
  ])
  .meta({ id: 'AiAsk' });
export type AiAsk = z.infer<typeof aiAskSchema>;
