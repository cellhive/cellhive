import { queryOptions } from '@tanstack/react-query';

import { rolesApi } from '../api/roles';

import { keys } from './keys';

/** Roles of a base (base admins); apart from `queries.ts`, whose module is part of the app shell (T700). */
export const rolesQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.roles(baseId),
    queryFn: ({ signal }) => rolesApi.list(baseId, signal),
  });
