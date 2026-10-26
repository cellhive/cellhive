import { baseDetailSchema, type UpdateBaseRequest } from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

const id = encodeURIComponent;
const schema = import.meta.env.DEV ? baseDetailSchema : UNCHECKED_SCHEMA;

/**
 * Changing, deleting and restoring a base (CONTRACTS §5A). Only the base
 * settings call these, so they stay out of `api` and the app shell
 * (FRONTEND §11.1). `PATCH` name/description: base admins; delete and
 * restore: the base owner, a workspace admin or an organization owner/admin.
 */
export const baseAdminApi = {
  update: (baseId: string, body: UpdateBaseRequest) =>
    apiRequest(`/bases/${id(baseId)}`, schema, { method: 'PATCH', body }),
  /** To the trash: nobody can open it until it is restored. */
  remove: (baseId: string) => apiRequestVoid(`/bases/${id(baseId)}`, { method: 'DELETE' }),
  restore: (baseId: string) =>
    apiRequest(`/bases/${id(baseId)}/restore`, schema, { method: 'POST' }),
};
