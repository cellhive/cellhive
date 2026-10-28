import {
  meResponseSchema,
  type ChangePasswordRequestInput,
  type UpdateMeRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from '../../../lib/api/client';

/**
 * The caller's profile and password (CONTRACTS §12.0, T831); session only.
 * Only the account page calls these, so they stay out of `lib/api` and the
 * app shell (FRONTEND §11.1).
 */
export const profileApi = {
  update: (body: UpdateMeRequest) =>
    apiRequest('/me', import.meta.env.DEV ? meResponseSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
    }),
  changePassword: (body: ChangePasswordRequestInput) =>
    apiRequestVoid('/me/password', { method: 'POST', body }),
};
