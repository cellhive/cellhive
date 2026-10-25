/**
 * Views deleted from this tab: when the open view leaves the list because
 * of that, the page moves on silently (the delete dialog already said so);
 * a view deleted elsewhere gets the "no longer available" notice.
 */
const deletedHere = new Set<string>();

export function markDeletedHere(viewId: string): void {
  deletedHere.add(viewId);
}

/** Whether this tab deleted `viewId` (consumed). */
export function takeDeletedHere(viewId: string): boolean {
  return deletedHere.delete(viewId);
}
