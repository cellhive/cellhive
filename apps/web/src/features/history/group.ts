import type { RecordHistoryEntry } from '@cellhive/contracts';

/**
 * One item of the history timeline (FRONTEND §10.3): the entries of one
 * request or job (`batch.id`) that follow each other, newest first. A paste
 * of 12 cells into one record is one entry with 12 changes; a request that
 * wrote the same record twice still reads as one item.
 */
export interface HistoryItem {
  /** React key: the id of the newest entry. */
  readonly key: string;
  /** The newest entry: actor, time, source and action of the item. */
  readonly head: RecordHistoryEntry;
  /** Every entry of the item, newest first. */
  readonly entries: readonly RecordHistoryEntry[];
  /** Changes of the item by field key; for a field changed twice, the oldest `from` and newest `to`. */
  readonly changes: readonly HistoryChange[];
}

export interface HistoryChange {
  readonly fieldId: string;
  readonly from: unknown;
  readonly to: unknown;
}

function sameBatch(a: RecordHistoryEntry, b: RecordHistoryEntry): boolean {
  return (
    a.batch !== null &&
    b.batch !== null &&
    a.batch.id === b.batch.id &&
    a.action === b.action &&
    a.actor.type === b.actor.type &&
    a.actor.id === b.actor.id
  );
}

function changesOf(entries: readonly RecordHistoryEntry[]): HistoryChange[] {
  const byField = new Map<string, { from: unknown; to: unknown }>();
  // Oldest first, so the first `from` and the last `to` win.
  for (const entry of [...entries].reverse()) {
    for (const [fieldId, change] of Object.entries(entry.changes)) {
      const known = byField.get(fieldId);
      byField.set(fieldId, { from: known === undefined ? change.from : known.from, to: change.to });
    }
  }
  return [...byField].map(([fieldId, change]) => ({ fieldId, ...change }));
}

/** Timeline items of history entries (already newest first, as the API sends them). */
export function groupHistory(entries: readonly RecordHistoryEntry[]): HistoryItem[] {
  const groups: RecordHistoryEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    const head = last?.[0];
    if (last !== undefined && head !== undefined && sameBatch(head, entry)) last.push(entry);
    else groups.push([entry]);
  }
  return groups.map((group) => {
    const head = group[0] as RecordHistoryEntry;
    return { key: head.id, head, entries: group, changes: changesOf(group) };
  });
}

/**
 * Whether "Restore previous value" is offered for an item (FRONTEND §10.3):
 * an update of one entry (a revert names one `audit_id`) whose every changed
 * field the user may edit. The server decides anyway (`403`, `404`, `409`).
 */
export function canRevert(item: HistoryItem, canEditField: (fieldId: string) => boolean): boolean {
  return (
    item.entries.length === 1 &&
    item.head.action === 'record.updated' &&
    item.changes.length > 0 &&
    item.changes.every((change) => canEditField(change.fieldId))
  );
}

/** Shown changes before an item is expanded. */
export const COLLAPSED_CHANGES = 3;
