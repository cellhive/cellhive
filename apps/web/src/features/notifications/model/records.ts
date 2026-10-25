/** One record of a bulk `record.assigned` as the panel lists it. */
export interface AssignedRecordRow {
  readonly id: string;
  /** Primary field as text, `null` when empty or not readable ("(untitled record)"). */
  readonly title: string | null;
}

/**
 * Rows of the records list of a bulk `record.assigned` (T552): in the
 * order of the notification's `record_ids` (the order they were written),
 * only the records the viewer reads now (`records/query` leaves the others
 * out), titled by the primary field read as text.
 */
export function assignedRecordRows(
  ids: readonly string[],
  records: readonly { readonly id: string; readonly fields: Readonly<Record<string, unknown>> }[],
  primaryFieldId: string | null,
): AssignedRecordRow[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    if (record === undefined) return [];
    const value = primaryFieldId === null ? undefined : record.fields[primaryFieldId];
    return [{ id, title: typeof value === 'string' && value.trim() !== '' ? value : null }];
  });
}
