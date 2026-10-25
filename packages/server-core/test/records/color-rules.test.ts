import { MAX_COLOR_RULES, type StoredColorRule } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import { restrictColorRules } from '../../src/records/color-rules/config.js';
import {
  colorOfRow,
  colorRulePlan,
  type ColorRuleReader,
} from '../../src/records/color-rules/evaluate.js';
import {
  buildViewConfig,
  copyViewConfig,
  restrictViewConfig,
  storedViewConfigOf,
  type ViewConfigContext,
  type ViewFieldMeta,
} from '../../src/views/view-config.js';

import type { JsonValue } from '../../src/db/schema.js';
import type { SqlFilterTableMeta } from '../../src/query/index.js';

const F = {
  title: 'fld_TitleAAAAAAAAAAA',
  cost: 'fld_CostAAAAAAAAAAAA',
  status: 'fld_StatusAAAAAAAAAA',
  gone: 'fld_GoneAAAAAAAAAAAA',
} as const;
const OPT_DONE = 'opt_DoneAAAAAAAAAAAA';

const R = {
  a: 'clr_AAAAAAAAAAAAAAAA',
  b: 'clr_BBBBBBBBBBBBBBBB',
  c: 'clr_CCCCCCCCCCCCCCCC',
  d: 'clr_DDDDDDDDDDDDDDDD',
} as const;

const FIELDS: ViewFieldMeta[] = [
  { id: F.title, name: 'title', type: 'text', options: {}, required: true },
  { id: F.cost, name: 'cost', type: 'number', options: {}, required: false },
  {
    id: F.status,
    name: 'status',
    type: 'select',
    options: { multiple: false, options: [{ id: OPT_DONE, name: 'Done', color: 1 }] },
    required: false,
  },
];
const ALL = new Set(FIELDS.map((field) => field.id));
const ADMIN: ViewConfigContext = { fields: FIELDS, readable: ALL };
/** Reads everything but `cost` (the Sales role of CONTRACTS §5). */
const SALES: ViewConfigContext = {
  fields: FIELDS,
  readable: new Set([F.title, F.status]),
};

const COST_RED: StoredColorRule = {
  id: R.a,
  enabled: true,
  filter: { op: 'and', items: [{ field: F.cost, operator: 'gt', value: 100 }] },
  color: 'red',
  target: 'row',
  field_id: null,
};
const DONE_GREEN: StoredColorRule = {
  id: R.b,
  enabled: true,
  filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_DONE }] },
  color: 'green',
  target: 'row',
  field_id: null,
};
const GONE_BLUE: StoredColorRule = {
  id: R.c,
  enabled: true,
  filter: {
    op: 'and',
    items: [
      { field: F.status, operator: 'is', value: OPT_DONE },
      { field: F.gone, operator: 'is_not_empty' },
    ],
  },
  color: 'blue',
  target: 'row',
  field_id: null,
};

function stored(rules: StoredColorRule[]) {
  return { ...storedViewConfigOf('grid', {}), color_rules: rules };
}

function errorsOf(run: () => unknown): { code: string; errors: { path: string; code: string }[] } {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return {
        code: error.code,
        errors: (error.errors ?? []).map((item) => ({ path: item.path, code: item.code })),
      };
    }
    throw error;
  }
  throw new Error('expected a failure');
}

describe('color rules: saving (CONTRACTS §15, T816)', () => {
  const ok: {
    name: string;
    context: ViewConfigContext;
    previous: StoredColorRule[];
    sent: unknown[];
    expected: StoredColorRule[];
  }[] = [
    {
      name: 'a row rule with a tuple filter is stored as DSL',
      context: ADMIN,
      previous: [],
      sent: [
        {
          id: R.a,
          color: 'red',
          target: 'row',
          filter: { logic: 'and', conditions: [[F.cost, '>', 100]] },
        },
      ],
      expected: [COST_RED],
    },
    {
      name: 'a cell rule keeps its field; defaults fill enabled and field_id',
      context: ADMIN,
      previous: [],
      sent: [{ id: R.d, color: 'yellow', target: 'cell', field_id: F.title, filter: null }],
      expected: [
        {
          id: R.d,
          enabled: true,
          filter: null,
          color: 'yellow',
          target: 'cell',
          field_id: F.title,
        },
      ],
    },
    {
      name: 'a rule hidden from the saver stays at its position',
      context: SALES,
      previous: [DONE_GREEN, COST_RED],
      sent: [{ ...DONE_GREEN, color: 'teal' }],
      expected: [{ ...DONE_GREEN, color: 'teal' }, COST_RED],
    },
    {
      name: 'a hidden rule first in the list stays first',
      context: SALES,
      previous: [COST_RED, DONE_GREEN],
      sent: [{ ...DONE_GREEN, enabled: false }],
      expected: [COST_RED, { ...DONE_GREEN, enabled: false }],
    },
    {
      name: 'a broken rule sent back as read keeps its stored filter',
      context: ADMIN,
      previous: [GONE_BLUE],
      sent: [
        {
          id: R.c,
          enabled: true,
          color: 'blue',
          target: 'row',
          field_id: null,
          filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_DONE }] },
        },
      ],
      expected: [GONE_BLUE],
    },
    {
      name: 'a broken rule changed by the saver loses its deleted conditions',
      context: ADMIN,
      previous: [GONE_BLUE],
      sent: [
        {
          id: R.c,
          color: 'pink',
          target: 'row',
          filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_DONE }] },
        },
      ],
      expected: [
        {
          id: R.c,
          enabled: true,
          color: 'pink',
          target: 'row',
          field_id: null,
          filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_DONE }] },
        },
      ],
    },
    {
      name: 'an empty list removes every visible rule but not hidden ones',
      context: SALES,
      previous: [COST_RED, DONE_GREEN],
      sent: [],
      expected: [COST_RED],
    },
  ];

  it.each(ok)('$name', ({ context, previous, sent, expected }) => {
    const config = buildViewConfig('grid', { color_rules: sent }, context, stored(previous));
    expect(config.color_rules).toEqual(expected);
  });

  const failures: {
    name: string;
    context: ViewConfigContext;
    previous: StoredColorRule[];
    sent: unknown[];
    code: string;
    error: { path: string; code: string };
  }[] = [
    {
      name: 'a cell rule without field',
      context: ADMIN,
      previous: [],
      sent: [{ id: R.a, color: 'red', target: 'cell' }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].field_id', code: 'REQUIRED' },
    },
    {
      name: 'a row rule with a field',
      context: ADMIN,
      previous: [],
      sent: [{ id: R.a, color: 'red', target: 'row', field_id: F.title }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].field_id', code: 'NOT_ALLOWED' },
    },
    {
      name: 'a cell rule on a field the saver cannot read',
      context: SALES,
      previous: [],
      sent: [{ id: R.a, color: 'red', target: 'cell', field_id: F.cost }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].field_id', code: 'UNKNOWN_FIELD' },
    },
    {
      name: 'a filter on a field the saver cannot read',
      context: SALES,
      previous: [],
      sent: [{ ...COST_RED }],
      code: 'INVALID_FILTER',
      error: { path: 'config.color_rules[0].filter.items[0].field', code: 'UNKNOWN_FIELD' },
    },
    {
      name: 'two rules with the same id',
      context: ADMIN,
      previous: [],
      sent: [DONE_GREEN, { ...DONE_GREEN, color: 'red' }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[1].id', code: 'DUPLICATE_RULE' },
    },
    {
      name: 'a rule reusing the id of a hidden rule',
      context: SALES,
      previous: [COST_RED],
      sent: [{ ...DONE_GREEN, id: R.a }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].id', code: 'DUPLICATE_RULE' },
    },
    {
      name: 'more rules than the limit once hidden ones are counted',
      context: SALES,
      previous: [COST_RED],
      sent: Array.from({ length: MAX_COLOR_RULES }, (_, index) => ({
        ...DONE_GREEN,
        id: `clr_${String(index).padStart(16, 'X')}`,
      })),
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules', code: 'TOO_BIG' },
    },
    {
      name: 'an unknown color',
      context: ADMIN,
      previous: [],
      sent: [{ ...DONE_GREEN, color: 'crimson' }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].color', code: 'INVALID_VALUE' },
    },
    {
      name: 'a malformed id',
      context: ADMIN,
      previous: [],
      sent: [{ ...DONE_GREEN, id: 'rule-1' }],
      code: 'VALIDATION_FAILED',
      error: { path: 'config.color_rules[0].id', code: 'INVALID_FORMAT' },
    },
  ];

  it.each(failures)('rejects $name', ({ context, previous, sent, code, error }) => {
    const failure = errorsOf(() =>
      buildViewConfig('grid', { color_rules: sent }, context, stored(previous)),
    );
    expect(failure.code).toBe(code);
    expect(failure.errors).toContainEqual(error);
  });

  it.each(['kanban', 'form'] as const)('is a grid setting (%s → UNRECOGNIZED_KEY)', (type) => {
    const failure = errorsOf(() => buildViewConfig(type, { color_rules: [] }, ADMIN, null));
    expect(failure.errors).toContainEqual({ path: 'config.color_rules', code: 'UNRECOGNIZED_KEY' });
  });

  it('copies a view without the rules the new owner cannot see, broken ones as stored', () => {
    const source = stored([COST_RED, DONE_GREEN, GONE_BLUE]);
    expect(copyViewConfig('grid', source, SALES).color_rules).toEqual([DONE_GREEN, GONE_BLUE]);
    expect(copyViewConfig('grid', source, ADMIN).color_rules).toEqual([
      COST_RED,
      DONE_GREEN,
      GONE_BLUE,
    ]);
  });

  it('reads rules of rows saved before T816 as none, and drops malformed entries', () => {
    expect(storedViewConfigOf('grid', {}).color_rules).toEqual([]);
    expect(
      storedViewConfigOf('kanban', { color_rules: [COST_RED] } as unknown as JsonValue).color_rules,
    ).toBeUndefined();
    expect(
      storedViewConfigOf('grid', {
        color_rules: [COST_RED, { id: 'x' }, 'y'],
      } as unknown as JsonValue).color_rules,
    ).toEqual([COST_RED]);
  });
});

describe('color rules: reading (CONTRACTS §15, T816)', () => {
  const cases: {
    name: string;
    visible: ReadonlySet<string>;
    active: ReadonlySet<string> | undefined;
    rules: StoredColorRule[];
    expected: StoredColorRule[];
  }[] = [
    {
      name: 'a reader who reads every field sees every rule',
      visible: ALL,
      active: ALL,
      rules: [COST_RED, DONE_GREEN],
      expected: [COST_RED, DONE_GREEN],
    },
    {
      name: 'a rule on a field the reader cannot read is left out',
      visible: SALES.readable,
      active: ALL,
      rules: [COST_RED, DONE_GREEN],
      expected: [DONE_GREEN],
    },
    {
      name: 'a cell rule on a hidden cell is left out',
      visible: SALES.readable,
      active: ALL,
      rules: [{ ...DONE_GREEN, target: 'cell', field_id: F.cost }],
      expected: [],
    },
    {
      name: 'a rule naming a deleted field is broken, without its deleted conditions',
      visible: ALL,
      active: ALL,
      rules: [GONE_BLUE],
      expected: [
        {
          ...GONE_BLUE,
          filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_DONE }] },
          broken: true,
        },
      ],
    },
    {
      name: 'a cell rule on a deleted field is broken with field_id null',
      visible: ALL,
      active: ALL,
      rules: [{ ...DONE_GREEN, target: 'cell', field_id: F.gone }],
      expected: [{ ...DONE_GREEN, target: 'cell', field_id: null, broken: true }],
    },
    {
      name: 'without the active fields, anything outside the visible ones hides the rule',
      visible: ALL,
      active: undefined,
      rules: [GONE_BLUE, DONE_GREEN],
      expected: [DONE_GREEN],
    },
  ];

  it.each(cases)('$name', ({ visible, active, rules, expected }) => {
    expect(restrictColorRules(rules, visible, active)).toEqual(expected);
  });

  it('is part of the view config returned to a reader', () => {
    const config = restrictViewConfig(stored([COST_RED, DONE_GREEN]), SALES.readable, ALL);
    expect(config.color_rules).toEqual([DONE_GREEN]);
  });
});

describe('color rules: evaluation (T816)', () => {
  const filterMeta: SqlFilterTableMeta = {
    fields: FIELDS.map((field, index) => ({
      id: field.id,
      name: field.name,
      type: field.type as 'text',
      options: field.options,
      dbColumnName: `f_${String(index)}`,
    })),
  };
  const reader = (filterable: Iterable<string>, cells: Iterable<string> = filterable) =>
    ({
      filterable: new Set(filterable),
      cells: new Set(cells),
      filterMeta,
      context: { userId: 'usr_AAAAAAAAAAAAAAAA', groupMemberUserIds: [], timeZone: 'UTC', now: 0 },
      tableAlias: 't',
    }) satisfies ColorRuleReader;

  const applies: {
    name: string;
    rules: StoredColorRule[];
    reader: ColorRuleReader;
    ids: string[] | null;
  }[] = [
    {
      name: 'every enabled rule on readable fields, in order',
      rules: [COST_RED, DONE_GREEN],
      reader: reader(ALL),
      ids: [R.a, R.b],
    },
    {
      name: 'a rule on a field the reader cannot read is skipped',
      rules: [COST_RED, DONE_GREEN],
      reader: reader([F.title, F.status]),
      ids: [R.b],
    },
    {
      name: 'a disabled rule is skipped',
      rules: [{ ...COST_RED, enabled: false }, DONE_GREEN],
      reader: reader(ALL),
      ids: [R.b],
    },
    {
      name: 'a rule naming a deleted field is skipped',
      rules: [GONE_BLUE],
      reader: reader(ALL),
      ids: null,
    },
    {
      name: 'a cell rule on a cell the reader does not see is skipped',
      rules: [{ ...DONE_GREEN, target: 'cell', field_id: F.cost }],
      reader: reader(ALL, [F.title, F.status]),
      ids: null,
    },
    {
      name: 'a rule without filter applies to every record',
      rules: [{ ...COST_RED, filter: null }],
      reader: reader([F.title]),
      ids: [R.a],
    },
    {
      name: 'a filter that no longer validates (option gone) is skipped',
      rules: [
        {
          ...DONE_GREEN,
          filter: {
            op: 'and',
            items: [{ field: F.status, operator: 'is', value: 'opt_GoneAAAAAAAAAAAA' }],
          },
        },
      ],
      reader: reader(ALL),
      ids: null,
    },
  ];

  it.each(applies)('$name', ({ rules, reader: context, ids }) => {
    const plan = colorRulePlan(rules, context);
    expect(plan === null ? null : plan.columns.map((column) => column.id)).toEqual(ids);
  });

  it('gives each row the first matching row rule and per field the first cell rule', () => {
    const plan = colorRulePlan(
      [
        COST_RED,
        { ...DONE_GREEN, id: R.b, target: 'cell', field_id: F.title },
        { ...DONE_GREEN, id: R.c, target: 'cell', field_id: F.title, color: 'blue' },
        { ...DONE_GREEN, id: R.d, target: 'row' },
      ],
      reader(ALL),
    );
    if (plan === null) throw new Error('expected a plan');
    const [cost, titleFirst, titleSecond, done] = plan.columns.map((column) => column.key);
    const row = (matches: (string | undefined)[]) =>
      Object.fromEntries(matches.flatMap((key) => (key === undefined ? [] : [[key, true]])));
    expect(colorOfRow(plan, row([]))).toEqual({});
    expect(colorOfRow(plan, row([cost, done]))).toEqual({ row: R.a });
    expect(colorOfRow(plan, row([done]))).toEqual({ row: R.d });
    expect(colorOfRow(plan, row([titleSecond]))).toEqual({ cells: { [F.title]: R.c } });
    expect(colorOfRow(plan, row([titleFirst, titleSecond, done]))).toEqual({
      row: R.d,
      cells: { [F.title]: R.b },
    });
  });
});
