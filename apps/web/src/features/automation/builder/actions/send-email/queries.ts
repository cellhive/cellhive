import { queryOptions } from '@tanstack/react-query';

import { api } from '../../../../../lib/api';
import { automationsApi } from '../../../../../lib/api/automations';
import { keys } from '../../../../../lib/query/keys';

/** Verified identities a `send_email` of the base may send as (CONTRACTS §23.3). */
export const baseEmailIdentitiesQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.baseEmailIdentities(baseId),
    queryFn: ({ signal }) => automationsApi.emailIdentities(baseId, signal),
    staleTime: 60_000,
  });

/**
 * Email settings of the organization (CONTRACTS §23.2), read only by its
 * owners/admins: others see the editor without them (the server still
 * checks the sender, the footer and the limits on save, preview and test).
 */
export const builderEmailSettingsQuery = (orgId: string, enabled: boolean) =>
  queryOptions({
    queryKey: keys.orgEmailSettings(orgId),
    queryFn: ({ signal }) => api.orgs.emailSettings(orgId, signal),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
