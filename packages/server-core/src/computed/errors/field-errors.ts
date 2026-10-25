import { formulaReferenceIds } from '../definition/display.js';

import type { FieldRow, JsonObject, JsonValue } from '../../db/schema.js';
import type { BaseSchemaRows } from '../definition/schema-rows.js';
import type { GraphEdge } from '../graph/graph.js';

/**
 * Field-level errors of computed fields (SPEC §9.4, BACKLOG T460, S4b
 * additional decision #2), as pure functions over the meta of a base:
 *
 * - `REF`: something the definition names — a field, a table, a link field
 *   walked through or its linked table, the `from`/`select`/`where` of a
 *   lookup — was deleted (trash) or purged; also, **indirectly**, a
 *   computed field it reads is in error (`refs` = those fields). Restoring
 *   the object clears it;
 * - `CIRCLE`: the field is on a reference cycle among active fields (a
 *   restore closed it; saving a definition that closes one stays `422
 *   FORMULA_CYCLE`); `refs` = the fields of the cycle;
 * - `INVALID_CONFIG`: everything it names exists but the definition no
 *   longer typechecks (a type conversion of a field it reads): fixed by
 *   configuring it again;
 * - `TIMEOUT`: set by the jobs (a batch past its statement timeout); kept
 *   until the definition changes, unless one of the above applies.
 *
 * Priority: direct `REF` > `CIRCLE` > `INVALID_CONFIG` > `TIMEOUT` >
 * indirect `REF`.
 */

export const FIELD_ERROR_CODES = ['REF', 'CIRCLE', 'TIMEOUT', 'INVALID_CONFIG'] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/** What an error is about, as stored in `meta.fields.compute_error` (ids only). */
export interface FieldErrorRef {
  readonly kind: 'field' | 'table';
  readonly id: string;
}

/** `meta.fields.compute_error` of a formula/lookup field. */
export interface FieldError {
  readonly code: FieldErrorCode;
  readonly refs: readonly FieldErrorRef[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored `compute_error` read back (`null` when absent or malformed). */
export function fieldErrorOf(value: JsonValue | null | undefined): FieldError | null {
  if (!isRecord(value)) return null;
  const code = value['code'];
  if (typeof code !== 'string' || !(FIELD_ERROR_CODES as readonly string[]).includes(code)) {
    return null;
  }
  const refs = Array.isArray(value['refs'])
    ? (value['refs'] as unknown[]).flatMap((ref): FieldErrorRef[] => {
        if (!isRecord(ref) || typeof ref['id'] !== 'string') return [];
        const kind = ref['kind'] === 'table' ? 'table' : 'field';
        return [{ kind, id: ref['id'] }];
      })
    : [];
  return { code: code as FieldErrorCode, refs };
}

/** The JSON stored for an error. */
export function fieldErrorJson(error: FieldError | null): JsonObject | null {
  if (error === null) return null;
  return { code: error.code, refs: error.refs.map((ref) => ({ kind: ref.kind, id: ref.id })) };
}

/** Whether two errors are the same (code and refs, in order). */
export function sameFieldError(a: FieldError | null, b: FieldError | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.code === b.code &&
    a.refs.length === b.refs.length &&
    a.refs.every((ref, index) => {
      const other = b.refs.at(index);
      return other !== undefined && ref.kind === other.kind && ref.id === other.id;
    })
  );
}

/** Field ids a lookup `where` names (conditions and `field_ref`s; `__id` excluded). */
function whereFieldIds(where: unknown, out: Set<string>): void {
  if (Array.isArray(where)) {
    for (const item of where) whereFieldIds(item, out);
    return;
  }
  if (!isRecord(where)) return;
  for (const [key, value] of Object.entries(where)) {
    if ((key === 'field' || key === 'field_ref') && typeof value === 'string') {
      if (value !== '__id') out.add(value);
    } else {
      whereFieldIds(value, out);
    }
  }
}

/** Field and table ids the stored definition of a computed field names. */
export function definitionReferenceIds(field: Pick<FieldRow, 'type' | 'options'>): {
  readonly fields: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
} {
  const options = isRecord(field.options) ? field.options : {};
  const fields = new Set<string>();
  const tables = new Set<string>();
  if (field.type === 'formula') {
    const expression = options['expression'];
    const refs = typeof expression === 'string' ? formulaReferenceIds(expression) : null;
    refs?.fields.forEach((id) => fields.add(id));
    refs?.tables.forEach((id) => tables.add(id));
  } else if (field.type === 'lookup') {
    if (typeof options['from'] === 'string') tables.add(options['from']);
    if (typeof options['select'] === 'string') fields.add(options['select']);
    whereFieldIds(options['where'], fields);
  }
  return { fields, tables };
}

const isComputed = (field: Pick<FieldRow, 'type'>) =>
  field.type === 'formula' || field.type === 'lookup';

export interface FieldErrorsInput {
  /** Active tables and their active fields (`loadBaseSchemaRows`). */
  readonly rows: BaseSchemaRows;
  /** Every edge of the base's dependency graph (deleted fields' included). */
  readonly edges: readonly GraphEdge[];
  /**
   * The table of a field that is not in `rows` (in the trash, purged, or of
   * a table outside `rows`); `undefined` when unknown.
   */
  readonly tableOfField: (fieldId: string) => string | undefined;
  /** Whether the saved definition of an active computed field still analyses. */
  readonly analyses: (field: FieldRow) => boolean;
  /**
   * Fields that just changed (a conversion, a new definition): an
   * `INVALID_CONFIG` names those of them the definition reads.
   */
  readonly causes?: ReadonlySet<string>;
}

function linkTableOf(field: FieldRow): string | null {
  if (field.type === 'parent') return field.table_id;
  if (field.type !== 'link' || !isRecord(field.options)) return null;
  const target = field.options['link_table'];
  return typeof target === 'string' ? target : null;
}

function addRef(refs: FieldErrorRef[], ref: FieldErrorRef): void {
  if (!refs.some((item) => item.kind === ref.kind && item.id === ref.id)) refs.push(ref);
}

/** Strongly connected components (Tarjan), for the fields on a cycle. */
function cyclicComponents(
  nodes: readonly string[],
  out: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let index = 0;
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indexOf.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of out.get(node) ?? []) {
      if (!indexOf.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, indexOf.get(next) ?? 0));
      }
    }
    if (low.get(node) === indexOf.get(node)) {
      const component: string[] = [];
      for (;;) {
        const top = stack.pop() as string;
        onStack.delete(top);
        component.push(top);
        if (top === node) break;
      }
      const selfLoop = component.length === 1 && (out.get(node) ?? []).includes(node);
      if (component.length > 1 || selfLoop) components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indexOf.has(node)) visit(node);
  return components;
}

/**
 * The error each active formula/lookup field of the base should have now
 * (`null`: none), by field id. Deterministic: refs in a stable order.
 */
export function desiredFieldErrors(input: FieldErrorsInput): Map<string, FieldError | null> {
  const { rows, edges } = input;
  const activeTables = new Set<string>(rows.tables.map((table) => table.id));
  const activeFields = new Map<string, FieldRow>(
    rows.fields
      .filter((field) => field.deleted_at === null && activeTables.has(field.table_id))
      .map((field) => [field.id, field]),
  );
  const computed = [...activeFields.values()]
    .filter(isComputed)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const reads = new Map<string, string[]>();
  for (const edge of edges) {
    const list = reads.get(edge.fieldId) ?? [];
    list.push(edge.dependsOnFieldId);
    reads.set(edge.fieldId, list);
  }

  const result = new Map<string, FieldError | null>();

  // 1. Direct REF: a named field/table (or the table of a link walked
  //    through) is not active.
  for (const field of computed) {
    const named = definitionReferenceIds(field);
    const fieldIds = [...new Set([...named.fields, ...(reads.get(field.id) ?? [])])].sort();
    const refs: FieldErrorRef[] = [];
    for (const id of fieldIds) {
      const active = activeFields.get(id);
      if (active === undefined) {
        const tableId = input.tableOfField(id);
        if (tableId !== undefined && !activeTables.has(tableId)) {
          addRef(refs, { kind: 'table', id: tableId });
        } else {
          addRef(refs, { kind: 'field', id });
        }
        continue;
      }
      const target = linkTableOf(active);
      if (target !== null && !activeTables.has(target)) addRef(refs, { kind: 'table', id: target });
    }
    for (const id of [...named.tables].sort()) {
      if (!activeTables.has(id)) addRef(refs, { kind: 'table', id });
    }
    if (refs.length > 0) result.set(field.id, { code: 'REF', refs });
  }

  // 2. CIRCLE: cycles among the other active computed fields.
  const candidates: string[] = computed
    .filter((field) => !result.has(field.id))
    .map((field) => field.id);
  const candidateSet = new Set<string>(candidates);
  const out = new Map<string, string[]>();
  for (const id of candidates) {
    out.set(id, [...new Set(reads.get(id) ?? [])].filter((next) => candidateSet.has(next)).sort());
  }
  for (const component of cyclicComponents(candidates, out)) {
    for (const id of component) {
      result.set(id, {
        code: 'CIRCLE',
        refs: component.map((member) => ({ kind: 'field', id: member })),
      });
    }
  }

  // 3. INVALID_CONFIG: everything exists, the definition no longer analyses.
  for (const field of computed) {
    if (result.has(field.id) || input.analyses(field)) continue;
    const named = definitionReferenceIds(field);
    const causes = [...(input.causes ?? [])]
      .filter((id) => named.fields.has(id) || (reads.get(field.id) ?? []).includes(id))
      .sort();
    result.set(field.id, {
      code: 'INVALID_CONFIG',
      refs: causes.map((id) => ({ kind: 'field', id })),
    });
  }

  // 4. TIMEOUT (from a job) stays.
  for (const field of computed) {
    if (result.has(field.id)) continue;
    const current = fieldErrorOf(field.compute_error);
    if (current?.code === 'TIMEOUT') result.set(field.id, current);
  }

  // 5. Indirect REF: a computed field it reads is in error (to a fixed point).
  for (let changed = true; changed;) {
    changed = false;
    for (const field of computed) {
      if (result.get(field.id) != null) continue;
      const failing = [...new Set(reads.get(field.id) ?? [])]
        .filter((id) => activeFields.has(id) && result.get(id) != null)
        .sort();
      if (failing.length === 0) continue;
      result.set(field.id, { code: 'REF', refs: failing.map((id) => ({ kind: 'field', id })) });
      changed = true;
    }
  }

  for (const field of computed) if (!result.has(field.id)) result.set(field.id, null);
  return result;
}

/**
 * Formula/lookup fields that are not in error in `before` but are in
 * `after` (the `dependents` of a delete or conversion preview).
 */
export function newlyFailing(
  before: ReadonlyMap<string, FieldError | null>,
  after: ReadonlyMap<string, FieldError | null>,
): string[] {
  return [...after]
    .filter(([id, error]) => error !== null && before.get(id) == null)
    .map(([id]) => id)
    .sort();
}
