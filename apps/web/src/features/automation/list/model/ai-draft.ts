import type {
  AiAutomationDraft,
  AiAutomationWarning,
  AutomationDefinition,
  McpAutomationDraft,
} from '@cellhive/contracts';

/**
 * (T913) What "Create with AI" hands to `/b/:baseId/automations/new`: the
 * router state of that navigation — kept in memory with the history entry,
 * never in `localStorage` (a definition may hold values, FRONTEND §12).
 */
export interface AiDraftState {
  readonly aiDraft: AiAutomationDraft;
}

/**
 * A draft the builder opens unsaved and off (FRONTEND §13.2): from "Create
 * with AI" (T913, router state) or from an MCP client (T1015, `?draft=`,
 * read from the server — never a definition in the URL).
 */
export interface BuilderDraft {
  readonly source: 'ai' | 'mcp';
  readonly name: string;
  /** The sentence of "Create with AI", saved as the description; `null` for an MCP draft. */
  readonly description: string | null;
  readonly definition: AutomationDefinition;
  readonly explanation: string;
  readonly warnings: readonly AiAutomationWarning[];
}

/** The draft of a navigation from "Create with AI", or `null` (an ordinary new automation). */
export function aiDraftOf(state: unknown): BuilderDraft | null {
  if (typeof state !== 'object' || state === null || !('aiDraft' in state)) return null;
  const { aiDraft } = state as AiDraftState;
  return { source: 'ai', ...aiDraft };
}

/** The id of an MCP draft: `mdr_` + 16 base62 characters (CONTRACTS §1.2). */
const MCP_DRAFT_ID = /^mdr_[0-9A-Za-z]{16}$/u;

/** (T1015) The MCP draft `?draft=mdr_…` names, or `null`. */
export function mcpDraftIdOf(search: URLSearchParams): string | null {
  const id = search.get('draft');
  return id !== null && MCP_DRAFT_ID.test(id) ? id : null;
}

/** (T1015) A draft of `GET /bases/:baseId/automation-drafts/:draftId` for the builder. */
export function builderDraftOfMcp(draft: McpAutomationDraft): BuilderDraft {
  return {
    source: 'mcp',
    name: draft.name,
    description: null,
    definition: draft.definition,
    explanation: draft.explanation,
    warnings: draft.warnings,
  };
}

/**
 * (T1015) A `literal_chat_id` warning with what the banner names: the
 * position of its `send_telegram` step and the chat written in it.
 */
export function literalChatOf(
  definition: AutomationDefinition,
  warning: AiAutomationWarning,
): { readonly step: number; readonly chat: string } | null {
  if (warning.code !== 'literal_chat_id') return null;
  const index = definition.actions.findIndex((action) => action.id === warning.action_id);
  const action = definition.actions[index];
  if (action?.type !== 'send_telegram' || !('literal' in action.config.chat_id)) return null;
  return { step: index + 1, chat: String(action.config.chat_id.literal) };
}
