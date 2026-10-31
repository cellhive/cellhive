import { useQuery } from '@tanstack/react-query';

import { orgQuery } from '../query/queries';

import type { OrganizationAi } from '@cellhive/contracts';

/** While `GET /orgs/:id` loads, fails, or for no organization: no AI. */
const NO_AI: OrganizationAi = { available: false, record_data: false };

/**
 * Whether an AI entry point may render (FRONTEND §15.8, research §5.1):
 * `ai` of `GET /orgs/:id` (CONTRACTS §29.1), for every member. `available`
 * — AI is on with a provider and a model: render the entry, never hide it
 * with CSS; `record_data` — AI may see record values (AI fields, AI steps):
 * otherwise those entries render disabled with the reason. Unknown yet
 * counts as unavailable, so nothing flashes in and out.
 */
export function useAiAvailability(orgId: string | undefined): OrganizationAi {
  const known = orgId !== undefined && orgId !== '';
  const { data } = useQuery({ ...orgQuery(orgId ?? ''), enabled: known });
  return (known ? data?.ai : undefined) ?? NO_AI;
}
