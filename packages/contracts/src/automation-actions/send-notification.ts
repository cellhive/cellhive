import { z } from 'zod';

import {
  automationActionIdSchema,
  fieldValueSchema,
  stepValueSchema,
  TEMPLATE_OUTPUT_LIMITS,
} from '../automation-values.js';
import { idOf } from '../ids.js';

/**
 * `send_notification` (SPEC §11.5, CONTRACTS §21/§22, ADR-32 §1; BACKLOG
 * T515): an in-app notification of type `automation.message` (and its email,
 * by each recipient's choices — T512) to Cellhive users. Delivered only to
 * recipients who can read the linked record **and** every field the title
 * and body use; the others are left out and listed in the step output
 * (ids and reasons, never values). The text is rendered once per group of
 * recipients sharing one permission profile, with that group's access.
 */

/** Most users a step may address, after groups are expanded (ADR-32 §1). */
export const MAX_NOTIFICATION_STEP_RECIPIENTS = 100;
/** Most recipient values of one step. */
export const MAX_NOTIFICATION_RECIPIENT_VALUES = 20;
/** Longest title template source; the rendered title is one line, cut at 200. */
export const MAX_NOTIFICATION_TITLE_SOURCE = 1_000;
/** Longest body template source; the rendered body is cut at 2,000. */
export const MAX_NOTIFICATION_BODY_SOURCE = 10_000;
/**
 * `automation.message` notifications a recipient receives per rolling hour;
 * past it, one summary notification per automation and hour counts the rest.
 */
export const AUTOMATION_MESSAGES_PER_HOUR = 100;

/** `{ "user_ids": ["usr_…"] }`: fixed users (active members of the organization). */
export const notificationUserIdsSchema = z
  .strictObject({
    user_ids: z.array(idOf('usr')).min(1).max(MAX_NOTIFICATION_STEP_RECIPIENTS),
  })
  .meta({ id: 'NotificationRecipientUsers', description: 'Fixed users' });

/** `{ "group_id": "grp_…" }`: every member of a group, expanded when the step runs. */
export const notificationGroupSchema = z
  .strictObject({ group_id: idOf('grp') })
  .meta({ id: 'NotificationRecipientGroup', description: 'Members of a group (when sent)' });

/**
 * A recipient value: a `user` (or `created_by`/`updated_by`) field of the
 * trigger record, fixed users, a group, an earlier step's output (user ids
 * or `{ id }` objects) or the person who clicked the button.
 */
export const notificationRecipientValueSchema = z
  .union([
    fieldValueSchema,
    notificationUserIdsSchema,
    notificationGroupSchema,
    stepValueSchema,
    z.strictObject({ trigger: z.literal('clicked_by') }),
  ])
  .meta({ id: 'NotificationRecipientValue' });
export type NotificationRecipientValue = z.infer<typeof notificationRecipientValueSchema>;

/**
 * The record the notification links to: `trigger` (default — none when the
 * trigger has no record), the record of an earlier `create_record` /
 * `update_record` step, or `null` (no link).
 */
export const notificationLinkRecordSchema = z
  .union([z.literal('trigger'), z.strictObject({ step: automationActionIdSchema }), z.null()])
  .meta({ id: 'NotificationLinkRecord' });
export type NotificationLinkRecord = z.infer<typeof notificationLinkRecordSchema>;

export const sendNotificationConfigSchema = z
  .strictObject({
    recipients: z
      .array(notificationRecipientValueSchema)
      .min(1)
      .max(MAX_NOTIFICATION_RECIPIENT_VALUES)
      .meta({
        description: `At most ${String(MAX_NOTIFICATION_STEP_RECIPIENTS)} distinct users once groups are expanded (else the step fails with \`too_many_recipients\`)`,
      }),
    title: z.strictObject({
      template: z
        .string()
        .min(1)
        .max(MAX_NOTIFICATION_TITLE_SOURCE)
        .meta({
          description: `One-line template (plain text); rendered ≤ ${String(TEMPLATE_OUTPUT_LIMITS.notification_title)} characters`,
        }),
    }),
    body: z
      .strictObject({
        template: z
          .string()
          .max(MAX_NOTIFICATION_BODY_SOURCE)
          .meta({
            description: `Plain-text template (no Markdown, no HTML); rendered ≤ ${String(TEMPLATE_OUTPUT_LIMITS.notification_body)} characters`,
          }),
      })
      .default({ template: '' }),
    link_record: notificationLinkRecordSchema.default('trigger'),
    skip_actor: z.boolean().default(false).meta({
      description: 'Leave out the person behind the trigger event (default: they are notified too)',
    }),
  })
  .meta({ id: 'SendNotificationConfig' });
export type SendNotificationConfig = z.infer<typeof sendNotificationConfigSchema>;
export type SendNotificationConfigInput = z.input<typeof sendNotificationConfigSchema>;

export const sendNotificationActionSchema = z
  .strictObject({
    id: automationActionIdSchema,
    type: z.literal('send_notification'),
    config: sendNotificationConfigSchema,
  })
  .meta({
    id: 'SendNotificationAction',
    description:
      'Output: `{ recipients, delivered, turned_off, summarized, groups, record_id, skipped: ' +
      '[{ user_id, reason }] }` — never the title or body',
  });

// --- Save-time detail codes (`422 AUTOMATION_INVALID`) ---------------------------------

/** A fixed recipient that is not an active member of the organization. */
export const NOTIFICATION_USER_NOT_FOUND = 'USER_NOT_FOUND';
/** A recipient group that does not exist in the organization. */
export const NOTIFICATION_GROUP_NOT_FOUND = 'GROUP_NOT_FOUND';

// --- Run step -------------------------------------------------------------------------

/** Why a recipient was left out (step output; ids only, never values). */
export const NOTIFICATION_SKIP_REASONS = [
  'actor',
  'not_member',
  'cannot_read_base',
  'cannot_read_record',
  'cannot_read_field',
] as const;
export type NotificationSkipReason = (typeof NOTIFICATION_SKIP_REASONS)[number];

/** Output of a `send_notification` step (no title, no body). */
export const sendNotificationStepOutputSchema = z
  .object({
    recipients: z.int().min(0).meta({ description: 'Distinct users addressed' }),
    delivered: z.int().min(0).meta({ description: 'Notifications recorded (in-app or email)' }),
    turned_off: z
      .int()
      .min(0)
      .meta({ description: 'Allowed recipients who turned every channel of the type off' }),
    summarized: z
      .int()
      .min(0)
      .meta({
        description: `Recipients over ${String(AUTOMATION_MESSAGES_PER_HOUR)} messages in the past hour: counted in one summary notification instead`,
      }),
    groups: z.int().min(0).meta({ description: 'Permission groups the text was rendered for' }),
    record_id: idOf('rec').nullable().meta({ description: 'The linked record' }),
    skipped: z.array(z.object({ user_id: idOf('usr'), reason: z.enum(NOTIFICATION_SKIP_REASONS) })),
  })
  .meta({ id: 'SendNotificationStepOutput' });
export type SendNotificationStepOutput = z.infer<typeof sendNotificationStepOutputSchema>;
