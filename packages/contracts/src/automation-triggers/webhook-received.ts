import { z } from 'zod';

import { idOf } from '../ids.js';

/** Detail code (`AUTOMATION_INVALID`): the hook is not a live incoming webhook of this base. */
export const UNKNOWN_WEBHOOK = 'UNKNOWN_WEBHOOK';
/** Detail code (`AUTOMATION_INVALID`): a `condition` on a trigger that has no record to test. */
export const INVALID_CONDITION = 'INVALID_CONDITION';

/**
 * Step error (`error.code`, BACKLOG T604): the request a `webhook.received`
 * run reads (`{ "trigger": "body" | "headers" | "query" }`, `[@body…]`) is
 * no longer stored — request rows are kept 7 days (CONTRACTS §25.6), so a
 * re-run of an older run fails here.
 */
export const WEBHOOK_TRIGGER_STEP_ERROR_CODES = ['trigger_data_expired'] as const;

/**
 * Run error (`error.code`, no `step`): the incoming webhook of a
 * `webhook.received` run was deleted before the run (or its resume after a
 * `delay`) started — the run does nothing more.
 */
export const WEBHOOK_TRIGGER_RUN_ERROR_CODES = ['webhook_deleted'] as const;

/** Prefix of the trigger unit of a request without a valid causation (ADR-35 §5). */
export const WEBHOOK_TRIGGER_UNIT_PREFIX = 'webhook:';

/**
 * `webhook.received` (SPEC §11.2, ADR-35 §2, BACKLOG T604): one run per
 * request accepted by `POST /api/v1/hooks/:token` (a replayed `webhook-id`
 * starts nothing). The hook must be a live incoming webhook of the same
 * base (`UNKNOWN_WEBHOOK`); the trigger has no record, so `condition` must
 * be `null` (`INVALID_CONDITION`). Base admins only: a person managing a
 * table cannot create, edit, enable or take over such an automation (`403`).
 * Values read the stored request — `{ "trigger": "body" | "headers" |
 * "query", "path" }` and `[@body.<path>]`, `[@headers.<name>]`,
 * `[@query.<path>]` in templates; sensitive headers are always `null`.
 */
export const webhookReceivedTriggerSchema = z
  .strictObject({
    type: z.literal('webhook.received'),
    incoming_webhook_id: idOf('hok').meta({ description: 'An incoming webhook of the base' }),
  })
  .meta({
    id: 'WebhookReceivedTrigger',
    description:
      'Fires once per request accepted by the incoming webhook (`UNKNOWN_WEBHOOK` when it is ' +
      'not a live hook of the base). No record: `condition` must be `null` ' +
      '(`INVALID_CONDITION`). Values: `{ "trigger": "body" | "headers" | "query", "path" }`, ' +
      'templates `[@body.<path>]`, `[@headers.<name>]`, `[@query.<path>]`. Base admins only',
  });
