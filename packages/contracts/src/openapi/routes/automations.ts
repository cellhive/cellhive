import { z } from 'zod';

import {
  automationListSchema,
  automationRunDetailSchema,
  automationRunListQuerySchema,
  automationRunListSchema,
  automationRunSchema,
  baseAutomationRunListQuerySchema,
} from '../../automation-runs.js';
import {
  automationActionIdSchema,
  automationEmailPreviewRequestSchema,
  automationEmailPreviewSchema,
  automationEmailTestRequestSchema,
  automationEmailTestResultSchema,
  automationIfMatchHeaderSchema,
  automationListQuerySchema,
  automationSchema,
  createAutomationRequestSchema,
  duplicateAutomationRequestSchema,
  takeOverAutomationRequestSchema,
  updateAutomationRequestSchema,
  validateAutomationTemplateRequestSchema,
  validateAutomationTemplateResponseSchema,
} from '../../automations.js';
import {
  BUTTON_CLICK_RECORD_INTERVAL_SECONDS,
  BUTTON_CLICKS_PER_MINUTE,
  buttonClickParamsSchema,
  buttonClickResponseSchema,
} from '../../buttons.js';
import {
  httpDeliveryIdSchema,
  httpDeliveryResultSchema,
  httpTestAcceptedSchema,
  httpTestRequestSchema,
} from '../../http-deliveries.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const automationParams = z.object({ automationId: idOf('aut') });
const runParams = z.object({ runId: idOf('run') });

const RUN_LOG =
  'Run history is for people who manage the automation (ADR-25 §3); anyone else — also ' +
  'someone who sees the automation but cannot manage it — gets `404` (runs carry record data).';
const emailStepParams = z.object({
  automationId: idOf('aut'),
  actionId: automationActionIdSchema,
});

const MANAGE =
  'Managing an automation needs base admin, or `manage` on the trigger table (ADR-25 §3; a ' +
  '`schedule` or `webhook.received` trigger: base admin only). Someone who opens the base ' +
  'and reads the trigger ' +
  'table gets `403 PERMISSION_DENIED`; anyone else `404`.';
const RUN_AS =
  'The caller becomes `run_as` (ADR-25 §2), so the definition must be valid with the ' +
  "caller's own permissions: tables/fields/views they cannot read answer like missing ones " +
  '(`UNKNOWN_TABLE`/`UNKNOWN_FIELD`/`UNKNOWN_VIEW`), missing write rights `PERMISSION_DENIED`. ' +
  'Emits `automation.run_as_changed` when `run_as` moves.';
const INVALID =
  '`AUTOMATION_INVALID`: `errors[].path` under `definition.` with a detail code ' +
  '(`PERMISSION_DENIED`, `UNKNOWN_TABLE`, `UNKNOWN_FIELD`, `UNKNOWN_VIEW`, `INVALID_FIELD_TYPE`, ' +
  '`FIELD_READ_ONLY`, `TOO_MANY_ACTIONS`, `DUPLICATE_ACTION_ID`, `UNKNOWN_STEP`, ' +
  '`NO_TRIGGER_RECORD`, `NOT_TRIGGER_TABLE`, `UNSUPPORTED_VALUE_SOURCE`, `NO_ACTIONS`, filter ' +
  'codes; templates: `UNSUPPORTED_FUNCTION`, `CROSS_TABLE_NOT_SUPPORTED`, ' +
  '`UNTERMINATED_PLACEHOLDER`, `EMPTY_PLACEHOLDER`, `TOO_MANY_PLACEHOLDERS` and formula codes, ' +
  'with `params.position`; `send_email` (T514): `INVALID_EMAIL`, `EMAIL_REPLY_TO_INVALID`, ' +
  '`EMAIL_IDENTITY_NOT_USABLE`, `EMAIL_FOOTER_NOT_ALLOWED`, `ATTACHMENT_FIELD_INVALID`, ' +
  '`ATTACHMENT_FIELD_NOT_DOWNLOADABLE` (T532 — also for `![…](field:…)` body images), ' +
  'body images (T534): `IMAGE_SOURCE_NOT_ALLOWED`, `EMAIL_IMAGE_NOT_FOUND`, `TOO_MANY_IMAGES`; ' +
  '`send_notification` (T515): `USER_NOT_FOUND`, `GROUP_NOT_FOUND`; `button.clicked` (T517): ' +
  '`BUTTON_IN_USE`; `webhook.received` (T604): `UNKNOWN_WEBHOOK`, `INVALID_CONDITION`; ' +
  '`send_telegram` / `http_request` / `run_n8n_workflow` (T516, T606, T607): ' +
  '`SECRET_NOT_USABLE`; `http_request` / `run_n8n_workflow`: `HEADER_NOT_ALLOWED`, ' +
  '`INVALID_URL`; `run_n8n_workflow`: `fields` → `UNKNOWN_FIELD`, `NO_TRIGGER_RECORD`); or ' +
  '`VALIDATION_FAILED` for a ' +
  'malformed body';
const EMAIL_RENDER =
  "The step is rendered with the caller's own permissions (who becomes `run_as` on save) on " +
  '`record_id`, a record of the trigger table the caller reads (`404` otherwise); fields the ' +
  'caller cannot read stay empty, earlier steps do not run. `draft` (the unsaved builder ' +
  'configuration) or the saved step is checked like a save first.';
const CONFLICT = '`VERSION_CONFLICT`: `If-Match` / `version` is not the current version';

/** Automations (SPEC §11, CONTRACTS §21; BACKLOG T502). */
export const registerAutomationRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/automations',
    operationId: 'listAutomations',
    tag: 'automations',
    summary: 'Automations of a base the caller manages',
    description:
      'Oldest first. Base admins see every automation; people with `manage` on some tables ' +
      'see those triggered on these tables. Anyone else who opens the base gets `403`.',
    params: baseParams,
    query: automationListQuerySchema,
    status: 200,
    response: automationListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/automations',
    operationId: 'createAutomation',
    tag: 'automations',
    summary: 'Create an automation (off unless `enabled`)',
    description:
      `${MANAGE} The creator is \`run_as\`. ${RUN_AS} Emits \`automation.created\` ` +
      '(and `automation.enabled` when created on) with its audit entry.',
    params: baseParams,
    body: createAutomationRequestSchema,
    status: 201,
    response: automationSchema,
    errors: { 422: INVALID },
  });
  add({
    method: 'get',
    path: '/api/v1/automations/{automationId}',
    operationId: 'getAutomation',
    tag: 'automations',
    summary: 'An automation with its definition and `run_as`',
    description: MANAGE,
    params: automationParams,
    status: 200,
    response: automationSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/automations/{automationId}',
    operationId: 'updateAutomation',
    tag: 'automations',
    summary: 'Rename, describe or change the definition',
    description:
      `${MANAGE} Name and description keep \`run_as\`. A different \`definition\` makes the ` +
      `caller \`run_as\`: ${RUN_AS} Emits \`automation.updated\` with its audit entry.`,
    params: automationParams,
    headers: automationIfMatchHeaderSchema,
    body: updateAutomationRequestSchema,
    status: 200,
    response: automationSchema,
    errors: { 409: CONFLICT, 422: INVALID },
  });
  add({
    method: 'delete',
    path: '/api/v1/automations/{automationId}',
    operationId: 'deleteAutomation',
    tag: 'automations',
    summary: 'Delete an automation (soft delete; it stops running)',
    description: `${MANAGE} Emits \`automation.deleted\` with its audit entry.`,
    params: automationParams,
    headers: automationIfMatchHeaderSchema,
    status: 204,
    errors: { 409: CONFLICT },
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/enable',
    operationId: 'enableAutomation',
    tag: 'automations',
    summary: 'Turn an automation on',
    description:
      `${MANAGE} ${RUN_AS} Clears \`disabled_reason\`. Needs at least one action ` +
      '(`NO_ACTIONS`). Already on with the caller as `run_as`: nothing changes. Emits ' +
      '`automation.enabled`.',
    params: automationParams,
    headers: automationIfMatchHeaderSchema,
    status: 200,
    response: automationSchema,
    errors: { 409: CONFLICT, 422: INVALID },
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/disable',
    operationId: 'disableAutomation',
    tag: 'automations',
    summary: 'Turn an automation off',
    description:
      `${MANAGE} Keeps \`run_as\`; \`disabled_reason\` becomes \`null\`. Already off: nothing ` +
      'changes. Emits `automation.disabled`.',
    params: automationParams,
    headers: automationIfMatchHeaderSchema,
    status: 200,
    response: automationSchema,
    errors: { 409: CONFLICT },
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/take-over',
    operationId: 'takeOverAutomation',
    tag: 'automations',
    summary: 'Become `run_as` (and optionally turn it back on)',
    description:
      `${MANAGE} ADR-25 §6: for an automation turned off because \`run_as\` lost access, or ` +
      `any automation another manager runs. ${RUN_AS} With \`enable: true\` also turns it on.`,
    params: automationParams,
    headers: automationIfMatchHeaderSchema,
    body: takeOverAutomationRequestSchema,
    status: 200,
    response: automationSchema,
    errors: { 409: CONFLICT, 422: INVALID },
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/duplicate',
    operationId: 'duplicateAutomation',
    tag: 'automations',
    summary: 'Copy an automation (off, the caller `run_as`) with its email body images',
    description:
      `${MANAGE} BACKLOG T551: the copy is in the same base, turned off, with the caller as ` +
      'creator and `run_as`; named `name` or "«name» (copy)" / "«name» (bản sao)" in the ' +
      "caller's language (cut to 255 characters). Like a create, the definition is checked " +
      "with the caller's own permissions: `422 AUTOMATION_INVALID` and nothing is created when " +
      'it reaches what the caller cannot read or write. Body images of `send_email` steps are ' +
      'copied (new images of the copy in the same organization) and `asset:<id>` of the copy ' +
      'names them; an image of the source that is gone → `EMAIL_IMAGE_NOT_FOUND`. A ' +
      '`button.clicked` automation cannot be copied: a button runs one automation ' +
      '(`BUTTON_IN_USE`, `params.reason = duplicate`). Runs, history and counters are not ' +
      'copied. Emits `automation.created` (`after.duplicated_from`) and ' +
      '`automation.run_as_changed` (`reason: created`) with their audit entries.',
    params: automationParams,
    body: duplicateAutomationRequestSchema,
    bodyOptional: true,
    status: 201,
    response: automationSchema,
    errors: { 422: INVALID },
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/automations/validate-template',
    operationId: 'validateAutomationTemplate',
    tag: 'automations',
    summary: 'Check a template for the builder (`{{ formula }}`, names ↔ ids)',
    description:
      "BACKLOG T504: the check of saving, with the caller's permissions (the caller becomes " +
      '`run_as` on save): `{{ }}` syntax, formula syntax/types, fields the caller cannot read ' +
      '(`UNKNOWN_FIELD`), `REGEX*` (`UNSUPPORTED_FUNCTION`), whole tables ' +
      '(`CROSS_TABLE_NOT_SUPPORTED`). Always `200` with `valid`, `errors[]` (`params.position`), ' +
      'the stored and display forms and each placeholder (chips). Never returns record values. ' +
      'Needs to manage an automation of the base (`403` otherwise); `table_id` the caller ' +
      'cannot read → `404`.',
    params: baseParams,
    body: validateAutomationTemplateRequestSchema,
    status: 200,
    response: validateAutomationTemplateResponseSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/email-preview',
    operationId: 'previewAutomationEmail',
    tag: 'automations',
    summary: 'Preview the email of a `send_email` step (nothing is sent)',
    description:
      `BACKLOG T514. ${MANAGE} ${EMAIL_RENDER} Returns the subject, the HTML document (show ` +
      'it in a sandboxed iframe without scripts), the text part, the `From`/`Reply-To` ' +
      'recipients will see, masked recipients and builder warnings (`RECIPIENT_MAY_NOT_READ`, ' +
      '`ON_BEHALF_DMARC`, `EXTERNAL_RECIPIENTS`).',
    params: emailStepParams,
    body: automationEmailPreviewRequestSchema,
    status: 200,
    response: automationEmailPreviewSchema,
    errors: { 422: INVALID },
  });
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/email-test',
    operationId: 'sendAutomationTestEmail',
    tag: 'automations',
    summary: 'Send the email of a `send_email` step to the caller only',
    description:
      `BACKLOG T514. ${MANAGE} ${EMAIL_RENDER} The email goes only to the caller's own ` +
      'address (no other recipient is accepted), with the subject prefixed `[Test]`/`[Thử]` ' +
      'and the same sender, headers, signature, footer and attachments (T532: the real files, ' +
      'streamed) as a real one. SMTP failures are a ' +
      '`200` result (`status: failed`). Audited `automation.test_email_sent` without content.',
    params: emailStepParams,
    body: automationEmailTestRequestSchema,
    status: 200,
    response: automationEmailTestResultSchema,
    errors: {
      422:
        `${INVALID}; \`ATTACHMENTS_UNAVAILABLE\` (\`params.code\`: the attachment step error ` +
        `the record would cause); \`SMTP_NOT_CONFIGURED\` when the sender needs the instance SMTP`,
      429: '`RATE_LIMITED`: more than `EMAIL_TEST_SEND_PER_MIN` test emails per minute',
    },
  });

  // --- HTTP request test (BACKLOG T606) ------------------------------------------------
  add({
    method: 'post',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/http-test',
    operationId: 'sendAutomationTestHttpRequest',
    tag: 'automations',
    summary: 'Send the request of an `http_request` step once, as a test',
    description:
      `BACKLOG T606, CONTRACTS §25.5. ${MANAGE} The step (\`draft\` or the saved one) is ` +
      "checked like a save and rendered with the caller's own permissions on `record_id` (a " +
      'record of the trigger table the caller reads, `404` otherwise; earlier steps do not ' +
      'run). It goes through the outbox as a `test` delivery (no causation token, kept 24 ' +
      'hours): the API never calls the destination. Read the result with ' +
      '`GET /http-deliveries/{deliveryId}`. Audited `automation.test_http_sent` (action, ' +
      'delivery id, host).',
    params: emailStepParams,
    body: httpTestRequestSchema,
    status: 202,
    response: httpTestAcceptedSchema,
    errors: {
      422:
        `${INVALID}; a request that cannot be rendered: \`INVALID_VALUE\` (\`params.code\`, ` +
        '`params.reason`), `TOO_BIG` (body over 1 MiB), `INVALID_URL`',
      429: '`RATE_LIMITED`: more than 10 tests per minute by the caller',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/http-deliveries/{deliveryId}',
    operationId: 'getHttpDelivery',
    tag: 'automations',
    summary: 'Result of an `http_request` test',
    description:
      'BACKLOG T606, CONTRACTS §25.5. A `test` delivery, for the person who sent it only (it ' +
      'was rendered with their permissions); anyone else — managers of the automation ' +
      'included — and any delivery of a run gets `404`. ' +
      'Status, attempts, the kept response (status, `content-type`, body cut at 10 KB) and ' +
      'the error code — never the URL, request headers, request body or secret values.',
    params: z.object({ deliveryId: httpDeliveryIdSchema }),
    status: 200,
    response: httpDeliveryResultSchema,
  });

  // --- Run history (BACKLOG T518) ------------------------------------------------------
  add({
    method: 'get',
    path: '/api/v1/automations/{automationId}/runs',
    operationId: 'listAutomationRuns',
    tag: 'automations',
    summary: 'Runs of an automation, newest first',
    description:
      `${RUN_LOG} Filters: \`status\` (comma-separated), \`from\` (inclusive) / \`to\` ` +
      '(exclusive) on `created_at`. Cursor-paginated (`next_cursor`).',
    params: automationParams,
    query: automationRunListQuerySchema,
    status: 200,
    response: automationRunListSchema,
    forbidden: '`PERMISSION_DENIED` is never returned here: a caller who cannot manage gets 404',
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/automation-runs',
    operationId: 'listBaseAutomationRuns',
    tag: 'automations',
    summary: 'Runs of the automations of a base the caller manages, newest first',
    description:
      'Base admins see the runs of every automation; people with `manage` on some tables ' +
      'those of the automations triggered on these tables. Anyone else who opens the base ' +
      'gets `403`. Same filters as the list of one automation, plus `automation_id`.',
    params: baseParams,
    query: baseAutomationRunListQuerySchema,
    status: 200,
    response: automationRunListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/automation-runs/{runId}',
    operationId: 'getAutomationRun',
    tag: 'automations',
    summary: 'A run with its steps, the definition it used and its re-runs',
    description:
      `${RUN_LOG} Step outputs are filtered with the caller's **current** permissions: ` +
      'values of fields they cannot read and records outside their read rule are `null` ' +
      '(`redacted`, `redacted_fields`). `definition` is the snapshot of `automation_version`; ' +
      '`automation.version` is the current one.',
    params: runParams,
    status: 200,
    response: automationRunDetailSchema,
    forbidden: '`PERMISSION_DENIED` is never returned here: a caller who cannot manage gets 404',
  });
  add({
    method: 'post',
    path: '/api/v1/automation-runs/{runId}/rerun',
    operationId: 'rerunAutomationRun',
    tag: 'automations',
    summary: 'Run a failed or cancelled run again (a new run, current definition)',
    description:
      `${RUN_LOG} Creates a new \`queued\` run with the automation's **current** definition ` +
      'and version and the original trigger (`rerun_of`, `rerun_by`). Steps that succeeded ' +
      'in the original and are still the same action (id, type, table) are reused, not run ' +
      'again. Audited as `automation.run.rerun`.',
    params: runParams,
    status: 201,
    response: automationRunSchema,
    errors: {
      409:
        '`RUN_STATE_CONFLICT`: the run is not `failed`/`cancelled`, or a re-run of it has not ' +
        'finished yet',
      422: '`AUTOMATION_INVALID`: the stored definition no longer parses (save it again)',
    },
    forbidden: '`CSRF_INVALID` (a caller who cannot manage gets 404)',
  });
  add({
    method: 'post',
    path: '/api/v1/automation-runs/{runId}/cancel',
    operationId: 'cancelAutomationRun',
    tag: 'automations',
    summary: 'Cancel a run that has not started or waits in a delay',
    description:
      `${RUN_LOG} A \`queued\` or \`waiting\` run becomes \`cancelled\` (\`error.code = ` +
      'cancelled_by_user`); its waiting steps too. Audited as `automation.run.cancelled`.',
    params: runParams,
    status: 200,
    response: automationRunSchema,
    errors: { 409: '`RUN_STATE_CONFLICT`: the run is running or already finished' },
    forbidden: '`CSRF_INVALID` (a caller who cannot manage gets 404)',
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/records/{recordId}/buttons/{fieldId}/click',
    operationId: 'clickButton',
    tag: 'automations',
    summary: 'Click a button field: queue the run of its automation',
    description:
      'BACKLOG T517, ADR-32 §2. The click runs the automation attached to the button ' +
      '(trigger `button.clicked`) as its `run_as`, never as the caller; the trigger data holds ' +
      '`clicked_by` (the caller) and `clicked_at`. Checks, in order: the record and the field ' +
      'must be readable by the caller (else `404`); the caller must have the trigger’s ' +
      '`min_permission` on the record (`edit`: may edit it — table permission and edit rule; ' +
      '`read`: may read it), else `403`; the automation must exist and be on, and ' +
      '`enabled_when` (with the automation’s condition) must hold for the latest record read as ' +
      '`run_as`, else `422`. Emits `button.clicked` (and its audit entry) with the queued run in ' +
      'one transaction; the caller alone gets `automation.run.finished` on `user:{id}` when the ' +
      `run ends. At most ${String(BUTTON_CLICKS_PER_MINUTE)} clicks per minute per button and ` +
      `user, and one per ${String(BUTTON_CLICK_RECORD_INTERVAL_SECONDS)} s per button, record ` +
      'and user. Share links have no click route: anonymous viewers never run automations.',
    params: buttonClickParamsSchema,
    status: 202,
    response: buttonClickResponseSchema,
    forbidden:
      '`PERMISSION_DENIED`: below the trigger’s `min_permission` on the record; or `CSRF_INVALID`',
    errors: {
      422:
        '`VALIDATION_FAILED` / `BUTTON_DISABLED` (`params.reason`: `no_automation`, ' +
        '`automation_disabled`, `condition`)',
      429:
        `\`RATE_LIMITED\` with \`Retry-After\`: more than ${String(BUTTON_CLICKS_PER_MINUTE)} ` +
        `clicks of the button per minute, or two within ` +
        `${String(BUTTON_CLICK_RECORD_INTERVAL_SECONDS)} s on one record (plus the API limits)`,
    },
  });
};
