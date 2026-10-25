/**
 * (T525, Câu hỏi mở S5 #5) Fields of a button's `enabled_when` that some
 * people allowed to click cannot read: with `min_permission = read` they
 * can still infer the condition from the button's state, so the builder
 * warns. Pure.
 */

const FIELD_ID = /^fld_[A-Za-z0-9_-]+$/u;

/** Field ids a filter (DSL or tuple form) names, in order, without repeats. */
export function filterFieldIds(filter: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      if (FIELD_ID.test(node) && !found.includes(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object' && node !== null) Object.values(node).forEach(walk);
  };
  walk(filter);
  return found;
}

/** A base role as `GET /bases/:id/roles` gives it (only what this check reads). */
export interface RoleLike {
  readonly name: string;
  readonly kind: string;
  readonly config: Readonly<Record<string, unknown>>;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Field permission of a field rule (SPEC §14.1): an override, else the mode's default. */
function fieldPermOf(fieldRule: Readonly<Record<string, unknown>> | undefined, fieldId: string) {
  const own = objectOf(fieldRule?.['fields'])?.[fieldId];
  if (typeof own === 'string') return own;
  const mode = fieldRule?.['mode'] ?? 'all_edit';
  if (mode === 'all_edit') return 'edit';
  if (mode === 'all_read') return 'read';
  return 'no_perm';
}

/**
 * (Câu hỏi mở S5 #5) Fields of `fieldIds` that a role able to read the
 * table cannot read: a `read` button lets its people infer whether
 * `enabled_when` holds on them. System roles read every field (their presets
 * are `all_edit`/`all_read`); a custom role without the table cannot read
 * the record at all. Returns field id → role names.
 */
export function fieldsHiddenFromReaders(
  roles: readonly RoleLike[],
  tableId: string,
  fieldIds: readonly string[],
): Map<string, string[]> {
  const hidden = new Map<string, string[]>();
  for (const role of roles) {
    if (role.kind !== 'custom') continue;
    const rule = objectOf(objectOf(role.config['tables'])?.[tableId]);
    if (rule === undefined || rule['perm'] === 'no_perm' || rule['perm'] === undefined) continue;
    const fieldRule = objectOf(rule['field_rule']);
    for (const fieldId of fieldIds) {
      if (fieldPermOf(fieldRule, fieldId) !== 'no_perm') continue;
      hidden.set(fieldId, [...(hidden.get(fieldId) ?? []), role.name]);
    }
  }
  return hidden;
}
