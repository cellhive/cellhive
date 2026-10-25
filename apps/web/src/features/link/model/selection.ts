import type { LinkRef } from '../../../lib/links/values';

/**
 * What the link picker has chosen (T413, BACKLOG S4 design decision #1),
 * saved once with "Save": the linked records in cell order, at most
 * `limit` (500, or 1 when the field allows one record). Records the user
 * cannot read (`title = null`, P20) stay in the list — the server keeps
 * existing links it is sent back (CONTRACTS §2). Pure functions.
 */
export interface PickerSelection {
  readonly refs: readonly LinkRef[];
  readonly limit: number;
}

export interface SelectionChange {
  readonly selection: PickerSelection;
  /** The change would have gone over the limit: nothing (or only part) was added. */
  readonly blocked: boolean;
}

export function selectionOf(refs: readonly LinkRef[], limit: number): PickerSelection {
  // An over-full cell (ADR-28: limit lowered later) keeps its links; only adding is blocked.
  const seen = new Set<string>();
  return {
    refs: refs.filter((ref) => (seen.has(ref.id) ? false : (seen.add(ref.id), true))),
    limit,
  };
}

export function isSelected(selection: PickerSelection, id: string): boolean {
  return selection.refs.some((ref) => ref.id === id);
}

export function isFull(selection: PickerSelection): boolean {
  return selection.refs.length >= selection.limit;
}

/** Adds a record, or removes it when it is chosen already; adding past the limit is blocked. */
export function toggle(selection: PickerSelection, ref: LinkRef): SelectionChange {
  if (isSelected(selection, ref.id)) {
    return {
      selection: { ...selection, refs: selection.refs.filter((item) => item.id !== ref.id) },
      blocked: false,
    };
  }
  if (isFull(selection)) return { selection, blocked: true };
  return { selection: { ...selection, refs: [...selection.refs, ref] }, blocked: false };
}

/** One record replaces the choice (single-link fields). */
export function choose(selection: PickerSelection, ref: LinkRef): PickerSelection {
  return { ...selection, refs: [ref] };
}

export function remove(selection: PickerSelection, id: string): PickerSelection {
  return { ...selection, refs: selection.refs.filter((ref) => ref.id !== id) };
}

export function clear(selection: PickerSelection): PickerSelection {
  return { ...selection, refs: [] };
}

/**
 * "Select all" of the current search or filter only (decision #1): every
 * record of `refs` not chosen yet is added; when they do not all fit in the
 * limit nothing is added and the change is `blocked` (a partial selection
 * would depend on what happens to be loaded).
 */
export function selectAll(selection: PickerSelection, refs: readonly LinkRef[]): SelectionChange {
  const missing = refs.filter((ref) => !isSelected(selection, ref.id));
  if (missing.length === 0) return { selection, blocked: false };
  if (selection.refs.length + missing.length > selection.limit) return { selection, blocked: true };
  return { selection: { ...selection, refs: [...selection.refs, ...missing] }, blocked: false };
}

/** Whether every record of `refs` is chosen (the "select all" box is checked). */
export function allSelected(selection: PickerSelection, refs: readonly LinkRef[]): boolean {
  return refs.length > 0 && refs.every((ref) => isSelected(selection, ref.id));
}

/** Removes the records of `refs` (unchecking "select all"). */
export function removeAll(selection: PickerSelection, refs: readonly LinkRef[]): PickerSelection {
  const drop = new Set(refs.map((ref) => ref.id));
  return { ...selection, refs: selection.refs.filter((ref) => !drop.has(ref.id)) };
}

/** Moves the record at `from` to `to` (drag and drop, or the keyboard). */
export function move(selection: PickerSelection, from: number, to: number): PickerSelection {
  if (from === to || from < 0 || to < 0) return selection;
  if (from >= selection.refs.length || to >= selection.refs.length) return selection;
  const refs = [...selection.refs];
  const [item] = refs.splice(from, 1);
  if (item === undefined) return selection;
  refs.splice(to, 0, item);
  return { ...selection, refs };
}

/** Whether the choice differs from the cell (same records in the same order = nothing to save). */
export function changed(selection: PickerSelection, initial: readonly LinkRef[]): boolean {
  return (
    selection.refs.length !== initial.length ||
    selection.refs.some((ref, index) => ref.id !== initial[index]?.id)
  );
}

/** Records chosen in the picker that were not in the cell (they go to "Recent"). */
export function added(selection: PickerSelection, initial: readonly LinkRef[]): string[] {
  const before = new Set(initial.map((ref) => ref.id));
  return selection.refs.filter((ref) => !before.has(ref.id)).map((ref) => ref.id);
}
