import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { submissionLimitSchema, type SubmissionLimit } from './forms.js';
import { idOf } from './ids.js';
import { offsetListSchema } from './pagination.js';

/**
 * Saved views (SPEC §8, CONTRACTS §15; BACKLOG T301). A view belongs to one
 * table; its `config` depends on its `type`. Every field reference is a
 * field id. The server validates configs against the current schema and the
 * saver's field permissions; here are the shapes.
 */

export const VIEW_TYPES = ['grid', 'kanban', 'form'] as const;
export const viewTypeSchema = z.enum(VIEW_TYPES).meta({ id: 'ViewType' });
export type ViewType = z.infer<typeof viewTypeSchema>;

export const ROW_HEIGHTS = ['short', 'medium', 'tall', 'extra_tall'] as const;

/** Most sort keys of a view. */
export const MAX_VIEW_SORTS = 10;
/** Most group levels of a view (SPEC §8). */
export const MAX_VIEW_GROUPS = 3;
/** Most personal views one user has on one table (BACKLOG S3 decision 4). */
export const MAX_PERSONAL_VIEWS_PER_TABLE = 50;
/** Most views (shared and personal) of one table (BACKLOG S3 decision 4). */
export const MAX_VIEWS_PER_TABLE = 200;
/** Longest view name, in characters after trimming. */
export const MAX_VIEW_NAME_LENGTH = 255;
/** Most field ids in one list of a config (`hidden_fields`, `field_order`…). */
export const MAX_VIEW_FIELD_LIST = 1000;
export const MIN_COLUMN_WIDTH = 40;
export const MAX_COLUMN_WIDTH = 2000;
export const MAX_FROZEN_COUNT = 50;
/** Most columns of one embedded sub-table (`record_detail.link_columns`, T402). */
export const MAX_LINK_COLUMNS = 50;
/** Most link fields with chosen columns in one view (`record_detail.link_columns`, T402). */
export const MAX_LINK_COLUMN_ENTRIES = 200;
/** Name of the grid view every new table gets. */
export const DEFAULT_VIEW_NAME = 'Grid view';

/** Detail code (`VALIDATION_FAILED`): the last shared view of a table cannot be deleted. */
export const LAST_VIEW = 'LAST_VIEW';
/**
 * Detail code (`VALIDATION_FAILED`): the table already has 200 views, or the
 * user already has 50 personal views on it (`params.limit`, `params.scope`
 * `table` | `personal`).
 */
export const VIEW_LIMIT_EXCEEDED = 'VIEW_LIMIT_EXCEEDED';
/** Detail code (`VALIDATION_FAILED`): the view is locked; its config cannot change until unlocked. */
export const VIEW_LOCKED = 'VIEW_LOCKED';
/** Detail code (`VALIDATION_FAILED`): a field of the config has a type the setting does not accept. */
export const INVALID_FIELD_TYPE = 'INVALID_FIELD_TYPE';
/** Detail code (`VALIDATION_FAILED`): a role's `visible_views` names something that is not a shared view of the table. */
export const UNKNOWN_VIEW = 'UNKNOWN_VIEW';

const viewNameSchema = z.string().trim().min(1).max(MAX_VIEW_NAME_LENGTH);
const fieldIdSchema = idOf('fld');
const fieldListSchema = z.array(fieldIdSchema).max(MAX_VIEW_FIELD_LIST);

export const viewSortItemSchema = z
  .strictObject({
    field: fieldIdSchema,
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .meta({ id: 'ViewSortItem' });

const filterSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .meta({
    description:
      'Filter DSL (SPEC §6) or tuple form (CONTRACTS §3), stored and returned as DSL; `null` = ' +
      'no filter. Conditions on fields the reader cannot read, or on deleted fields, are left ' +
      'out of responses (they still apply).',
  });

/**
 * Record panel settings (T402, F§10.2): columns of the embedded sub-table of
 * each link field, as field ids of the linked table. A link field without an
 * entry shows the first 5 fields of the linked table the viewer reads.
 */
export const recordDetailSettingsSchema = z
  .strictObject({
    link_columns: z
      .record(fieldIdSchema, z.array(fieldIdSchema).max(MAX_LINK_COLUMNS))
      .refine((value) => Object.keys(value).length <= MAX_LINK_COLUMN_ENTRIES, {
        message: `At most ${String(MAX_LINK_COLUMN_ENTRIES)} link fields`,
      })
      .meta({
        description:
          'Link field id (of this table) → columns of its embedded sub-table (fields of the ' +
          'linked table, in order, at most 50). Absent: the first 5 fields of the linked table ' +
          'the viewer reads',
      }),
  })
  .meta({ id: 'RecordDetailSettings' });

// --- Summary bar (T472, CONTRACTS §15) ---------------------------------------------

/**
 * Functions of the summary bar under a grid and of its group headers
 * (CONTRACTS §15 table). Every type has the counts (`count_all`, `filled`,
 * `empty`, `unique`) and the percentages of filled / empty cells; numbers
 * add `sum`…`range`, dates `earliest`…`date_range`; check boxes have
 * `count_all` and their own three instead.
 */
export const SUMMARY_FUNCTIONS = [
  'count_all',
  'filled',
  'empty',
  'unique',
  'percent_filled',
  'percent_empty',
  'sum',
  'avg',
  'min',
  'max',
  'range',
  'earliest',
  'latest',
  'date_range',
  'checked',
  'unchecked',
  'percent_checked',
] as const;
export type SummaryFunction = (typeof SUMMARY_FUNCTIONS)[number];
export const summaryFunctionSchema = z.enum(SUMMARY_FUNCTIONS).meta({
  id: 'SummaryFunction',
  description: 'A function of the summary bar (CONTRACTS §15: which ones a field type accepts)',
});

/** Counts every type offers (check boxes: `count_all` only). */
export const COUNT_SUMMARY_FUNCTIONS = ['count_all', 'filled', 'empty', 'unique'] as const;
export const PERCENT_SUMMARY_FUNCTIONS = ['percent_filled', 'percent_empty'] as const;
export const NUMBER_SUMMARY_FUNCTIONS = ['sum', 'avg', 'min', 'max', 'range'] as const;
export const DATE_SUMMARY_FUNCTIONS = ['earliest', 'latest', 'date_range'] as const;
export const CHECKBOX_SUMMARY_FUNCTIONS = ['checked', 'unchecked', 'percent_checked'] as const;
/** Functions whose value is a share of the records (`value` 0…1 plus the `count` behind it). */
export const PERCENT_SUMMARIES: ReadonlySet<SummaryFunction> = new Set([
  'percent_filled',
  'percent_empty',
  'percent_checked',
]);

/**
 * What a field summarises as (CONTRACTS §15): `number` (number fields,
 * formula/lookup with a single number result), `date` (datetime,
 * created/updated at, single date or date-time results), `checkbox`
 * (check boxes, single boolean results), `other` (text, select, user,
 * link, attachment, auto number — a formatted text —, lists…).
 */
export type SummaryKind = 'number' | 'date' | 'checkbox' | 'other';

/** The result type of a formula/lookup field (`result_type` of the field API). */
export interface SummaryResultType {
  readonly kind: string;
  readonly list: boolean;
}

export function summaryKindOf(type: string, resultType?: SummaryResultType | null): SummaryKind {
  switch (type) {
    case 'number':
      return 'number';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'checkbox':
      return 'checkbox';
    case 'formula':
    case 'lookup': {
      if (resultType === undefined || resultType === null || resultType.list) return 'other';
      if (resultType.kind === 'number') return 'number';
      if (resultType.kind === 'date' || resultType.kind === 'datetime') return 'date';
      return resultType.kind === 'boolean' ? 'checkbox' : 'other';
    }
    default:
      return 'other';
  }
}

/** The summary functions a field accepts, in menu order (CONTRACTS §15). */
export function summaryFunctionsOf(
  type: string,
  resultType?: SummaryResultType | null,
): readonly SummaryFunction[] {
  // A button (T517) has no value to summarise.
  if (type === 'button') return [];
  const kind = summaryKindOf(type, resultType);
  if (kind === 'checkbox') return ['count_all', ...CHECKBOX_SUMMARY_FUNCTIONS];
  const common = [...COUNT_SUMMARY_FUNCTIONS, ...PERCENT_SUMMARY_FUNCTIONS];
  if (kind === 'number') return [...common, ...NUMBER_SUMMARY_FUNCTIONS];
  if (kind === 'date') return [...common, ...DATE_SUMMARY_FUNCTIONS];
  return common;
}

/** Most entries of `summaries` (a view config, a request). */
export const MAX_SUMMARY_FIELDS = 500;

/** `summaries` of a grid view: field id → function (T472). */
export const viewSummariesSchema = z
  .record(idOf('fld'), summaryFunctionSchema)
  .refine((value) => Object.keys(value).length <= MAX_SUMMARY_FIELDS, {
    message: `At most ${String(MAX_SUMMARY_FIELDS)} fields`,
  })
  .meta({
    id: 'ViewSummaries',
    description:
      'Summary bar of a grid view (T472): field id → function (CONTRACTS §15). Entries on ' +
      'fields the reader cannot read, deleted fields, or functions the field type no longer ' +
      'accepts are left out of responses and ignored by `records/summaries`',
  });

// --- Color rules (T816, CONTRACTS §15) ---------------------------------------------

/**
 * Palette of color rules (T816, S7 decision #21): ten tokens the clients map
 * to a background and an accent stripe readable in light and dark themes.
 */
export const COLOR_RULE_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
  'gray',
] as const;
export type ColorRuleColor = (typeof COLOR_RULE_COLORS)[number];
export const colorRuleColorSchema = z.enum(COLOR_RULE_COLORS).meta({
  id: 'ColorRuleColor',
  description: 'A color token of the palette (T816)',
});

export const COLOR_RULE_TARGETS = ['row', 'cell'] as const;
export type ColorRuleTarget = (typeof COLOR_RULE_TARGETS)[number];

/** Most color rules of one view (hidden ones included). */
export const MAX_COLOR_RULES = 20;

/** Detail code (`VALIDATION_FAILED`): two color rules of a view have the same id. */
export const DUPLICATE_RULE = 'DUPLICATE_RULE';

/**
 * A color rule as a request sends it (T816): the first enabled rule whose
 * filter matches a record wins its row (`target: row`) or the cell of
 * `field_id` (`target: cell`). Rules are evaluated by the server for the
 * reader (`record.meta.color`), never by clients.
 */
export const colorRuleInputSchema = z
  .strictObject({
    id: idOf('clr').meta({ description: 'Chosen by the client (`clr_` + 16 base62)' }),
    enabled: z.boolean().default(true),
    filter: filterSchema.default(null).meta({
      description:
        'Filter DSL (SPEC §6) or tuple form (CONTRACTS §3), stored as DSL; `null` = every record',
    }),
    color: colorRuleColorSchema,
    target: z.enum(COLOR_RULE_TARGETS),
    field_id: fieldIdSchema
      .nullable()
      .default(null)
      .meta({ description: 'The colored cell’s field: required with `target: cell`, else `null`' }),
  })
  .meta({ id: 'ColorRuleInput' });
export type ColorRuleInput = z.input<typeof colorRuleInputSchema>;

/** `color_rules` of a request: at most {@link MAX_COLOR_RULES}, order = priority. */
export const colorRulesInputSchema = z.array(colorRuleInputSchema).max(MAX_COLOR_RULES);

/** A color rule of a view in responses. */
export const colorRuleSchema = z
  .object({
    id: idOf('clr'),
    enabled: z.boolean(),
    filter: filterSchema,
    color: colorRuleColorSchema,
    target: z.enum(COLOR_RULE_TARGETS),
    field_id: fieldIdSchema.nullable(),
    broken: z
      .boolean()
      .optional()
      .meta({
        description:
          'Present (`true`) when the rule names a deleted field: it colors nothing until the ' +
          'field is restored or the rule is saved again (conditions on deleted fields are left ' +
          'out of `filter`; a deleted cell field reads `field_id: null`)',
      }),
  })
  .meta({ id: 'ColorRule' });
export type ColorRuleDto = z.infer<typeof colorRuleSchema>;

/** A stored color rule (`meta.views.config.color_rules[i]`). */
export interface StoredColorRule {
  id: string;
  enabled: boolean;
  filter: Record<string, unknown> | null;
  color: ColorRuleColor;
  target: ColorRuleTarget;
  field_id: string | null;
  /** Responses only: the rule names a deleted field. */
  broken?: true;
}

/** Settings shared by every view type. All keys optional: a `PATCH` sends only what changes. */
const commonShape = {
  filter: filterSchema,
  sort: z.array(viewSortItemSchema).max(MAX_VIEW_SORTS),
  group: z.array(viewSortItemSchema).max(MAX_VIEW_GROUPS),
  hidden_fields: fieldListSchema,
  field_order: fieldListSchema,
  column_widths: z.record(fieldIdSchema, z.int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH)),
  frozen_count: z.int().min(0).max(MAX_FROZEN_COUNT),
  row_height: z.enum(ROW_HEIGHTS),
  tree: z.strictObject({ enabled: z.boolean(), show_ancestors: z.boolean() }),
  record_detail: recordDetailSettingsSchema,
};

export const kanbanSettingsSchema = z
  .strictObject({
    group_field: fieldIdSchema.nullable().meta({
      description: 'A single `select` or single `user` field; `null` until chosen',
    }),
    card_fields: fieldListSchema,
    cover_field: fieldIdSchema.nullable().meta({ description: 'An `attachment` field (S4)' }),
    hide_empty_columns: z.boolean().meta({
      description: 'Columns without any record are not shown (T314); `false` by default',
    }),
  })
  .meta({ id: 'KanbanSettings' });

export const formFieldSchema = z
  .strictObject({
    field: fieldIdSchema,
    required: z.boolean().default(false),
    label: z.string().max(255).nullable().default(null),
    help: z.string().max(1000).nullable().default(null),
  })
  .meta({ id: 'FormField' });

const redirectUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .nullable()
  .meta({ description: 'Absolute `http(s)` URL opened after a submission' });

export const formSettingsSchema = z
  .strictObject({
    title: z.string().max(255),
    description: z.string().max(5000),
    cover_attachment_id: idOf('att')
      .nullable()
      .meta({
        description:
          'Cover image (T419): a `ready` cover uploaded for a form view of this table through ' +
          '`POST /views/{viewId}/form-cover/uploads`; a new value must be the saver’s own ' +
          'upload (`422` `ATTACHMENT_NOT_FOUND` otherwise); `null` = none',
      }),
    fields: z.array(formFieldSchema).max(500),
    success_message: z.string().max(2000),
    redirect_url: redirectUrlSchema,
    allow_multiple_submissions: z.boolean().meta({
      description:
        'Kept in step with `submission_limit`: `false` ⇔ a limit other than `none` (sending ' +
        '`false` alone sets `submission_limit = once`; `true` alone sets `none`)',
    }),
    require_login: z.boolean().meta({
      description:
        'Submitting needs a signed-in user (any user of the instance through a public link; ' +
        'a member of the organization through an `org` link)',
    }),
    submission_limit: submissionLimitSchema,
  })
  .meta({ id: 'FormSettings' });

/**
 * Config of each view type as a request sends it: every key optional. On
 * create, missing keys take their defaults; on `PATCH`, top-level keys
 * replace the stored ones (`kanban` and `form` merge one level deeper).
 */
export const gridConfigInputSchema = z
  .strictObject({
    ...commonShape,
    summaries: viewSummariesSchema,
    color_rules: colorRulesInputSchema,
  })
  .partial();
export const kanbanConfigInputSchema = z
  .strictObject({ ...commonShape, kanban: kanbanSettingsSchema.partial() })
  .partial();
export const formConfigInputSchema = z
  .strictObject({ ...commonShape, form: formSettingsSchema.partial() })
  .partial();

export const VIEW_CONFIG_INPUT_SCHEMAS = {
  grid: gridConfigInputSchema,
  kanban: kanbanConfigInputSchema,
  form: formConfigInputSchema,
} as const;

export type GridConfigInput = z.infer<typeof gridConfigInputSchema>;
export type KanbanConfigInput = z.infer<typeof kanbanConfigInputSchema>;
export type FormConfigInput = z.infer<typeof formConfigInputSchema>;
export type ViewConfigInput = GridConfigInput | KanbanConfigInput | FormConfigInput;

/** A complete, stored config (as the server keeps it). */
export interface StoredViewSort {
  field: string;
  direction: 'asc' | 'desc';
}
export interface StoredKanbanSettings {
  group_field: string | null;
  card_fields: string[];
  cover_field: string | null;
  hide_empty_columns: boolean;
}
export interface StoredFormField {
  field: string;
  required: boolean;
  label: string | null;
  help: string | null;
}
export interface StoredFormSettings {
  title: string;
  description: string;
  cover_attachment_id: string | null;
  fields: StoredFormField[];
  success_message: string;
  redirect_url: string | null;
  allow_multiple_submissions: boolean;
  require_login: boolean;
  submission_limit: SubmissionLimit;
}
export interface StoredRecordDetailSettings {
  link_columns: Record<string, string[]>;
}
export interface StoredViewConfig {
  filter: Record<string, unknown> | null;
  sort: StoredViewSort[];
  group: StoredViewSort[];
  hidden_fields: string[];
  field_order: string[];
  column_widths: Record<string, number>;
  frozen_count: number;
  row_height: (typeof ROW_HEIGHTS)[number];
  tree: { enabled: boolean; show_ancestors: boolean };
  record_detail: StoredRecordDetailSettings;
  /** Grid views only (T472): field id → summary function. */
  summaries?: Record<string, SummaryFunction>;
  /** Grid views only (T816): color rules, order = priority. */
  color_rules?: StoredColorRule[];
  kanban?: StoredKanbanSettings;
  form?: StoredFormSettings;
}

/** Config of a view in responses: every key present (`kanban` / `form` by type). */
export const viewConfigSchema = z
  .object({
    ...commonShape,
    sort: z.array(viewSortItemSchema),
    group: z.array(viewSortItemSchema),
    hidden_fields: z.array(fieldIdSchema),
    field_order: z.array(fieldIdSchema),
    record_detail: recordDetailSettingsSchema.optional().meta({
      description:
        'Always present in responses (T402); optional in the schema so that configs built ' +
        'by clients before T402 still type-check',
    }),
    summaries: viewSummariesSchema.optional().meta({
      description: 'Grid views only (T472): the summary bar, field id → function',
    }),
    color_rules: z
      .array(colorRuleSchema)
      .optional()
      .meta({
        description:
          'Grid views only (T816): color rules, order = priority. Rules naming a field the ' +
          'reader cannot read are left out (they still apply for those who can)',
      }),
    kanban: kanbanSettingsSchema.optional().meta({ description: 'Kanban views only' }),
    form: formSettingsSchema
      .extend({ fields: z.array(formFieldSchema) })
      .optional()
      .meta({ description: 'Form views only' }),
  })
  .meta({
    id: 'ViewConfig',
    description:
      'Saved settings of a view (SPEC §8, CONTRACTS §15). Everything that names a field the ' +
      'reader cannot read, or a deleted field, is left out (filter conditions, sort and group ' +
      'items, list entries, widths). References to deleted fields stay stored and come back ' +
      'when the field is restored.',
  });
export type ViewConfigDto = z.infer<typeof viewConfigSchema>;

export const viewSchema = z
  .object({
    id: idOf('viw'),
    table_id: idOf('tbl'),
    type: viewTypeSchema,
    name: z.string(),
    is_personal: z.boolean().meta({ description: 'Personal views are seen by their owner only' }),
    owner_id: idOf('usr')
      .nullable()
      .meta({ description: 'Owner of a personal view; `null` for shared views' }),
    position: z.int().min(0).meta({
      description: 'Sort key among the shared views (or among the owner’s personal views)',
    }),
    locked: z.boolean().meta({
      description:
        'Shared views only: the config cannot change until someone with schema rights on ' +
        'the table unlocks it',
    }),
    config: viewConfigSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'View' });
export type ViewDto = z.infer<typeof viewSchema>;

export const viewListSchema = offsetListSchema(viewSchema).meta({ id: 'ViewList' });
export type ViewList = z.infer<typeof viewListSchema>;

const configInputSchema = z.record(z.string(), z.unknown()).meta({
  description:
    'Settings by view type (`ViewConfig`): grid → common keys; kanban → also `kanban`; form → ' +
    'also `form`. Validated against the table and the saver’s field permissions.',
});

const positionSchema = z
  .int()
  .min(0)
  .meta({
    description:
      'New 0-based index among the shared views of the table (personal views: among the ' +
      'owner’s personal views of the table), clamped; the others shift',
  });

export const createViewRequestSchema = z
  .strictObject({
    name: viewNameSchema,
    type: viewTypeSchema,
    is_personal: z.boolean().default(false),
    config: configInputSchema.optional(),
  })
  .meta({ id: 'CreateViewRequest' });
export type CreateViewRequest = z.infer<typeof createViewRequestSchema>;

export const updateViewRequestSchema = z
  .strictObject({
    name: viewNameSchema.optional(),
    position: positionSchema.optional(),
    is_personal: z
      .boolean()
      .optional()
      .meta({
        description:
          'Turn a shared view into a personal view of the caller or back. Needs view editing ' +
          'rights; the table keeps at least one shared view (`LAST_VIEW`)',
      }),
    locked: z.boolean().optional().meta({
      description: 'Lock or unlock a shared view; needs schema rights on the table',
    }),
    config: configInputSchema.optional().meta({
      description:
        'Top-level keys replace the stored ones; `kanban` and `form` merge one level deeper. ' +
        'Keys left out stay as they are.',
    }),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  })
  .meta({ id: 'UpdateViewRequest' });
export type UpdateViewRequest = z.infer<typeof updateViewRequestSchema>;

export const duplicateViewRequestSchema = z
  .strictObject({
    name: viewNameSchema.optional().meta({
      description: 'Default: the source name followed by ` copy` (then ` copy 2`, …)',
    }),
    is_personal: z.boolean().optional().meta({ description: 'Default: as the source view' }),
  })
  .meta({ id: 'DuplicateViewRequest' });
export type DuplicateViewRequest = z.infer<typeof duplicateViewRequestSchema>;
