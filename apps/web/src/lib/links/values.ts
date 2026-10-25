import { isId } from '@cellhive/contracts';

/**
 * Values of `link` cells (CONTRACTS §2, T413) as the client handles them:
 * reads are `[{ id, title }]` in link order (`title = null` when the user
 * cannot read the record, P20), writes are the full new list of ids.
 * Pure functions shared by the grid, the record panel, realtime and the
 * link picker.
 */

/** A linked record as reads return it. */
export interface LinkRef {
  readonly id: string;
  /** Title of the record (its primary field as text); `null` when unreadable (P20). */
  readonly title: string | null;
}

/**
 * The linked records of a json link value, ignoring anything else. Through a
 * share link a record the link cannot read comes without its id (`{ id:
 * null, title: null }`, CONTRACTS §16A, T409): kept as a locked chip with
 * an empty id (never written back: share pages are read-only).
 */
export function linkRefsOf(value: unknown): LinkRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const { id, title } = entry as { id?: unknown; title?: unknown };
    if (id === null && title === null) return [{ id: '', title: null }];
    if (typeof id !== 'string') return [];
    return [{ id, title: typeof title === 'string' ? title : null }];
  });
}

/**
 * Whether the linked table of a link field is in the trash (CONTRACTS §13,
 * T401 flag): its cells read empty and take no new links, so the UI offers
 * no picker nor "Add" until the table is restored (T421a).
 */
export function linkTargetDeleted(field: { readonly link_target_deleted?: boolean | undefined }) {
  return field.link_target_deleted === true;
}

/** `cell_format=text` of a link cell: readable titles separated by commas (never an id). */
export function linkText(refs: readonly LinkRef[]): string {
  return refs.flatMap((ref) => (ref.title === null ? [] : [ref.title])).join(', ');
}

/** The json write value of linked records: ids in order, `null` for none (CONTRACTS §2). */
export function linkWriteValue(refs: readonly LinkRef[]): string[] | null {
  return refs.length === 0 ? null : refs.map((ref) => ref.id);
}

/** The read value shown optimistically for linked records: `null` for none. */
export function linkDisplayValue(refs: readonly LinkRef[]): LinkRef[] | null {
  return refs.length === 0 ? null : refs.map((ref) => ({ id: ref.id, title: ref.title }));
}

/**
 * Pasted text of a link cell (FRONTEND §6.3, T413): titles separated by
 * commas ("An Phát, Bình Minh" → two links), or record ids; the server
 * reads each one with `typecast` (a string is one title, CONTRACTS §2).
 * Empty parts are dropped; `null` when nothing is left.
 */
export function pastedLinkValue(text: string): string[] | null {
  const parts = text
    .split(/[,\n]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length === 0 ? null : [...new Set(parts)];
}

/** Whether a value is the json read shape of a link cell (an array of `{ id: rec_…, title }`). */
export function isLinkValue(value: unknown): value is LinkRef[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        'title' in entry &&
        isId('rec', (entry as { id?: unknown }).id),
    )
  );
}

/**
 * A realtime patch of a link cell may carry `title: null` for records the
 * user does read: the server keeps titles only for subscribers who read
 * every record of the linked table (CONTRACTS §7). The titles the cell
 * already showed for the same records are kept; returns the merged value
 * and whether some record still has no known title (to fetch it again).
 */
export function keepKnownTitles(
  before: unknown,
  after: unknown,
): { readonly value: unknown; readonly unknownTitles: boolean } {
  if (!isLinkValue(after)) return { value: after, unknownTitles: false };
  const known = new Map<string, string>();
  for (const ref of linkRefsOf(before)) if (ref.title !== null) known.set(ref.id, ref.title);
  const previous = new Set(linkRefsOf(before).map((ref) => ref.id));
  let changed = false;
  let unknownTitles = false;
  const value: LinkRef[] = [];
  for (const ref of after) {
    const title = ref.title ?? known.get(ref.id);
    if (ref.title === null && title !== undefined) {
      changed = true;
      value.push({ id: ref.id, title });
      continue;
    }
    // A record new to the cell: unreadable, or a title withheld from this user.
    if (ref.title === null && !previous.has(ref.id)) unknownTitles = true;
    value.push(ref);
  }
  return { value: changed ? value : after, unknownTitles };
}
