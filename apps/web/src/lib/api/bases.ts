import { baseDetailSchema } from '@cellhive/contracts';

import { apiRequest, UNCHECKED_SCHEMA } from './client';

/**
 * A base with `permission_version` and the caller's effective access
 * (CONTRACTS §5A), read by every table screen (grid, trash) and the app
 * shell; grid block keys carry `permission_version` (FRONTEND §3.2).
 */
export const basesApi = {
  get: (baseId: string, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${encodeURIComponent(baseId)}`,
      import.meta.env.DEV ? baseDetailSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
};
