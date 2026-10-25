import { z } from 'zod';

import { automationActionIdSchema } from '../automation-values.js';
import { idOf } from '../ids.js';

import { httpRequestValueSchema } from './http-request.js';

/**
 * `run_n8n_workflow` (SPEC §11.5, §13.3; CONTRACTS §21; ADR-35 §4; BACKLOG
 * T607): a preset of `http_request` — `POST` to an n8n Webhook node URL
 * with the standard JSON payload of SPEC §13.3, signed with a
 * `webhook_signing` secret (Standard Webhooks, CONTRACTS §10) and sent
 * through the same two-phase outbox with the same headers. The payload is
 * built when the step runs, with the permissions of `run_as` **then**
 * (ADR-25): fields it cannot read are never in it, linked records it cannot
 * read have `title: null`.
 */

/** Most fields a `run_n8n_workflow` step may list (`fields`). */
export const RUN_N8N_WORKFLOW_MAX_FIELDS = 100;

export const runN8nWorkflowConfigSchema = z
  .strictObject({
    url: httpRequestValueSchema.meta({
      description:
        'URL of the n8n Webhook node (`http`/`https`); a literal is checked when saved ' +
        '(`INVALID_URL`), the address when called (CONTRACTS §25.4). In a template each ' +
        'placeholder value is percent-encoded',
    }),
    signing_secret_id: idOf('sec').meta({
      description:
        'Required `webhook_signing` secret of the organization whose scope includes the base: ' +
        'the request carries `webhook-signature` (Standard Webhooks; two signatures for 24 ' +
        'hours after the secret is replaced)',
    }),
    fields: z
      .array(idOf('fld'))
      .min(1)
      .max(RUN_N8N_WORKFLOW_MAX_FIELDS)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'A field is listed twice' })
      .nullable()
      .default(null)
      .meta({
        description:
          'Fields of the trigger table to send (the saver must read them; at run time those ' +
          '`run_as` no longer reads are left out). `null`: every field `run_as` reads when ' +
          'the step runs. Only with a trigger that has a record (`NO_TRIGGER_RECORD`)',
      }),
    include_changes: z
      .boolean()
      .default(true)
      .meta({
        description:
          '`record.updated`: send `changes` (old and new value of the changed fields that are ' +
          'sent); `false` or another trigger → `changes: null`',
      }),
  })
  .meta({ id: 'RunN8nWorkflowConfig' });
export type RunN8nWorkflowConfig = z.infer<typeof runN8nWorkflowConfigSchema>;
export type RunN8nWorkflowConfigInput = z.input<typeof runN8nWorkflowConfigSchema>;

export const runN8nWorkflowActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('run_n8n_workflow'),
    config: runN8nWorkflowConfigSchema,
  })
  .meta({
    id: 'RunN8nWorkflowAction',
    description:
      '`POST` of the payload `N8nWorkflowPayload` (SPEC §13.3) through the outbox. Output as ' +
      '`http_request` (`HttpStepOutput`); the response body is never shown in the run detail',
  });

// --- Payload (SPEC §13.3) --------------------------------------------------------------

const namedRefSchema = z.strictObject({ id: z.string(), name: z.string() });

/**
 * One change of `changes`: the value before and after the write in the
 * form of `[@previous]` (SPEC §11.4) — options by name, users and records
 * by id (`["usr_…"]`, `["rec_…"]`), `parent` as a record id, other types
 * as `cell_format=json`.
 */
export const n8nWorkflowChangeSchema = z.strictObject({
  from: z.unknown(),
  to: z.unknown(),
});

/**
 * The JSON body of a `run_n8n_workflow` request (SPEC §13.3, CONTRACTS
 * §21). Never a secret, a token, or a field `run_as` cannot read.
 */
export const n8nWorkflowPayloadSchema = z
  .strictObject({
    event: z.strictObject({
      /** `null` without a trigger event (`schedule`). */
      id: z.string().nullable(),
      /** The trigger type (`record.updated`, `schedule`, `webhook.received`…). */
      type: z.string(),
      /**
       * The trigger record's id when `run_as` reads it — also for
       * `record.deleted`, whose `record` is `null` (the record is in the
       * trash); `null` without a trigger record or when `run_as` cannot read
       * it (T616).
       */
      entity_id: z.string().nullable(),
      created_at: z.string(),
    }),
    automation: z.strictObject({ id: z.string(), name: z.string(), run_id: z.string() }),
    base: namedRefSchema,
    /** The trigger table; `null` without one (`schedule`, `webhook.received`). */
    table: namedRefSchema.nullable(),
    /**
     * The trigger record as `run_as` reads it now: `fields` by field name
     * as `cell_format=text`, `fields_by_id` by field id as
     * `cell_format=json` (CONTRACTS §2). `null` without a trigger record,
     * or when `run_as` cannot read it now (deleted, outside its read rule).
     */
    record: z
      .strictObject({
        id: z.string(),
        fields: z.record(z.string(), z.unknown()),
        fields_by_id: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    /** By field name; only fields that are sent. `null`: see `include_changes`. */
    changes: z.record(z.string(), n8nWorkflowChangeSchema).nullable(),
  })
  .meta({
    id: 'N8nWorkflowPayload',
    description:
      'JSON body of a `run_n8n_workflow` request (SPEC §13.3), built as `run_as` when the ' +
      'step runs: `record.fields` by field name (`cell_format=text`), `record.fields_by_id` by ' +
      'field id (`cell_format=json`), only fields `run_as` reads (linked records it cannot ' +
      'read have `title: null`); `record: null` without a trigger record or when `run_as` ' +
      'cannot read it; `table: null` without a trigger table; `changes` (`record.updated` ' +
      'with `include_changes`) by field name, in the `[@previous]` form. Never a secret or ' +
      'a token',
  });
export type N8nWorkflowPayload = z.infer<typeof n8nWorkflowPayloadSchema>;
