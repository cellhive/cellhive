import { queryOptions } from '@tanstack/react-query';

import { keys } from './keys';

/**
 * The automation API with the zod schemas of every trigger and action:
 * loaded on first use, so the sidebar entry of the app shell
 * (`AutomationNavLink`) keeps it out of the initial JS (FRONTEND §11.1).
 */
const loadApi = () => import('../api/automations').then((module) => module.automationsApi);

/**
 * (T520) Automations of the base the caller manages: the list page and the
 * sidebar entry's count read the same entry (one request). A caller who
 * manages none gets `403` (not retried).
 */
export const automationsQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.automations(baseId),
    queryFn: async ({ signal }) => (await loadApi()).list(baseId, signal),
  });

/** (T521) One automation for the builder (CONTRACTS §21). */
export const automationQuery = (baseId: string, automationId: string) =>
  queryOptions({
    queryKey: keys.automation(baseId, automationId),
    queryFn: async ({ signal }) => (await loadApi()).get(automationId, signal),
  });

/**
 * (T1015) A draft of the MCP tool `draft_automation` for its creator's
 * builder (CONTRACTS §30.8): someone else's, expired or unknown → `404`.
 * Read once: the builder keeps its own copy.
 */
export const mcpAutomationDraftQuery = (baseId: string, draftId: string) =>
  queryOptions({
    queryKey: keys.mcpAutomationDraft(baseId, draftId),
    queryFn: async ({ signal }) => (await loadApi()).mcpDraft(baseId, draftId, signal),
    staleTime: Infinity,
  });
