import { z } from 'zod';

import { aiClassifyActionSchema, aiGenerateTextActionSchema } from './automation-actions/ai.js';
import { delayActionSchema } from './automation-actions/delay.js';
import { httpRequestActionSchema } from './automation-actions/http-request.js';
import { ifActionSchemaOf } from './automation-actions/if.js';
import {
  createRecordActionSchema,
  deleteRecordActionSchema,
  findRecordsActionSchema,
  MAX_FIND_FIELDS,
  updateRecordActionSchema,
} from './automation-actions/record.js';
import { runN8nWorkflowActionSchema } from './automation-actions/run-n8n-workflow.js';
import { sendEmailActionSchema } from './automation-actions/send-email.js';
import { sendNotificationActionSchema } from './automation-actions/send-notification.js';
import { sendTelegramActionSchema } from './automation-actions/send-telegram.js';
import { updateRecordsActionSchema } from './automation-actions/update-records.js';
import { buttonClickedTriggerSchema } from './automation-triggers/button.js';
import { dateReachedTriggerSchema } from './automation-triggers/date-reached.js';
import { formSubmittedTriggerSchema } from './automation-triggers/form.js';
import { recordMatchesTriggerSchema } from './automation-triggers/matches.js';
import {
  recordCreatedTriggerSchema,
  recordDeletedTriggerSchema,
  recordUpdatedTriggerSchema,
} from './automation-triggers/record.js';
import { scheduleTriggerSchema } from './automation-triggers/schedule.js';
import { webhookReceivedTriggerSchema } from './automation-triggers/webhook-received.js';
import {
  automationActionIdSchema,
  automationFilterSchema,
  MAX_TEMPLATE_LENGTH,
} from './automation-values.js';
import { isoDateTimeSchema } from './common.js';
import { computedResultTypeSchema } from './computed-fields.js';
import { problemErrorItemSchema } from './errors.js';
import { idOf } from './ids.js';
import { offsetQuerySchema } from './pagination.js';

export * from './automation-values.js';
export * from './automation-triggers/record.js';
export * from './automation-triggers/form.js';
export * from './automation-triggers/schedule.js';
export * from './automation-triggers/date-reached.js';
export * from './automation-triggers/matches.js';
export * from './automation-triggers/button.js';
export * from './automation-triggers/webhook-received.js';
export * from './automation-actions/record.js';
export * from './automation-actions/update-records.js';
export * from './automation-actions/delay.js';
export * from './automation-actions/if.js';
export * from './automation-actions/send-email.js';
export * from './automation-actions/send-notification.js';
export * from './automation-actions/send-telegram.js';
export * from './automation-actions/http-request.js';
export * from './automation-actions/run-n8n-workflow.js';
export * from './automation-actions/ai.js';

/**
 * Automations (SPEC §11, CONTRACTS §21; BACKLOG T502): the definition
 * (trigger, condition, actions), the management API and `run_as`
 * (ADR-25). Trigger and action members live in `automation-triggers/*.ts`
 * and `automation-actions/*.ts`; the tasks that run them (T503–T517)
 * complete their own file and add new members to the unions below.
 */

// --- Trigger ------------------------------------------------------------------------

export const automationTriggerSchema = z
  .discriminatedUnion('type', [
    recordCreatedTriggerSchema,
    recordUpdatedTriggerSchema,
    recordDeletedTriggerSchema,
    recordMatchesTriggerSchema,
    formSubmittedTriggerSchema,
    scheduleTriggerSchema,
    dateReachedTriggerSchema,
    buttonClickedTriggerSchema,
    webhookReceivedTriggerSchema,
  ])
  .meta({ id: 'AutomationTrigger', description: 'What starts a run (SPEC §11.2)' });
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationTriggerType = AutomationTrigger['type'];

/** Trigger types (SPEC §11.2), in documentation order; `webhook.received` from S5c (T604). */
export const AUTOMATION_TRIGGER_TYPES = [
  'record.created',
  'record.updated',
  'record.deleted',
  'record.matches',
  'form.submitted',
  'schedule',
  'record.date_reached',
  'button.clicked',
  'webhook.received',
] as const satisfies readonly AutomationTriggerType[];

// --- Actions ------------------------------------------------------------------------

/** Most actions of a definition, `if` branches included (SPEC §11.3, §11.5). */
export const MAX_AUTOMATION_ACTIONS = 20;

/** Actions allowed inside an `if` branch: every type except `if` (one level only). */
export const automationBranchActionSchema = z
  .discriminatedUnion('type', [
    createRecordActionSchema,
    updateRecordActionSchema,
    updateRecordsActionSchema,
    findRecordsActionSchema,
    deleteRecordActionSchema,
    delayActionSchema,
    sendEmailActionSchema,
    sendNotificationActionSchema,
    sendTelegramActionSchema,
    httpRequestActionSchema,
    runN8nWorkflowActionSchema,
    aiGenerateTextActionSchema,
    aiClassifyActionSchema,
  ])
  .meta({ id: 'AutomationBranchAction', description: 'An action other than `if`' });
export type AutomationBranchAction = z.infer<typeof automationBranchActionSchema>;

export const ifActionSchema = ifActionSchemaOf(automationBranchActionSchema);
export type IfAction = z.infer<typeof ifActionSchema>;

export const automationActionSchema = z
  .discriminatedUnion('type', [
    createRecordActionSchema,
    updateRecordActionSchema,
    updateRecordsActionSchema,
    findRecordsActionSchema,
    deleteRecordActionSchema,
    delayActionSchema,
    sendEmailActionSchema,
    sendNotificationActionSchema,
    sendTelegramActionSchema,
    httpRequestActionSchema,
    runN8nWorkflowActionSchema,
    aiGenerateTextActionSchema,
    aiClassifyActionSchema,
    ifActionSchema,
  ])
  .meta({ id: 'AutomationAction', description: 'One step of the run (SPEC §11.5)' });
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationActionType = AutomationAction['type'];

/** Action types (SPEC §11.5; `send_email` T514, `send_notification` T515, `send_telegram` T516, `http_request` T606, `run_n8n_workflow` T607, `ai_generate_text`/`ai_classify` T911). */
export const AUTOMATION_ACTION_TYPES = [
  'create_record',
  'update_record',
  'update_records',
  'find_records',
  'delete_record',
  'delay',
  'send_email',
  'send_notification',
  'send_telegram',
  'http_request',
  'run_n8n_workflow',
  'ai_generate_text',
  'ai_classify',
  'if',
] as const satisfies readonly AutomationActionType[];

// --- Definition ---------------------------------------------------------------------

/**
 * The definition (SPEC §11.8). `condition` is a Filter DSL tree on the
 * record after the change, with the automation-only operators `changed`,
 * `changed_to`, `changed_from` (SPEC §11.3); `null` = always.
 */
export const automationDefinitionSchema = z
  .strictObject({
    trigger: automationTriggerSchema,
    condition: automationFilterSchema.nullable().default(null),
    actions: z
      .array(automationActionSchema)
      .default([])
      .meta({
        description: `At most ${String(MAX_AUTOMATION_ACTIONS)} actions, \`if\` branches included`,
      }),
  })
  .meta({ id: 'AutomationDefinition', description: 'Trigger, condition and actions (SPEC §11)' });
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationDefinitionInput = z.input<typeof automationDefinitionSchema>;

// --- States -------------------------------------------------------------------------

/** Why the system turned an automation off (`null` = on, or turned off by a person). */
export const AUTOMATION_DISABLED_REASONS = ['run_as_lost_access', 'circuit_breaker'] as const;
export const automationDisabledReasonSchema = z.enum(AUTOMATION_DISABLED_REASONS);
export type AutomationDisabledReason = z.infer<typeof automationDisabledReasonSchema>;

/** `after.reason` of `automation.run_as_changed` (ADR-25 §7). */
export const AUTOMATION_RUN_AS_REASONS = ['created', 'edited', 'enabled', 'taken_over'] as const;
export const automationRunAsReasonSchema = z.enum(AUTOMATION_RUN_AS_REASONS);
export type AutomationRunAsReason = z.infer<typeof automationRunAsReasonSchema>;

// --- API ----------------------------------------------------------------------------

export const MAX_AUTOMATION_NAME_LENGTH = 255;
export const MAX_AUTOMATION_DESCRIPTION_LENGTH = 2_000;

const automationNameSchema = z.string().trim().min(1).max(MAX_AUTOMATION_NAME_LENGTH);
const automationDescriptionSchema = z.string().max(MAX_AUTOMATION_DESCRIPTION_LENGTH);
const versionSchema = z.int().min(1);

/** A person shown next to an automation. */
export const automationUserSchema = z
  .strictObject({ id: idOf('usr'), name: z.string() })
  .meta({ id: 'AutomationUser' });

export const automationSchema = z
  .strictObject({
    id: idOf('aut'),
    base_id: idOf('bse'),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    disabled_reason: automationDisabledReasonSchema.nullable().meta({
      description:
        '`run_as_lost_access` (ADR-25 §5) or `circuit_breaker` (ADR-26 §5) when the system ' +
        'turned it off; `null` otherwise',
    }),
    definition: automationDefinitionSchema,
    version: versionSchema.meta({
      description:
        'Bumped by every change; send it back (`If-Match` or `version`) to avoid lost updates',
    }),
    run_as: automationUserSchema.meta({
      description:
        'Whose permissions the actions use (ADR-25): the person who last saved the ' +
        'definition, turned it on or took it over. Compare with the current user to warn ' +
        'before such a change',
    }),
    run_as_since: isoDateTimeSchema,
    created_by: automationUserSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Automation' });
export type AutomationDto = z.infer<typeof automationSchema>;

// `automationListSchema` (items with their run counts, T518) is in `automation-runs.ts`.

export const automationListQuerySchema = offsetQuerySchema.extend({
  table_id: idOf('tbl')
    .optional()
    .meta({ description: 'Only automations triggered on this table' }),
});
export type AutomationListQuery = z.infer<typeof automationListQuerySchema>;

export const createAutomationRequestSchema = z
  .strictObject({
    name: automationNameSchema,
    description: automationDescriptionSchema.default(''),
    definition: automationDefinitionSchema,
    enabled: z.boolean().default(false).meta({ description: 'Turn it on at once (default off)' }),
  })
  .meta({ id: 'CreateAutomationRequest' });
export type CreateAutomationRequest = z.infer<typeof createAutomationRequestSchema>;

export const updateAutomationRequestSchema = z
  .strictObject({
    name: automationNameSchema.optional(),
    description: automationDescriptionSchema.optional(),
    definition: automationDefinitionSchema.optional().meta({
      description: 'The whole new definition. A change makes the caller `run_as` (ADR-25 §2)',
    }),
    version: versionSchema.optional().meta({
      description: 'Expected current version (same as `If-Match`); a mismatch is `409`',
    }),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.definition !== undefined,
    { message: 'Send name, description or definition', path: [] },
  )
  .meta({ id: 'UpdateAutomationRequest' });
export type UpdateAutomationRequest = z.infer<typeof updateAutomationRequestSchema>;

export const takeOverAutomationRequestSchema = z
  .strictObject({
    enable: z.boolean().meta({ description: 'Also turn the automation on' }),
  })
  .meta({ id: 'TakeOverAutomationRequest' });
export type TakeOverAutomationRequest = z.infer<typeof takeOverAutomationRequestSchema>;

/**
 * `POST /automations/:id/duplicate` (BACKLOG T551, CONTRACTS §21): a copy in
 * the same base, turned off, the caller `run_as`; body images are copied.
 */
export const duplicateAutomationRequestSchema = z
  .strictObject({
    name: automationNameSchema.optional().meta({
      description:
        'Default: the source name followed by ` (copy)` / ` (bản sao)` in the language of the ' +
        'caller, the source name cut so the whole name stays within 255 characters',
    }),
  })
  .meta({ id: 'DuplicateAutomationRequest' });
export type DuplicateAutomationRequest = z.infer<typeof duplicateAutomationRequestSchema>;

/** Optional `If-Match` of the mutating routes: the expected `version`, bare or quoted. */
export const automationIfMatchHeaderSchema = z.object({
  'if-match': z
    .string()
    .regex(/^(?:W\/)?"?\d{1,10}"?$/u, { message: 'Expected the automation version' })
    .optional()
    .meta({ description: 'Expected `version`, e.g. `"3"`; a mismatch is `409 VERSION_CONFLICT`' }),
});

// --- Detail codes of 422 AUTOMATION_INVALID (CONTRACTS §6, §21) ---------------------------

/** The caller lacks the permission the step needs on a table/field it can read (ADR-25 §3). */
export const AUTOMATION_PERMISSION_DENIED = 'PERMISSION_DENIED';
/** More than `MAX_AUTOMATION_ACTIONS` actions (`params.limit`, `params.count`). */
export const TOO_MANY_ACTIONS = 'TOO_MANY_ACTIONS';
/** Two actions share an id (`params.id`). */
export const DUPLICATE_ACTION_ID = 'DUPLICATE_ACTION_ID';
/** A `step`/`digest` value names no earlier action (`params.step`). */
export const UNKNOWN_STEP = 'UNKNOWN_STEP';
/** The action needs the trigger record but the trigger has none (`schedule`). */
export const NO_TRIGGER_RECORD = 'NO_TRIGGER_RECORD';
/** `update_record` of the trigger record names another table than the trigger's. */
export const NOT_TRIGGER_TABLE = 'NOT_TRIGGER_TABLE';
/** A value source the trigger or the step cannot provide (`params.source`, ADR-32). */
export const UNSUPPORTED_VALUE_SOURCE = 'UNSUPPORTED_VALUE_SOURCE';
/** Turning on an automation without any action. */
export const NO_ACTIONS = 'NO_ACTIONS';
/** A template calls a refused function (`params.function`, `params.position`; T504). */
export const UNSUPPORTED_FUNCTION = 'UNSUPPORTED_FUNCTION';
/** A template reads a whole table (`[Table]`): use `find_records` + `digest` (T504). */
export const CROSS_TABLE_NOT_SUPPORTED = 'CROSS_TABLE_NOT_SUPPORTED';
/** Template syntax (`params.position`): `{{` without `}}`, an empty `{{ }}`, too many. */
export const TEMPLATE_SYNTAX_DETAIL_CODES = [
  'UNTERMINATED_PLACEHOLDER',
  'EMPTY_PLACEHOLDER',
  'TOO_MANY_PLACEHOLDERS',
] as const;

// --- Template check for the builder (CONTRACTS §21; BACKLOG T504) ----------------------

export const automationTemplateFormSchema = z.enum(['display', 'stored']);
export type AutomationTemplateForm = z.infer<typeof automationTemplateFormSchema>;

export const validateAutomationTemplateRequestSchema = z
  .strictObject({
    table_id: idOf('tbl')
      .nullable()
      .meta({
        description:
          'Table whose record the template runs on: the trigger table, or the table of a ' +
          '`find_records` step for a `digest.row_template`; `null` for a trigger without ' +
          'record (`schedule`: `NOW()`, `TODAY()`, constants, trigger data and steps)',
      }),
    template: z.string().max(MAX_TEMPLATE_LENGTH),
    form: automationTemplateFormSchema.default('display').meta({
      description: '`display`: names as typed (`[Title]`); `stored`: ids as saved (`[fld_…]`)',
    }),
    row_fields: z
      .array(idOf('fld'))
      .max(MAX_FIND_FIELDS)
      .nullable()
      .default(null)
      .meta({
        description:
          '`digest.row_template`: the `fields` of the `find_records` step (only those, or the ' +
          'primary field when empty, can be read); `null` = every field the caller reads',
      }),
    trigger_type: z
      .enum(AUTOMATION_TRIGGER_TYPES)
      .nullable()
      .default(null)
      .meta({
        description:
          'Trigger of the automation: which `[@fired_at]`, `[@due_at]`, `[@clicked_by]`, ' +
          '`[@clicked_at]`, `[@actor]` the template may use (T505) — `webhook.received`: ' +
          '`[@body]`, `[@body.<path>]`, `[@headers.<name>]`, `[@query.<path>]` (T604); `null` = ' +
          'none. Ignored for a `digest.row_template` (`row_fields` set)',
      }),
    steps: z
      .array(z.strictObject({ id: automationActionIdSchema, table_id: idOf('tbl') }))
      .max(MAX_AUTOMATION_ACTIONS)
      .default([])
      .meta({
        description:
          'Earlier `create_record`/`update_record`/`find_records` steps and the table of their ' +
          'record: what `[act_…]` may name (T505). A table the caller cannot read is left out ' +
          '(its references are `UNKNOWN_FIELD`). Ignored for a `digest.row_template`',
      }),
    digest: z
      .boolean()
      .default(false)
      .meta({
        description:
          'The body of a `send_email` step that has a `digest` (T514): `{{ [@digest] }}` may ' +
          'place its lines. Ignored for a `digest.row_template`',
      }),
    text_steps: z
      .array(automationActionIdSchema)
      .max(MAX_AUTOMATION_ACTIONS)
      .default([])
      .meta({
        description:
          'Earlier `ai_generate_text` steps (T911): `{{ [act_…] }}` is their text. Ignored for ' +
          'a `digest.row_template`',
      }),
  })
  .meta({ id: 'ValidateAutomationTemplateRequest' });
export type ValidateAutomationTemplateRequest = z.infer<
  typeof validateAutomationTemplateRequestSchema
>;

export const automationTemplatePlaceholderSchema = z
  .strictObject({
    index: z.int().min(0),
    start: z.int().min(0).meta({ description: 'Offset of `{{` in `template` (UTF-16 units)' }),
    length: z.int().min(0),
    stored: z.string().meta({ description: 'The expression with ids (`[fld_…]`)' }),
    display: z.string().meta({ description: 'The expression with current names (for chips)' }),
    result_type: computedResultTypeSchema,
    fields: z
      .array(
        z.strictObject({
          field_id: idOf('fld'),
          link_path: z.array(z.string()).meta({
            description:
              'Link fields followed to it; the first may be a step reference `act_…` (T505)',
          }),
        }),
      )
      .meta({
        description:
          'Fields the expression reads (record fields only: `[@…]` references are not listed)',
      }),
  })
  .meta({ id: 'AutomationTemplatePlaceholder' });

export const validateAutomationTemplateResponseSchema = z
  .strictObject({
    valid: z.boolean(),
    stored: z.string().nullable().meta({ description: 'What to save; `null` when not valid' }),
    display: z.string().nullable().meta({ description: 'Names form; `null` when not valid' }),
    placeholders: z.array(automationTemplatePlaceholderSchema).meta({
      description: 'Placeholders without errors, in order',
    }),
    errors: z.array(problemErrorItemSchema).meta({
      description:
        '`path` = `template`, `code` as in `AUTOMATION_INVALID`, `params.position` in `template`',
    }),
  })
  .meta({ id: 'ValidateAutomationTemplateResponse' });
export type ValidateAutomationTemplateResponse = z.infer<
  typeof validateAutomationTemplateResponseSchema
>;
