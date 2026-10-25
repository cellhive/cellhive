import type { EventDocument } from '../../../events/event.js';
import type {
  FilterNode,
  FilterValue,
  FoldedTransition,
  TransitionImages,
} from '@cellhive/filter-dsl';

/**
 * Record events a `record.matches` trigger looks at (BACKLOG T510, SPEC
 * §11.2): a new record, a change (computed values recomputed by T509
 * included) and a record restored from the trash (as if it were new).
 */
export const MATCHES_EVENT_TYPES: ReadonlySet<string> = new Set([
  'record.created',
  'record.updated',
  'record.restored',
]);

/**
 * The fields a stored condition names, walked structurally (it is stored
 * as validated DSL with ids; anything else names no field).
 */
export function conditionFieldIdsOf(condition: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 10 || typeof node !== 'object' || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    if (typeof record['field'] === 'string') {
      out.add(record['field']);
      return;
    }
    if (record['op'] === 'not') {
      visit(record['item'], depth + 1);
      return;
    }
    if (Array.isArray(record['items'])) {
      for (const item of record['items']) visit(item, depth + 1);
    }
  };
  visit(condition, 0);
  return out;
}

/**
 * The before/after images of a record event, from its storage-form
 * `changes` (CONTRACTS §8) and nothing else: `record.created` and
 * `record.restored` had no record before (`before = null`; a restored
 * record carries no `changes`, so every condition reads the current
 * record); `record.updated` has `from`/`to` of each changed field. Fields
 * outside `changes` kept their value (the caller reads the current one for
 * both sides). `null` for other events.
 */
export function transitionImagesOf(
  event: Pick<EventDocument, 'type' | 'changes'>,
): TransitionImages | null {
  if (!MATCHES_EVENT_TYPES.has(event.type)) return null;
  const changes = event.changes ?? {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [fieldId, change] of Object.entries(changes)) {
    before[fieldId] = change.from;
    after[fieldId] = change.to;
  }
  return {
    before: event.type === 'record.updated' ? before : null,
    after,
    changed: Object.keys(changes),
  };
}

/**
 * The images of an event dispatched after later changes of its record
 * (T527): a field the event did not change but a later event did is pinned
 * to its value as of this event — the `from` of the first later change —
 * on both sides, instead of being read from the current record. Without
 * it, a record created and changed into the condition before the creation
 * was dispatched fired twice (on the creation, read as already matching,
 * and on the change). `later` is oldest first.
 */
export function withLaterChanges(
  images: TransitionImages,
  later: readonly Readonly<Record<string, { readonly from?: unknown; readonly to?: unknown }>>[],
): TransitionImages {
  const known = new Set(images.changed);
  const pinned = new Map<string, unknown>();
  for (const changes of later) {
    for (const [fieldId, change] of Object.entries(changes)) {
      if (known.has(fieldId) || pinned.has(fieldId)) continue;
      pinned.set(fieldId, change.from ?? null);
    }
  }
  if (pinned.size === 0) return images;
  const after: Record<string, unknown> = { ...images.after };
  const before: Record<string, unknown> | null =
    images.before === null ? null : { ...images.before };
  for (const [fieldId, value] of pinned) {
    after[fieldId] = value;
    if (before !== null) before[fieldId] = value;
  }
  return { before, after, changed: [...images.changed, ...pinned.keys()] };
}

/**
 * What is left to decide a transition once the changed fields are folded
 * in: either the answer, or the filters to test on the current record as
 * `run_as` — `after` must match (`null`: nothing left, any readable record
 * matches) and `before` must not (`null`: known not to match).
 */
export type TransitionPlan =
  | { readonly kind: 'decided'; readonly outcome: 'not_matching' | 'already_matching' }
  | {
      readonly kind: 'query';
      readonly after: FilterNode | null;
      readonly before: FilterNode | null;
    };

/**
 * `record.matches` fires only when the record goes from not matching to
 * matching (BACKLOG "Quyết định S5" #7): not when it does not match after
 * the change, nor when it already matched before.
 */
export function planTransition(folded: FoldedTransition<FilterValue>): TransitionPlan {
  const { before, after } = folded;
  if (after.kind === 'constant' && !after.value) {
    return { kind: 'decided', outcome: 'not_matching' };
  }
  if (before.kind === 'constant' && before.value) {
    return { kind: 'decided', outcome: 'already_matching' };
  }
  return {
    kind: 'query',
    after: after.kind === 'filter' ? after.filter : null,
    before: before.kind === 'filter' ? before.filter : null,
  };
}
