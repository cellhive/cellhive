import { jobSchema } from '@cellhive/contracts';

import { apiRequest, UNCHECKED_SCHEMA } from './client';

/**
 * Background jobs (CONTRACTS §12.2): the creator or an org owner/admin,
 * others `404`. Progress also arrives as `job.progress` on `user:{id}`.
 */
export const jobsApi = {
  get: (jobId: string, signal?: AbortSignal) =>
    apiRequest(
      `/jobs/${encodeURIComponent(jobId)}`,
      import.meta.env.DEV ? jobSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
};
