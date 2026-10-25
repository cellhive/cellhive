import { z } from 'zod';

import { idOf } from './ids.js';

/**
 * Button fields and their clicks (SPEC §5.5, §11.2; ADR-32 §2; BACKLOG
 * T517, CONTRACTS §2, §21). A `button` field has no physical column and no
 * stored value: its cell is computed per viewer, and a click runs the one
 * automation whose trigger is `button.clicked` on it, as that automation's
 * `run_as`.
 */

/** Longest button label, in characters after trimming. */
export const MAX_BUTTON_LABEL_LENGTH = 100;
/** Longest confirmation title / button text of the confirmation dialog. */
export const MAX_BUTTON_CONFIRM_TITLE_LENGTH = 200;
export const MAX_BUTTON_CONFIRM_LABEL_LENGTH = 100;
/** Longest confirmation message. */
export const MAX_BUTTON_CONFIRM_MESSAGE_LENGTH = 1_000;
/** Largest colour index of the label palette (same palette as select options). */
export const MAX_BUTTON_COLOR = 54;

/** The confirmation dialog shown before a click is sent (`null` = none). */
export const buttonConfirmSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(MAX_BUTTON_CONFIRM_TITLE_LENGTH),
    message: z.string().max(MAX_BUTTON_CONFIRM_MESSAGE_LENGTH).default(''),
    confirm_label: z.string().trim().min(1).max(MAX_BUTTON_CONFIRM_LABEL_LENGTH),
  })
  .meta({ id: 'ButtonConfirm' });
export type ButtonConfirm = z.infer<typeof buttonConfirmSchema>;

/**
 * `options` of a `button` field (SPEC §5.5): the label on the button, its
 * colour (index of the label palette, light background) and an optional
 * confirmation. What a click does lives in the automation (`button.clicked`).
 */
export const buttonFieldOptionsSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(MAX_BUTTON_LABEL_LENGTH).default('Run'),
    color: z.int().min(0).max(MAX_BUTTON_COLOR).default(0),
    confirm: buttonConfirmSchema.nullable().default(null),
  })
  .meta({ id: 'ButtonFieldOptions' });
export type ButtonFieldOptions = z.output<typeof buttonFieldOptionsSchema>;

/** `state` of a button cell. */
export const BUTTON_CELL_STATES = ['ready', 'disabled'] as const;
/**
 * Why a button cell is `disabled` (first that applies):
 * - `no_automation`: no (non-deleted) automation is attached to the button;
 * - `automation_disabled`: its automation is turned off;
 * - `permission`: the viewer's permission on the record is below the
 *   trigger's `min_permission` — or the cell is read through a share link,
 *   where buttons never run;
 * - `condition`: `enabled_when` (and the automation's condition), evaluated
 *   as `run_as`, does not hold for the record.
 */
export const BUTTON_DISABLED_REASONS = [
  'no_automation',
  'automation_disabled',
  'permission',
  'condition',
] as const;
export type ButtonDisabledReason = (typeof BUTTON_DISABLED_REASONS)[number];

/**
 * The value of a `button` cell (`cell_format=json`, CONTRACTS §2): computed
 * by the server for the reader. Never the values `enabled_when` reads: one
 * bit about the record (ADR-32 §2). `cell_format=text` (and exports) give the
 * label.
 */
export const buttonCellSchema = z
  .discriminatedUnion('state', [
    z.strictObject({ state: z.literal('ready'), reason: z.null() }),
    z.strictObject({ state: z.literal('disabled'), reason: z.enum(BUTTON_DISABLED_REASONS) }),
  ])
  .meta({ id: 'ButtonCell' });
export type ButtonCell = z.infer<typeof buttonCellSchema>;

/**
 * `button` of a field DTO (T517): the automation attached to the button and
 * its click permission (`min_permission` is edited in the automation builder
 * only — changing it moves `run_as`, ADR-25 §2). No `run_as`, no condition:
 * the automation itself is for the people who manage it.
 */
export const buttonFieldSummarySchema = z
  .strictObject({
    automation_id: idOf('aut').nullable().meta({
      description: 'The automation (not deleted) attached to the button; `null` = none',
    }),
    automation_enabled: z.boolean(),
    min_permission: z.enum(['edit', 'read']).nullable().meta({
      description: 'Least permission on a record to click (`null` without automation)',
    }),
  })
  .meta({ id: 'ButtonFieldSummary' });
export type ButtonFieldSummary = z.infer<typeof buttonFieldSummarySchema>;

/** Clicks per minute per (button, user) (ADR-32 §2). */
export const BUTTON_CLICKS_PER_MINUTE = 10;
/** Seconds between two clicks of one button on one record by one user. */
export const BUTTON_CLICK_RECORD_INTERVAL_SECONDS = 2;

/** `POST /tables/:tableId/records/:recordId/buttons/:fieldId/click` path parameters. */
export const buttonClickParamsSchema = z.strictObject({
  tableId: idOf('tbl'),
  recordId: idOf('rec'),
  fieldId: idOf('fld'),
});
export type ButtonClickParams = z.infer<typeof buttonClickParamsSchema>;

/** `202` of a click: the queued run (follow it with `automation.run.finished` on `user:{id}`). */
export const buttonClickResponseSchema = z
  .strictObject({
    run_id: idOf('run').meta({ description: 'The run the click queued' }),
  })
  .meta({ id: 'ButtonClickResponse' });
export type ButtonClickResponse = z.infer<typeof buttonClickResponseSchema>;
