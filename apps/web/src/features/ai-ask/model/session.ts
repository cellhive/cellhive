import type { AiAnswer } from '../../../lib/ai/ask';

/** What one question got. */
export type AskOutcome =
  | { readonly kind: 'answer'; readonly answer: AiAnswer }
  | { readonly kind: 'unanswerable' }
  | { readonly kind: 'error'; readonly error: unknown };

export interface AskEntry {
  readonly id: number;
  readonly question: string;
  readonly outcome: AskOutcome;
}

interface AskSession {
  readonly entries: readonly AskEntry[];
  readonly draft: string;
}

/** Questions kept per table: the oldest go first. */
export const MAX_ENTRIES = 20;

const EMPTY: AskSession = { entries: [], draft: '' };

/**
 * The questions of this tab's session (T914, research S8 §5.5): kept in
 * memory per user and table — closing and opening the panel again, or
 * another view of the table, shows them — and never stored anywhere else
 * (not the server, not `localStorage`: answers are record data, FRONTEND
 * §12). A reload starts afresh.
 */
const sessions = new Map<string, AskSession>();

export function sessionKey(userId: string | undefined, tableId: string): string {
  return `${userId ?? ''}:${tableId}`;
}

export function readSession(key: string): AskSession {
  return sessions.get(key) ?? EMPTY;
}

export function writeSession(key: string, entries: readonly AskEntry[], draft: string): void {
  sessions.set(key, { entries: entries.slice(-MAX_ENTRIES), draft });
}

let lastId = 0;

/** Ids of entries, unique in the tab. */
export function nextEntryId(): number {
  lastId += 1;
  return lastId;
}

/** Tests only. */
export function clearSessions(): void {
  sessions.clear();
}
