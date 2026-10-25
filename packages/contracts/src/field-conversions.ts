import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { fieldOptionsSchema, fieldSchema, fieldTypeNameSchema } from './tables.js';

/**
 * Field type conversion (SPEC §5.5, CONTRACTS §4, ADR-23 §3; BACKLOG T403):
 * `POST /fields/:id/convert-preview`, `PUT /fields/:id`,
 * `POST /fields/:id/revert-conversion/preview` and
 * `POST /fields/:id/revert-conversion`. T463: from a formula/lookup to a
 * stored type ("convert to static values") and from any type to a
 * formula/lookup (CONTRACTS §4.1/§4.4).
 */

/** A converted field can be reverted for 7 days (SPEC §5.5, ADR-23 §3). */
export const FIELD_CONVERSION_REVERT_WINDOW_DAYS = 7;
/** Rows converted per transaction by the `field.convert` job (SPEC §5.5). */
export const FIELD_CONVERSION_BATCH_SIZE = 5000;
/** Examples returned by a preview (SPEC §5.5 item 4). */
export const FIELD_CONVERSION_SAMPLE_LIMIT = 20;
/** `meta.jobs.type` of the backfill job. */
export const FIELD_CONVERT_JOB_TYPE = 'field.convert';

/** CONTRACTS §4 kinds; see `classifyConversion` of `@cellhive/field-types`. */
export const FIELD_CONVERSION_KINDS = [
  'none',
  'keep',
  'truncate',
  'blacklist',
  'forbidden',
] as const;
export type FieldConversionKind = (typeof FIELD_CONVERSION_KINDS)[number];

/**
 * Link conversions (ADR-28, CONTRACTS §4.1/§4.2; T404): the type stays
 * `link`. `to_two_way` creates the reverse field in the linked table,
 * `to_one_way` deletes the other side (restorable), `to_single` keeps the
 * first link of each cell (`allow_multiple` true → false).
 */
export const LINK_CONVERSION_CHANGES = ['to_two_way', 'to_one_way', 'to_single'] as const;
export type LinkConversionChangeName = (typeof LINK_CONVERSION_CHANGES)[number];

export const linkConversionChangeSchema = z
  .strictObject({
    change: z.enum(LINK_CONVERSION_CHANGES),
    partner_table_id: idOf('tbl').meta({
      description: 'The linked table: where the other side is created, deleted or cut',
    }),
    partner_field_id: idOf('fld')
      .nullable()
      .meta({
        description:
          'The other side: the field `to_one_way` deletes, the reverse field `to_single` cuts ' +
          '(two-way links), the field a revert of `to_two_way` deletes; `null` before a ' +
          '`to_two_way` created it',
      }),
  })
  .meta({ id: 'LinkConversionChange' });
export type LinkConversionChangeDto = z.infer<typeof linkConversionChangeSchema>;

/** Most over-limit examples a `to_two_way` preview returns. */
export const LINK_OVER_LIMIT_SAMPLE_LIMIT = 20;

export const linkOverLimitSampleSchema = z
  .strictObject({
    record_id: idOf('rec').meta({ description: 'A record of the linked table' }),
    links: z.int().min(0).meta({ description: 'Links its reverse cell would hold (> 500)' }),
  })
  .meta({ id: 'LinkOverLimitSample' });

export const conversionSettingsSchema = z
  .strictObject({
    match_existing_only: z
      .boolean()
      .optional()
      .meta({
        description:
          'select ← text/number: only keep values naming an existing option instead of creating ' +
          'options (like Lark)',
      }),
    truthy_values: z
      .array(z.string().trim().min(1).max(255))
      .min(1)
      .max(100)
      .optional()
      .meta({
        description:
          'checkbox ← text/select: values read as checked (trimmed, case-insensitive); without ' +
          'it the conversion is blacklisted (CONTRACTS §4.3)',
      }),
    match_email: z
      .boolean()
      .optional()
      .meta({
        description:
          'user ← text: values are emails of organization members (`,`/`;` separated); without ' +
          'it the conversion is blacklisted',
      }),
  })
  .meta({ id: 'ConversionSettings' });
export type ConversionSettingsInput = z.infer<typeof conversionSettingsSchema>;

/** Body of `POST /fields/:id/convert-preview`: the definition the field would get. */
export const convertFieldPreviewRequestSchema = z
  .strictObject({
    type: fieldTypeNameSchema,
    options: fieldOptionsSchema.optional().meta({
      description:
        'Full options of the new definition (defaulted and validated per type, like a ' +
        'create). Select options without `id` are new. A `link` field (T404) keeps the keys ' +
        'left out; `to_two_way` needs `bidirectional_link_field_name` on `PUT`. To a ' +
        'formula/lookup (T463): its options as on create (display-form `expression`, lookup ' +
        '`from`/`select`/`where`/`aggregate`, `style`). From a formula/lookup to `number`/' +
        '`datetime` without `style`: the style/format of the result is kept.',
    }),
    conversion: conversionSettingsSchema.optional(),
  })
  .meta({ id: 'ConvertFieldPreviewRequest' });
export type ConvertFieldPreviewRequest = z.infer<typeof convertFieldPreviewRequestSchema>;

/** Body of `PUT /fields/:id` (CONTRACTS §4.4): the preview body plus the confirmations. */
export const convertFieldRequestSchema = convertFieldPreviewRequestSchema
  .extend({
    confirm: z.boolean().optional().meta({
      description:
        'Required (`true`) when the preview says `requires_confirm` (values lost or truncated)',
    }),
    accept_data_loss: z
      .boolean()
      .optional()
      .meta({
        description:
          'Required (`true`) for a conversion outside the whitelist when the column has values ' +
          '(`requires_accept_data_loss`): every value is dropped',
      }),
  })
  .meta({ id: 'ConvertFieldRequest' });
export type ConvertFieldRequest = z.infer<typeof convertFieldRequestSchema>;

export const FIELD_CONVERSION_SAMPLE_OUTCOMES = ['kept', 'truncated', 'lost', 'invalid'] as const;

export const fieldConversionSampleSchema = z
  .strictObject({
    record_id: idOf('rec'),
    from: z.unknown().meta({ description: 'Current value (`cell_format=json`)' }),
    to: z.unknown().meta({
      description: 'Value after the conversion (`null` when lost; for `invalid`, unchanged)',
    }),
    outcome: z.enum(FIELD_CONVERSION_SAMPLE_OUTCOMES),
  })
  .meta({ id: 'FieldConversionSample' });
export type FieldConversionSample = z.infer<typeof fieldConversionSampleSchema>;

export const FIELD_DEPENDENT_TYPES = ['field', 'view', 'role', 'automation'] as const;

export const fieldDependentSchema = z
  .strictObject({
    type: z.enum(FIELD_DEPENDENT_TYPES),
    id: z.string(),
    table_id: z
      .string()
      .optional()
      .meta({ description: 'Only for `type = field`: the table of the formula/lookup field' }),
    name: z
      .string()
      .optional()
      .meta({ description: 'Only for `type = field`: the name of the formula/lookup field' }),
  })
  .meta({
    id: 'FieldDependent',
    description:
      'Something that uses the field and may stop working after the change: a view (filter, ' +
      'sort, group, kanban, form), a role (field rule, record filter; base admins only), a ' +
      'formula/lookup field that would get a field-level error (`REF`, or `INVALID_CONFIG` ' +
      'for a conversion; directly or through another computed field; only fields the caller ' +
      'can read are listed, T460) or an automation (once those exist)',
  });
export type FieldDependent = z.infer<typeof fieldDependentSchema>;

/**
 * `GET /fields/:fieldId/delete-preview` and `GET /tables/:tableId/delete-preview`
 * (T460, CONTRACTS §13): what would stop working if the field/table went
 * to the trash. Informative only: the delete is never refused because of it.
 */
export const deletePreviewSchema = z
  .strictObject({
    dependents: z.array(fieldDependentSchema).meta({
      description:
        'Field: views and roles using it (like `convert-preview`) and the formula/lookup ' +
        'fields that would be `REF`; table: the formula/lookup fields of other tables that ' +
        'would be `REF`. Only what the caller can see',
    }),
  })
  .meta({ id: 'DeletePreview' });
export type DeletePreview = z.infer<typeof deletePreviewSchema>;

export const FIELD_CONVERSION_REFUSALS = ['CONVERSION_NOT_ALLOWED', 'TOO_MANY_OPTIONS'] as const;

export const convertFieldPreviewSchema = z
  .strictObject({
    allowed: z.boolean().meta({
      description: '`false`: `PUT` would be refused whatever the confirmations (`reason`)',
    }),
    reason: z.enum(FIELD_CONVERSION_REFUSALS).nullable(),
    kind: z.enum(FIELD_CONVERSION_KINDS).meta({
      description:
        '`none`: options/style only, no data changes and no job; `keep` (§4.1), `truncate` ' +
        '(§4.2), `blacklist` (§4.3), `forbidden`. From a formula/lookup: the kind of its ' +
        'result type to the target (never `none`); to a formula/lookup: `keep`',
    }),
    requires_confirm: z.boolean(),
    requires_accept_data_loss: z.boolean(),
    unique_values_reset: z.boolean().meta({
      description:
        '`true`: the field requires unique values and the conversion turns this off (duplicates ' +
        'may appear); it can be turned on again afterwards',
    }),
    affected: z.int().min(0).meta({ description: 'Non-empty cells (records in the trash too)' }),
    lost: z
      .int()
      .min(0)
      .meta({
        description:
          'Non-empty cells that become empty; to a formula/lookup: every non-empty cell (its ' +
          'value is replaced by the computed one, kept 7 days for a revert)',
      }),
    truncated: z.int().min(0).meta({ description: 'Cells cut to one item (§4.2)' }),
    invalid: z
      .int()
      .min(0)
      .optional()
      .meta({
        description:
          'Only for `text` with style `email`/`phone`: cells not matching the style (kept as ' +
          'they are)',
      }),
    new_options: z.array(z.string()).meta({ description: 'select ← text/number: options created' }),
    samples: z
      .array(fieldConversionSampleSchema)
      .max(FIELD_CONVERSION_SAMPLE_LIMIT)
      .meta({
        description:
          'Up to 20 examples, lost/truncated/invalid first, from records the caller can read; ' +
          'to a formula/lookup: non-empty cells, `to` = the value computed for the record',
      }),
    dependents: z.array(fieldDependentSchema).meta({
      description:
        'What may stop working; for a link `to_one_way`, the dependents of the other side ' +
        '(deleted): `requires_confirm` when not empty',
    }),
    link_change: linkConversionChangeSchema.optional().meta({
      description: 'Only for a link conversion (T404)',
    }),
    over_limit: z
      .int()
      .min(0)
      .optional()
      .meta({
        description:
          'Only for a link `to_two_way`: records of the linked table whose reverse cell would ' +
          'hold more than 500 links (kept; links can only be removed from them, ADR-28 §4)',
      }),
    over_limit_samples: z
      .array(linkOverLimitSampleSchema)
      .max(LINK_OVER_LIMIT_SAMPLE_LIMIT)
      .optional()
      .meta({ description: 'Up to 20 of those, among the records the caller can read' }),
  })
  .meta({ id: 'ConvertFieldPreview' });
export type ConvertFieldPreview = z.infer<typeof convertFieldPreviewSchema>;

/** `202` answer of `PUT /fields/:id`. */
export const convertFieldResponseSchema = z
  .strictObject({
    job_id: idOf('job')
      .nullable()
      .meta({
        description:
          'The `field.convert` backfill job (follow it with `GET /jobs/:id` or `job.progress`); ' +
          '`null` when no value changes (kind `none`: applied at once like a `PATCH`)',
      }),
    field: fieldSchema,
  })
  .meta({ id: 'ConvertFieldResponse' });
export type ConvertFieldResponse = z.infer<typeof convertFieldResponseSchema>;

/** How a revert treats cells written after the conversion (BACKLOG S4 design decision #7). */
export const REVERT_CONVERSION_MODES = [
  'keep_later_edits',
  'overwrite_later_edits',
  'new_field',
] as const;
export type RevertConversionMode = (typeof REVERT_CONVERSION_MODES)[number];

export const revertConversionRequestSchema = z
  .strictObject({
    mode: z
      .enum(REVERT_CONVERSION_MODES)
      .default('keep_later_edits')
      .meta({
        description:
          '`keep_later_edits` (default): cells not written since the conversion get their old ' +
          'value back, edited cells keep their value converted back to the old type (those the ' +
          'old type cannot hold get their old value: `edited_unconvertible`, needs `confirm`). ' +
          '`overwrite_later_edits`: every cell gets its old value (needs `confirm` when ' +
          '`edited` > 0). `new_field`: the old version becomes a new field next to the converted ' +
          'one, nothing is overwritten',
      }),
    confirm: z.boolean().optional().meta({
      description: 'Required (`true`) when the chosen mode loses edited values (see the preview)',
    }),
    name: z.string().trim().min(1).max(255).optional().meta({
      description: '`new_field`: name of the new field (default: `<field name> (old version)`)',
    }),
  })
  .meta({ id: 'RevertConversionRequest' });
export type RevertConversionRequest = z.input<typeof revertConversionRequestSchema>;

export const revertConversionPreviewSchema = z
  .strictObject({
    job_id: idOf('job').meta({ description: 'The conversion that would be undone' }),
    from_type: fieldTypeNameSchema.meta({
      description:
        'Type the field goes back to; `formula`/`lookup`: its definition comes back and is ' +
        'computed again (cells written since are replaced: `edited` = `edited_unconvertible`; ' +
        '`CIRCLE` when it closes a reference cycle, T463)',
    }),
    revertible_until: isoDateTimeSchema,
    unchanged: z.int().min(0).meta({
      description: 'Cells not written since the conversion: they get their old value back',
    }),
    edited: z
      .int()
      .min(0)
      .meta({
        description:
          'Cells written since the conversion (edited, or in records created later): kept by ' +
          '`keep_later_edits`, overwritten by `overwrite_later_edits`',
      }),
    edited_unconvertible: z.int().min(0).meta({
      description:
        'Edited cells the old type cannot hold: `keep_later_edits` gives them their old value',
    }),
    new_field_available: z.boolean().meta({
      description: '`new_field` is possible (the field had a column of its own before)',
    }),
    link_change: linkConversionChangeSchema.optional().meta({
      description:
        'Only for a link conversion (T404): `to_two_way` → the reverse field goes to the ' +
        'trash; `to_one_way` → the other side comes back (same id); `to_single` → the removed ' +
        'links come back (`unchanged` cut cells; `edited` ones only with ' +
        '`overwrite_later_edits`)',
    }),
    samples: z
      .array(fieldConversionSampleSchema)
      .max(FIELD_CONVERSION_SAMPLE_LIMIT)
      .meta({
        description:
          'Edited cells: `from` = current value, `to` = value after `keep_later_edits` ' +
          '(`outcome` `kept`, or `lost` when the old value returns)',
      }),
  })
  .meta({ id: 'RevertConversionPreview' });
export type RevertConversionPreview = z.infer<typeof revertConversionPreviewSchema>;
