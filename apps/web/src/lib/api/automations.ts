import {
  automationEmailPreviewSchema,
  automationEmailTestResultSchema,
  automationListSchema,
  automationSchema,
  baseEmailIdentityListSchema,
  MAX_LIST_LIMIT,
  validateAutomationTemplateResponseSchema,
  type AutomationDefinitionInput,
  type SendEmailConfigInput,
  type ValidateAutomationTemplateRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid } from './client';

const id = encodeURIComponent;

/** `POST /bases/:id/automations` body as sent (defaults filled by the server). */
export interface CreateAutomationBody {
  readonly name: string;
  readonly description?: string;
  readonly definition: AutomationDefinitionInput;
  readonly enabled?: boolean;
}

/** `PATCH /automations/:id` body as sent: only what changed (CONTRACTS §21). */
export interface UpdateAutomationBody {
  readonly name?: string;
  readonly description?: string;
  readonly definition?: AutomationDefinitionInput;
}

/** `POST /bases/:id/automations/validate-template` body (defaults filled by the server). */
export type ValidateTemplateBody = Pick<
  ValidateAutomationTemplateRequest,
  'table_id' | 'template'
> &
  Partial<Omit<ValidateAutomationTemplateRequest, 'table_id' | 'template'>>;

/** Body of the email preview and test send (CONTRACTS §21): a record and the builder's draft. */
export interface EmailPreviewBody {
  readonly record_id: string | null;
  readonly draft?: SendEmailConfigInput;
}

/**
 * `If-Match` with the version the screen showed (CONTRACTS §21): a change
 * made meanwhile elsewhere answers `409 VERSION_CONFLICT` instead of being
 * overwritten.
 */
function ifMatch(version: number): Readonly<Record<string, string>> {
  return { 'If-Match': `"${String(version)}"` };
}

/**
 * Automations of a base (CONTRACTS §21, T502). The list holds what the
 * caller manages (base admins: all; table managers: those triggered on
 * their tables); a caller who manages nothing gets `403`.
 */
export const automationsApi = {
  /** Every automation the caller manages (no cap per base in S5: one page of the maximum size). */
  list: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/automations`, automationListSchema, {
      query: { offset: 0, limit: MAX_LIST_LIMIT },
      signal,
    }),
  /** (T521) One automation, for the builder. */
  get: (automationId: string, signal?: AbortSignal) =>
    apiRequest(`/automations/${id(automationId)}`, automationSchema, { signal }),
  /**
   * (T521) Saves the builder: only the parts that changed. A new definition
   * makes the caller `run_as` (ADR-25 §2); `version` is the one the builder
   * started from, so a change made meanwhile answers `409 VERSION_CONFLICT`.
   */
  update: (automationId: string, version: number, body: UpdateAutomationBody) =>
    apiRequest(`/automations/${id(automationId)}`, automationSchema, {
      method: 'PATCH',
      // `version` in the body too: a `429` may then be sent again (a second apply is a `409`).
      body: { ...body, version },
      headers: ifMatch(version),
    }),
  /**
   * (T521) Checks a template like the server does when saving, with the
   * caller's permissions (CONTRACTS §21): names ⇄ ids, errors with positions.
   * Never returns record values.
   */
  validateTemplate: (baseId: string, body: ValidateTemplateBody, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${id(baseId)}/automations/validate-template`,
      validateAutomationTemplateResponseSchema,
      { method: 'POST', body, signal },
    ),
  create: (baseId: string, body: CreateAutomationBody) =>
    apiRequest(`/bases/${id(baseId)}/automations`, automationSchema, {
      method: 'POST',
      body,
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /**
   * (T556, T551) Copies an automation the caller manages: same base, turned
   * off, the caller as creator and `run_as`, the definition checked with the
   * caller's permissions (`422 AUTOMATION_INVALID`, nothing created), email
   * body images copied. The name defaults to "«name» (copy)" in the caller's
   * language (CONTRACTS §21 "Nhân bản").
   */
  duplicate: (automationId: string) =>
    apiRequest(`/automations/${id(automationId)}/duplicate`, automationSchema, {
      method: 'POST',
      body: {},
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  remove: (automationId: string, version: number) =>
    apiRequestVoid(`/automations/${id(automationId)}`, {
      method: 'DELETE',
      headers: ifMatch(version),
    }),
  /** Turns it on; the caller becomes `run_as` (ADR-25 §2). */
  enable: (automationId: string, version: number) =>
    apiRequest(`/automations/${id(automationId)}/enable`, automationSchema, {
      method: 'POST',
      headers: ifMatch(version),
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /** Turns it off; `run_as` stays. */
  disable: (automationId: string, version: number) =>
    apiRequest(`/automations/${id(automationId)}/disable`, automationSchema, {
      method: 'POST',
      headers: ifMatch(version),
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /**
   * (T522) The email of a `send_email` step rendered on a record, with the
   * caller's own permissions (CONTRACTS §21): HTML for a sandboxed frame,
   * text, the headers recipients will see, files, warnings. Sends nothing.
   */
  emailPreview: (
    automationId: string,
    actionId: string,
    body: EmailPreviewBody,
    signal?: AbortSignal,
  ) =>
    apiRequest(
      `/automations/${id(automationId)}/actions/${id(actionId)}/email-preview`,
      automationEmailPreviewSchema,
      { method: 'POST', body, signal },
    ),
  /**
   * (T522) "Send a test to me": the same email, only to the caller, subject
   * prefixed `[Test]`; `EMAIL_TEST_SEND_PER_MIN` per minute (`429`). An SMTP
   * failure is a result (`status: failed`), not an error.
   */
  emailTest: (automationId: string, actionId: string, body: EmailPreviewBody) =>
    apiRequest(
      `/automations/${id(automationId)}/actions/${id(actionId)}/email-test`,
      automationEmailTestResultSchema,
      { method: 'POST', body },
    ),
  /**
   * (T522) Verified sender identities usable in a base (CONTRACTS §23.3):
   * for people who manage its automations; never SMTP settings.
   */
  emailIdentities: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/email-identities`, baseEmailIdentityListSchema, { signal }),
  /** "Take over" (ADR-25 §6): the caller becomes `run_as`, and turns it on with `enable`. */
  takeOver: (automationId: string, version: number, enable: boolean) =>
    apiRequest(`/automations/${id(automationId)}/take-over`, automationSchema, {
      method: 'POST',
      body: { enable },
      headers: ifMatch(version),
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
};
