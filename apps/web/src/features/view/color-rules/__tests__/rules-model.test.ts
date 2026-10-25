import { MAX_COLOR_RULES, type FieldDto } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildRules,
  canAddRule,
  editorRulesOf,
  mergeEditorRules,
  moveRule,
  newRule,
  nextColor,
  type EditorRule,
} from '../rules-model';

import type { ViewColorRule } from '../../../../lib/views/config';

const STATUS = 'fld_Status0000000001';
const TABLE = 'tbl_Orders0000000001';
const NOW = '2026-10-25T00:00:00.000Z';

const status = {
  id: STATUS,
  table_id: TABLE,
  name: 'Status',
  type: 'text',
  options: {},
  description: null,
  is_primary: true,
  required: false,
  unique_values: false,
  position: 0,
  created_at: NOW,
  updated_at: NOW,
} as unknown as FieldDto;

const SAVED_FILTER = { and: [{ field: STATUS, op: 'eq', value: 'Late' }] };

function saved(overrides: Partial<ViewColorRule> = {}): ViewColorRule {
  return {
    id: 'clr_Saved00000000001',
    enabled: true,
    filter: SAVED_FILTER,
    color: 'red',
    target: 'row',
    field_id: null,
    ...overrides,
  };
}

/** A new rule whose condition is `Status = value` (or incomplete without a value). */
function withCondition(rules: readonly EditorRule[], value?: string): EditorRule {
  const rule = newRule(rules);
  const condition = {
    kind: 'condition' as const,
    id: 'c1',
    field: STATUS,
    operator: 'contains' as const,
    ...(value === undefined ? {} : { value }),
  };
  return { ...rule, root: { ...rule.root, items: [condition] } };
}

describe('editorRulesOf', () => {
  it('keeps the saved filter to send back unedited and marks broken rules', () => {
    const [rule] = editorRulesOf([saved({ broken: true, target: 'cell' })]);
    expect(rule).toMatchObject({
      saved: SAVED_FILTER,
      edited: false,
      broken: true,
      target: 'cell',
      fieldId: null,
    });
  });

  it('reads no rules as an empty list', () => {
    expect(editorRulesOf(undefined)).toEqual([]);
  });
});

describe('newRule / nextColor / canAddRule', () => {
  it('appends an enabled row rule with an unused color and a clr_ id', () => {
    const rules = editorRulesOf([saved()]);
    const rule = newRule(rules);
    expect(rule).toMatchObject({ enabled: true, target: 'row', color: 'orange', edited: true });
    expect(rule.id).toMatch(/^clr_/u);
  });

  it('falls back to red once every color is used', () => {
    let rules: EditorRule[] = [];
    for (let index = 0; index < 10; index += 1) rules = [...rules, newRule(rules)];
    expect(new Set(rules.map((rule) => rule.color)).size).toBe(10);
    expect(nextColor(rules)).toBe('red');
  });

  it('stops at the maximum', () => {
    const rules = Array.from({ length: MAX_COLOR_RULES }, () => newRule([]));
    expect(canAddRule(rules)).toBe(false);
    expect(canAddRule(rules.slice(1))).toBe(true);
  });
});

describe('moveRule', () => {
  const rules = ['a', 'b', 'c'].map((id) => ({ ...newRule([]), id }));
  it.each([
    [0, 2, ['b', 'c', 'a']],
    [2, 0, ['c', 'a', 'b']],
    [1, 5, ['a', 'c', 'b']],
    [1, -1, ['b', 'a', 'c']],
    [7, 0, ['a', 'b', 'c']],
  ])('moves %i to %i', (from, to, order) => {
    expect(moveRule(rules, from, to).map((rule) => rule.id)).toEqual(order);
  });
});

describe('buildRules', () => {
  it('sends an unedited rule as the server returned it', () => {
    const rules = editorRulesOf([saved({ enabled: false })]);
    expect(buildRules(rules, [status]).rules).toEqual([
      {
        id: 'clr_Saved00000000001',
        enabled: false,
        filter: SAVED_FILTER,
        color: 'red',
        target: 'row',
        field_id: null,
      },
    ]);
  });

  it('sends a broken cell rule back unchanged (field_id null)', () => {
    const rules = editorRulesOf([saved({ broken: true, target: 'cell' })]);
    expect(buildRules(rules, [status]).rules).toEqual([
      expect.objectContaining({ target: 'cell', field_id: null, filter: SAVED_FILTER }),
    ]);
  });

  it('sends an edited rule with its built filter', () => {
    const rule = withCondition([], 'Late');
    const built = buildRules([rule], [status]);
    expect(built.rules).toHaveLength(1);
    expect(built.rules?.[0]?.filter).toEqual({
      op: 'and',
      items: [{ field: STATUS, operator: 'contains', value: 'Late' }],
    });
    expect(built.rules?.[0]).toMatchObject({ id: rule.id, target: 'row', field_id: null });
    expect(built.checks.get(rule.id)).toMatchObject({ incomplete: false, missingField: false });
  });

  it.each([
    ['a new rule without a condition', (rules: EditorRule[]) => newRule(rules), 'incomplete'],
    ['a condition without a value', (rules: EditorRule[]) => withCondition(rules), 'incomplete'],
    [
      'a cell rule without its field',
      (rules: EditorRule[]) => ({ ...withCondition(rules, 'Late'), target: 'cell' as const }),
      'missingField',
    ],
  ] as const)('holds the whole list back for %s', (_name, make, issue) => {
    const rules = editorRulesOf([saved()]);
    const rule = make(rules);
    const built = buildRules([...rules, rule], [status]);
    expect(built.rules).toBeNull();
    expect(built.checks.get(rule.id)?.[issue]).toBe(true);
  });

  it('keeps the field of a cell rule only', () => {
    const rule = { ...withCondition([], 'Late'), target: 'cell' as const, fieldId: STATUS };
    expect(buildRules([rule], [status]).rules?.[0]?.field_id).toBe(STATUS);
    expect(buildRules([{ ...rule, target: 'row' }], [status]).rules?.[0]?.field_id).toBeNull();
  });
});

describe('mergeEditorRules', () => {
  const late = (value: string) => ({
    op: 'and',
    items: [{ field: STATUS, operator: 'contains', value }],
  });

  it("keeps the condition tree of a rule whose filter is the same (the save's echo)", () => {
    const mine = withCondition([], 'Late');
    const incoming = [saved({ id: mine.id, filter: late('Late') })];
    const [merged] = mergeEditorRules([mine], incoming, [status]);
    expect(merged?.root).toBe(mine.root);
    expect(merged).toMatchObject({ edited: false, saved: late('Late') });
  });

  it('rebuilds a rule whose filter changed elsewhere', () => {
    const mine = withCondition([], 'Late');
    const incoming = [saved({ id: mine.id, filter: late('Early') })];
    const merged = mergeEditorRules([mine], incoming, [status]);
    expect(merged[0]?.root).not.toBe(mine.root);
    expect(buildRules(merged, [status]).rules?.[0]?.filter).toEqual(late('Early'));
  });
});
