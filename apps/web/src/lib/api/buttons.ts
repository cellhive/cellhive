import { buttonClickResponseSchema } from '@cellhive/contracts';

import { apiRequest } from './client';

const id = encodeURIComponent;

/**
 * Button fields (T517, CONTRACTS §21 "Button"). A click queues a run of the
 * button's automation (as its `run_as`) and answers `202 { run_id }`; the
 * end of the run comes as `automation.run.finished` on `user:<me>`.
 */
export const buttonsApi = {
  /**
   * `POST /tables/:tableId/records/:recordId/buttons/:fieldId/click`. The
   * `Idempotency-Key` makes a resend return the same run. A `429` is not
   * waited for: the caller says when to try again (`Retry-After`).
   */
  click: (tableId: string, recordId: string, fieldId: string, idempotencyKey: string) =>
    apiRequest(
      `/tables/${id(tableId)}/records/${id(recordId)}/buttons/${id(fieldId)}/click`,
      buttonClickResponseSchema,
      { method: 'POST', idempotencyKey, retryOnRateLimit: false },
    ),
};
