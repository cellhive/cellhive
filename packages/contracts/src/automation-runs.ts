import { z } from 'zod';

import { HTTP_REQUEST_STEP_ERROR_CODES } from './automation-actions/http-request.js';
import {
  emailRecipientRejectionSchema,
  SEND_EMAIL_STEP_ERROR_CODES,
} from './automation-actions/send-email.js';
import { SEND_TELEGRAM_STEP_ERROR_CODES } from './automation-actions/send-telegram.js';
import {
  WEBHOOK_TRIGGER_RUN_ERROR_CODES,
  WEBHOOK_TRIGGER_STEP_ERROR_CODES,
} from './automation-triggers/webhook-received.js';
import {
  automationDefinitionSchema,
  automationSchema,
  automationUserSchema,
} from './automations.js';
import { isoDateTimeSchema } from './common.js';
import { SMTP_FAILURE_REASONS, smtpReplySchema } from './email.js';
import { HTTP_DELIVERY_STEP_ERROR_CODES, httpDeliverySummarySchema } from './http-deliveries.js';
import { idOf } from './ids.js';
import { cursorListSchema, cursorQuerySchema, offsetListSchema } from './pagination.js';

/**
 * Automation runs and steps (SPEC §11.1, §11.7; CONTRACTS §21). BACKLOG
 * T502 fixes the states stored in `meta.automation_runs` /
 * `meta.automation_run_steps`; T505 runs them (error codes, retry schedule,
 * timeout, event data below); T518 adds the run log API, its DTOs and the
 * run counts of the automation list (which is why `automationListSchema`
 * lives here: `automations.ts` never imports this file).
 */

/** `meta.automation_runs.status` (SPEC §11.1; `waiting` = inside a `delay`, ADR-18). */
export const AUTOMATION_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const automationRunStatusSchema = z.enum(AUTOMATION_RUN_STATUSES);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

/** `meta.automation_run_steps.status`: created before the side effect (SPEC §11.7). */
export const AUTOMATION_STEP_STATUSES = [
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const automationStepStatusSchema = z.enum(AUTOMATION_STEP_STATUSES);
export type AutomationStepStatus = z.infer<typeof automationStepStatusSchema>;

// --- Run engine (BACKLOG T505; CONTRACTS §21 "Chạy") ----------------------------------

/** Retries of a step after a temporary error, and their base delays (SPEC §11.7). */
export const AUTOMATION_STEP_RETRY_DELAYS_MS = [
  10_000, 30_000, 120_000, 600_000, 1_800_000,
] as const;
/** Largest share of the base delay added as random jitter. */
export const AUTOMATION_STEP_RETRY_JITTER = 0.2;
/** Running time after which a run fails with `run_timeout` (waits not counted, SPEC §11.7). */
export const AUTOMATION_RUN_TIMEOUT_MS = 15 * 60_000;

/**
 * `error.code` of a failed step (and of its run):
 * - `permission_denied`: `run_as` may not do it now — a record outside its
 *   rules (P29, the automation stays on; `params.scope = record`), or the
 *   table/field/base (`params.scope = table | base`: `run_as` lost access,
 *   T507 checks the automation again);
 * - `invalid_value`: the record service refused the values
 *   (`params.error` = its error code, e.g. `VALIDATION_FAILED`, `UNIQUE_VIOLATION`),
 *   or a value of the action cannot be used (`params.field`, e.g. `until`
 *   of `delay`, `record_id`);
 * - `too_many_records`: `update_records` matched more than its `limit`
 *   (`params.limit`); nothing was written (T506);
 * - `temporary_error`: still failing after the retries (`params.cause`:
 *   `database_busy`, `timeout`, `network`, `rate_limited`, `server_error`);
 * - `unsupported_function`: a template calls `REGEX*` (T504);
 * - `unsupported_action`: no engine for this action type yet
 *   (`send_notification`/`send_telegram` before T515–T516);
 * - `internal_error`: anything else (logged by id, never with values);
 * - `send_email` (T514, CONTRACTS §23): `smtp_not_configured`,
 *   `smtp_temporary` (retried like `temporary_error`; `params.reason`,
 *   `params.smtp`), `smtp_rejected`, `email_quota_exceeded` (the step waits
 *   for the next hour, up to 24 hours), `too_many_recipients`,
 *   `email_body_too_large`, `invalid_recipients`, `invalid_sender`,
 *   `email_identity_unavailable`, `email_identity_auth_failed`; attachments
 *   (T532): `attachment_access_denied`, `attachment_not_ready`,
 *   `attachment_type_blocked`, `too_many_attachments`, `attachments_too_large`;
 * - `send_telegram` (T516): `secret_unavailable`, `invalid_chat_id`,
 *   `telegram_rejected`, `telegram_rate_limited` and `telegram_unavailable`
 *   (both retried, a 429 after its `retry_after`);
 * - HTTP steps through the outbox (T605, CONTRACTS §25.5): `ssrf_blocked`,
 *   `http_timeout`, `http_network`, `http_response_too_large`, `http_status`,
 *   `rate_limited` (and `secret_unavailable` above).
 */
export const AUTOMATION_STEP_ERROR_CODES = [
  'permission_denied',
  'invalid_value',
  'too_many_records',
  'temporary_error',
  'unsupported_function',
  'unsupported_action',
  'internal_error',
  ...SEND_EMAIL_STEP_ERROR_CODES,
  ...SEND_TELEGRAM_STEP_ERROR_CODES,
  ...HTTP_DELIVERY_STEP_ERROR_CODES,
  ...HTTP_REQUEST_STEP_ERROR_CODES,
  ...WEBHOOK_TRIGGER_STEP_ERROR_CODES,
] as const;
export type AutomationStepErrorCode = (typeof AUTOMATION_STEP_ERROR_CODES)[number];

/**
 * Why a run ended `skipped` at a `delay` (T506; `error.step` = its action
 * id): `recheck_not_matched` — the trigger record no longer matches
 * `recheck_condition`; `record_deleted` — the trigger record was deleted
 * (or is no longer readable by `run_as`) while waiting (`params.state`:
 * `trashed | missing`). The remaining steps do not run.
 */
export const AUTOMATION_RUN_SKIP_CODES = ['recheck_not_matched', 'record_deleted'] as const;
export type AutomationRunSkipCode = (typeof AUTOMATION_RUN_SKIP_CODES)[number];

/**
 * Why a run ended `cancelled`: `automation_deleted`; `automation_disabled`
 * — the automation was turned off (by a person, the circuit breaker, or
 * `run_as` losing access) while the run was `waiting` (T506);
 * `cancelled_by_user` — stopped through `POST /automation-runs/:id/cancel`
 * while `queued` or `waiting` (`params.user_id`; T518).
 */
export const AUTOMATION_RUN_CANCEL_CODES = [
  'automation_deleted',
  'automation_disabled',
  'cancelled_by_user',
] as const;
export type AutomationRunCancelCode = (typeof AUTOMATION_RUN_CANCEL_CODES)[number];

/**
 * `error.code` of a run: the code of the step that failed (`error.step` =
 * its action id), or one of the run's own — `run_timeout` (more than 15
 * minutes running), `invalid_definition` (the snapshot no longer parses),
 * `batch_fanout_exceeded` (the `skipped` stand-in run of T503),
 * `webhook_deleted` (the incoming webhook of a `webhook.received` run is
 * gone, T604), the skip codes of `delay` and the cancel codes above.
 */
export const AUTOMATION_RUN_ERROR_CODES = [
  ...AUTOMATION_STEP_ERROR_CODES,
  'run_timeout',
  'invalid_definition',
  'batch_fanout_exceeded',
  ...WEBHOOK_TRIGGER_RUN_ERROR_CODES,
  ...AUTOMATION_RUN_SKIP_CODES,
  ...AUTOMATION_RUN_CANCEL_CODES,
] as const;
export type AutomationRunErrorCode = (typeof AUTOMATION_RUN_ERROR_CODES)[number];

/** Why `temporary_error` happened (`params.cause`). */
export const AUTOMATION_TEMPORARY_CAUSES = [
  'database_busy',
  'timeout',
  'network',
  'rate_limited',
  'server_error',
] as const;
export type AutomationTemporaryCause = (typeof AUTOMATION_TEMPORARY_CAUSES)[number];

/** Most refused recipients listed in `error.params.rejected` of a `send_email` step (T541). */
export const SEND_EMAIL_ERROR_MAX_REJECTED = 50;

/**
 * `error.params` of a `send_email` step that failed with recipients refused
 * (QA S5 L1, BACKLOG T541; CONTRACTS §21): usually `smtp_rejected` — every
 * recipient refused with a `5xx` at `RCPT TO` —, also `smtp_temporary`
 * (refused with a `4xx`, retried) and `invalid_recipients` (no valid
 * address). Masked addresses and codes only, like the step output; never
 * the server's text.
 */
export const sendEmailRecipientErrorParamsSchema = z
  .looseObject({
    reason: z.enum(SMTP_FAILURE_REASONS).optional(),
    smtp: smtpReplySchema.optional(),
    rejected: z.array(emailRecipientRejectionSchema).max(SEND_EMAIL_ERROR_MAX_REJECTED).meta({
      description: 'The first 50 recipients refused, in order (addresses that do not parse first)',
    }),
    rejected_count: z.int().min(0).meta({ description: 'Every recipient refused' }),
    accepted_count: z.int().min(0).meta({
      description: 'Recipients accepted before the failure — the message reached none of them',
    }),
  })
  .meta({ id: 'SendEmailRecipientErrorParams' });
export type SendEmailRecipientErrorParams = z.infer<typeof sendEmailRecipientErrorParamsSchema>;

/** `error` of a step or run (codes and ids only, never record values). */
export const automationRunErrorSchema = z
  .object({
    code: z.enum(AUTOMATION_RUN_ERROR_CODES),
    step: z.string().optional().meta({ description: 'Action id of the step that failed' }),
    params: z
      .union([sendEmailRecipientErrorParamsSchema, z.record(z.string(), z.unknown())])
      .optional()
      .meta({
        description:
          'Codes, ids and counts of the error (CONTRACTS §21); `send_email` with refused ' +
          'recipients: `SendEmailRecipientErrorParams`',
      }),
  })
  .meta({ id: 'AutomationRunError' });
export type AutomationRunError = z.infer<typeof automationRunErrorSchema>;

/** `data` of the `automation.run.succeeded|failed` events (CONTRACTS §8, §21). */
export const automationRunEventDataSchema = z.object({
  automation_id: z.string(),
  automation_version: z.int().min(1),
  trigger_event_id: z.string().nullable(),
  status: z.enum(['succeeded', 'failed']),
  error_code: z.enum(AUTOMATION_RUN_ERROR_CODES).nullable(),
  step: z.string().nullable(),
  steps: z.int().min(0).meta({ description: 'Steps run (skipped branches not counted)' }),
  active_ms: z.int().min(0),
});
export type AutomationRunEventData = z.infer<typeof automationRunEventDataSchema>;

// --- Run log API (BACKLOG T518; CONTRACTS §21 "Lịch sử chạy") --------------------------

/** Default of `AUTOMATION_RUN_RETENTION_DAYS`: runs older than this are deleted (SPEC §20). */
export const DEFAULT_AUTOMATION_RUN_RETENTION_DAYS = 90;

/** Runs that `POST /automation-runs/:id/cancel` stops (not started, or inside a `delay`). */
export const CANCELLABLE_RUN_STATUSES = ['queued', 'waiting'] as const;
/** Runs that `POST /automation-runs/:id/rerun` repeats. */
export const RERUNNABLE_RUN_STATUSES = ['failed', 'cancelled'] as const;

const STATUS_ALTERNATIVES = AUTOMATION_RUN_STATUSES.join('|');
const STATUS_LIST_PATTERN = new RegExp(
  `^(?:${STATUS_ALTERNATIVES})(?:,(?:${STATUS_ALTERNATIVES}))*$`,
);

/** `status=failed,cancelled`: runs in any of these states. */
const runStatusFilterSchema = z
  .string()
  .regex(STATUS_LIST_PATTERN, { message: 'Expected run statuses separated by commas' })
  .transform((value) => [...new Set(value.split(','))] as AutomationRunStatus[])
  .meta({
    description: `Comma-separated run statuses (${AUTOMATION_RUN_STATUSES.join(', ')})`,
    example: 'failed,cancelled',
  });

const runListFilterShape = {
  status: runStatusFilterSchema.optional(),
  from: isoDateTimeSchema.optional().meta({ description: 'Inclusive lower bound of `created_at`' }),
  to: isoDateTimeSchema.optional().meta({ description: 'Exclusive upper bound of `created_at`' }),
  event_id: idOf('evt')
    .optional()
    .meta({
      description:
        'Only the runs started by this event (`trigger.event_id`), e.g. the `webhook.received` ' +
        'event of an incoming webhook request (T616)',
    }),
};

/** `GET /automations/:id/runs`: newest first. */
export const automationRunListQuerySchema = cursorQuerySchema.extend(runListFilterShape);
export type AutomationRunListQuery = z.infer<typeof automationRunListQuerySchema>;

/** `GET /bases/:id/automation-runs`: the same filters plus one automation. */
export const baseAutomationRunListQuerySchema = automationRunListQuerySchema.extend({
  automation_id: idOf('aut').optional().meta({ description: 'Only the runs of this automation' }),
});
export type BaseAutomationRunListQuery = z.infer<typeof baseAutomationRunListQuerySchema>;

/** What started a run: copied from the event it was created for (never record values). */
export const automationRunTriggerSchema = z
  .strictObject({
    event_type: z
      .string()
      .nullable()
      .meta({
        description:
          'Type of the trigger event (`record.updated`, `form.submitted`…); `null` for a trigger ' +
          'without event',
      }),
    event_id: idOf('evt').nullable(),
    table_id: idOf('tbl').nullable(),
    record_id: idOf('rec')
      .nullable()
      .meta({ description: 'Trigger record; open it only if the caller can read it' }),
    bulk: z.boolean().meta({ description: 'The event was part of a bulk change (ADR-26 §2)' }),
    batch: z
      .strictObject({ id: z.string(), size: z.int().min(0) })
      .nullable()
      .meta({ description: '`batch` of the trigger event (import job, request, run)' }),
  })
  .meta({ id: 'AutomationRunTrigger' });
export type AutomationRunTriggerDto = z.infer<typeof automationRunTriggerSchema>;

/** A run in the run log (no step detail). */
export const automationRunSchema = z
  .strictObject({
    id: idOf('run'),
    automation_id: idOf('aut'),
    automation_version: z.int().min(1).meta({
      description: 'Version of the definition the run uses (its snapshot)',
    }),
    status: automationRunStatusSchema,
    error: automationRunErrorSchema.nullable().meta({
      description:
        'Codes and ids only. `batch_fanout_exceeded` (a `skipped` run): `params = { batch_id, ' +
        'limit, skipped }`; a `queued` run waiting for a retry: the failed `step` and ' +
        '`params.retry_at`; `cancelled_by_user`: `params.user_id`',
    }),
    trigger: automationRunTriggerSchema,
    trigger_unit: z.string().meta({
      description: 'Trigger unit (ADR-26 §5): the batch id of a bulk event, else its root event',
    }),
    depth: z.int().min(0),
    rerun_of: idOf('run')
      .nullable()
      .meta({ description: 'Run this one repeats; `null` once retention deleted it' }),
    rerun_by: automationUserSchema
      .nullable()
      .meta({ description: 'Who asked for this re-run; `null` for a run of a trigger' }),
    active_ms: z.int().min(0).meta({ description: 'Running time (waits not counted)' }),
    started_at: isoDateTimeSchema.nullable(),
    finished_at: isoDateTimeSchema.nullable(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'AutomationRun' });
export type AutomationRunDto = z.infer<typeof automationRunSchema>;

export const automationRunListSchema = cursorListSchema(automationRunSchema).meta({
  id: 'AutomationRunList',
});
export type AutomationRunList = z.infer<typeof automationRunListSchema>;

/** `error` of a step: the run error plus the attempt it ended and, before a retry, when. */
export const automationRunStepErrorSchema = automationRunErrorSchema
  .extend({
    attempt: z.int().min(1).optional(),
    retry_at: isoDateTimeSchema.optional(),
  })
  .meta({ id: 'AutomationRunStepError' });

/** One step of a run, its output limited to what the caller may read now. */
export const automationRunStepSchema = z
  .strictObject({
    id: idOf('stp'),
    action_id: z.string().meta({ description: 'Action id in the definition (`act_…`)' }),
    action_type: z.string().nullable(),
    status: automationStepStatusSchema,
    attempt: z.int().min(1),
    started_at: isoDateTimeSchema,
    finished_at: isoDateTimeSchema.nullable(),
    reused: z.boolean().meta({
      description:
        'Succeeded in the run this one repeats: its output is reused and the action did not ' +
        'run again',
    }),
    output: z
      .unknown()
      .nullable()
      .meta({
        description:
          'What the step returned (`{ id }`, `{ result, branch }`, `{ records, count, truncated }`…). ' +
          'Record values the caller cannot read now are `null`: a `find_records` record outside ' +
          'their read rule has `redacted: true` and every value `null`; a field they cannot read ' +
          "is `null` and listed in that record's `redacted_fields`. Other outputs keep ids, " +
          'codes, numbers and masked addresses only; any other text is `null`',
      }),
    redacted: z.boolean().meta({ description: 'Some value of `output` is hidden from the caller' }),
    error: automationRunStepErrorSchema.nullable(),
    delivery: httpDeliverySummarySchema.optional().meta({
      description:
        'HTTP steps only (T605): the delivery of the outbox — host, attempts, status, last ' +
        'HTTP status and error, next attempt. Never the full URL, headers or bodies',
    }),
  })
  .meta({ id: 'AutomationRunStep' });
export type AutomationRunStepDto = z.infer<typeof automationRunStepSchema>;

/** `GET /automation-runs/:id`. */
export const automationRunDetailSchema = automationRunSchema
  .extend({
    automation: z
      .strictObject({
        id: idOf('aut'),
        name: z.string(),
        version: z.int().min(1).meta({ description: 'Current version of the automation' }),
      })
      .meta({ description: 'The automation now: compare `version` with `automation_version`' }),
    definition: automationDefinitionSchema.nullable().meta({
      description:
        'Definition the run used (snapshot of version `automation_version`); `null` when it ' +
        'no longer parses',
    }),
    steps: z.array(automationRunStepSchema).meta({ description: 'In the order they started' }),
    reruns: z
      .array(
        z.strictObject({
          id: idOf('run'),
          status: automationRunStatusSchema,
          created_at: isoDateTimeSchema,
        }),
      )
      .meta({ description: 'Re-runs of this run, newest first' }),
  })
  .meta({ id: 'AutomationRunDetail' });
export type AutomationRunDetailDto = z.infer<typeof automationRunDetailSchema>;

// --- Run counts of the automation list (BACKLOG T518, for T520) ------------------------

/** Runs per status over a window (every status, `0` when none). */
export const automationRunCountsSchema = z
  .strictObject({
    queued: z.int().min(0),
    running: z.int().min(0),
    waiting: z.int().min(0),
    succeeded: z.int().min(0),
    failed: z.int().min(0),
    skipped: z.int().min(0),
    cancelled: z.int().min(0),
  } satisfies Record<AutomationRunStatus, z.ZodType>)
  .meta({ id: 'AutomationRunCounts' });
export type AutomationRunCounts = z.infer<typeof automationRunCountsSchema>;

/** An automation of the list, with its latest run and its run counts. */
export const automationListItemSchema = automationSchema
  .extend({
    last_run: z
      .strictObject({
        id: idOf('run'),
        status: automationRunStatusSchema,
        error_code: z.enum(AUTOMATION_RUN_ERROR_CODES).nullable(),
        created_at: isoDateTimeSchema,
        finished_at: isoDateTimeSchema.nullable(),
      })
      .nullable()
      .meta({ description: 'Latest run (by creation); `null` when it never ran' }),
    errors_24h: z.int().min(0).meta({ description: 'Runs `failed` created in the last 24 hours' }),
    run_counts_24h: automationRunCountsSchema.meta({
      description: 'Runs created in the last 24 hours, by current status',
    }),
    run_counts_7d: automationRunCountsSchema.meta({
      description: 'Runs created in the last 7 days, by current status',
    }),
  })
  .meta({ id: 'AutomationListItem' });
export type AutomationListItem = z.infer<typeof automationListItemSchema>;

/** `GET /bases/:id/automations` (CONTRACTS §21; run counts from T518). */
export const automationListSchema = offsetListSchema(automationListItemSchema).meta({
  id: 'AutomationList',
});
export type AutomationList = z.infer<typeof automationListSchema>;
