import type { AiAutomationDraft } from '@cellhive/contracts';

/**
 * (T913) What "Create with AI" hands to `/b/:baseId/automations/new`: the
 * router state of that navigation — kept in memory with the history entry,
 * never in `localStorage` (a definition may hold values, FRONTEND §12).
 */
export interface AiDraftState {
  readonly aiDraft: AiAutomationDraft;
}

/** The draft of a navigation from "Create with AI", or `null` (an ordinary new automation). */
export function aiDraftOf(state: unknown): AiAutomationDraft | null {
  return typeof state === 'object' && state !== null && 'aiDraft' in state
    ? (state as AiDraftState).aiDraft
    : null;
}
