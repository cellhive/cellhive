import { automationValueSchema, type AutomationValue } from '@cellhive/contracts';
import { joinPath } from '@cellhive/filter-dsl';

/**
 * Values of SPEC §11.4 inside the filter of `update_records` (BACKLOG
 * T506): a condition of the Filter DSL (`{ field, operator, value }`) may
 * take as its whole `value` a value of an action config — `{ "field" }`,
 * `{ "step", "path" }`, `{ "trigger" }`, `{ "template" }`, `{ "literal" }`,
 * `{ "digest" }` — resolved when the step runs. Only the DSL form (groups
 * and conditions with ids) carries them; a tuple filter (CONTRACTS §3) has
 * none. No such object is a valid DSL operand, so there is no ambiguity.
 */

/** One value of a filter: where it is (relative to the filter) and what it is. */
export interface FilterValueSlot {
  /** Path segments from the filter root to the condition's `value`. */
  readonly segments: readonly (string | number)[];
  /** The same path as filter issues print it (`items[0].value`). */
  readonly path: string;
  readonly value: AutomationValue;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The values of SPEC §11.4 a DSL filter holds, depth first. */
export function filterValueSlots(filter: unknown): FilterValueSlot[] {
  const slots: FilterValueSlot[] = [];
  const visit = (node: unknown, segments: readonly (string | number)[]): void => {
    if (!isObject(node)) return;
    if ('op' in node) {
      if (node['op'] === 'not') {
        visit(node['item'], [...segments, 'item']);
        return;
      }
      const items = node['items'];
      if (Array.isArray(items)) {
        items.forEach((item: unknown, index) => {
          visit(item, [...segments, 'items', index]);
        });
      }
      return;
    }
    if (!('field' in node) || !('value' in node)) return;
    const parsed = automationValueSchema.safeParse(node['value']);
    if (!parsed.success) return;
    const at = [...segments, 'value'];
    slots.push({ segments: at, path: pathOf(at), value: parsed.data });
  };
  visit(filter, []);
  return slots;
}

function pathOf(segments: readonly (string | number)[]): string {
  return segments.reduce<string>((path, key) => joinPath(path, key), '');
}

/**
 * A copy of `filter` where the value at each slot is `values[i]`
 * (`undefined` removes the key — the probe of the save check).
 */
export function withFilterValues(
  filter: unknown,
  slots: readonly FilterValueSlot[],
  values: readonly unknown[],
): unknown {
  const copy = structuredClone(filter);
  slots.forEach((slot, index) => {
    let node: unknown = copy;
    for (const key of slot.segments.slice(0, -1)) {
      node = (node as Record<string | number, unknown>)[key];
    }
    const holder = node as Record<string, unknown>;
    const value = values[index];
    if (value === undefined) delete holder['value'];
    else holder['value'] = value;
  });
  return copy;
}
