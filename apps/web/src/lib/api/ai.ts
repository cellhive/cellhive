import {
  aiAutomationDraftSchema,
  aiFormulaSchema,
  type AiAutomationDraftRequest,
  type AiFormulaRequest,
} from '@cellhive/contracts';

import { apiRequest, UNCHECKED_SCHEMA } from './client';

const id = encodeURIComponent;

/**
 * The AI routes behind the formula editor and the automation list (CONTRACTS
 * §29.2–§29.3, T913). Both store nothing and answer within the 90 s budget of
 * the server; the caller aborts with `signal` ("Cancel"). No `Idempotency-Key`:
 * a `429` (rate limit, quota) goes straight to the screen, never retried.
 * Imported by those lazy screens only, not through `api` (the app shell).
 * Responses are checked in development only: the draft's schema (every
 * automation step) stays out of the formula editor's chunk in production.
 */
export const aiApi = {
  formula: (tableId: string, body: AiFormulaRequest, signal?: AbortSignal) =>
    apiRequest(
      `/tables/${id(tableId)}/ai/formula`,
      import.meta.env.DEV ? aiFormulaSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body, signal },
    ),
  automationDraft: (baseId: string, body: AiAutomationDraftRequest, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${id(baseId)}/ai/automation-draft`,
      import.meta.env.DEV ? aiAutomationDraftSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body, signal },
    ),
};
