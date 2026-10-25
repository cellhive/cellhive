import {
  automationRunDetailSchema,
  automationRunListSchema,
  automationRunSchema,
  type AutomationRunStatus,
} from '@cellhive/contracts';

import { apiRequest } from '../../../lib/api/client';

const id = encodeURIComponent;

/** Filters of a run list page (CONTRACTS §21 "Lịch sử chạy"). */
export interface RunListParams {
  readonly status?: readonly AutomationRunStatus[] | undefined;
  /** Inclusive lower bound of `created_at` (ISO). */
  readonly from?: string | undefined;
  /** Only the runs of this trigger event (`evt_…`, T616: a webhook request). */
  readonly eventId?: string | undefined;
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

function listQuery(params: RunListParams) {
  return {
    status:
      params.status === undefined || params.status.length === 0
        ? undefined
        : params.status.join(','),
    from: params.from,
    event_id: params.eventId,
    cursor: params.cursor ?? undefined,
    limit: params.limit,
  };
}

/**
 * The run log of automations (T518, CONTRACTS §21): only for people who
 * manage the automation (`404` otherwise; the base list answers `403` to a
 * caller who manages none). Step outputs come redacted by the caller's
 * current permissions. No realtime: the screen polls while runs are active.
 */
export const automationRunsApi = {
  /** Runs of one automation, newest first. */
  list: (automationId: string, params: RunListParams, signal?: AbortSignal) =>
    apiRequest(`/automations/${id(automationId)}/runs`, automationRunListSchema, {
      query: listQuery(params),
      signal,
    }),
  /** Runs of every automation of the base the caller manages, newest first. */
  listOfBase: (
    baseId: string,
    params: RunListParams & { readonly automationId?: string | undefined },
    signal?: AbortSignal,
  ) =>
    apiRequest(`/bases/${id(baseId)}/automation-runs`, automationRunListSchema, {
      query: { ...listQuery(params), automation_id: params.automationId },
      signal,
    }),
  /** One run with its steps, the definition it used and its re-runs. */
  get: (runId: string, signal?: AbortSignal) =>
    apiRequest(`/automation-runs/${id(runId)}`, automationRunDetailSchema, { signal }),
  /** A new run of a `failed`/`cancelled` one, with the automation's current definition. */
  rerun: (runId: string) =>
    apiRequest(`/automation-runs/${id(runId)}/rerun`, automationRunSchema, {
      method: 'POST',
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
  /** Stops a `queued`/`waiting` run. */
  cancel: (runId: string) =>
    apiRequest(`/automation-runs/${id(runId)}/cancel`, automationRunSchema, {
      method: 'POST',
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }),
};
