import { describe, expect, it } from 'vitest';

import {
  definitionReferenceIds,
  desiredFieldErrors,
  fieldErrorOf,
  newlyFailing,
  sameFieldError,
  type FieldError,
} from '../../src/computed/errors/index.js';

import type { BaseSchemaRows } from '../../src/computed/definition/schema-rows.js';
import type { FieldRow, TableRow } from '../../src/db/schema.js';

/**
 * T460: the pure computation of field-level errors — which error each
 * active formula/lookup field of a base should have (priority REF > CIRCLE >
 * INVALID_CONFIG > TIMEOUT > indirect REF), from the meta rows, the
 * dependency edges and whether definitions still analyse.
 */

const table = (id: string): TableRow => ({ id }) as unknown as TableRow;

function field(
  id: string,
  tableId: string,
  type: string,
  options: Record<string, unknown> = {},
  error: Record<string, unknown> | null = null,
): FieldRow {
  return {
    id,
    table_id: tableId,
    type,
    options,
    deleted_at: null,
    compute_error: error,
    compute_state: error === null ? 'ready' : 'error',
  } as unknown as FieldRow;
}

const formula = (
  id: string,
  tableId: string,
  expression: string,
  error?: Record<string, unknown>,
) => field(id, tableId, 'formula', { expression }, error ?? null);

const e = (fieldId: string, dependsOnFieldId: string) => ({ fieldId, dependsOnFieldId });

interface Case {
  readonly name: string;
  readonly tables: readonly string[];
  readonly fields: readonly FieldRow[];
  readonly edges: readonly ReturnType<typeof e>[];
  /** Tables of fields that are not active (deleted, purged, of a trashed table). */
  readonly inactive?: Readonly<Record<string, string>>;
  readonly failing?: readonly string[];
  readonly causes?: readonly string[];
  readonly expected: Readonly<Record<string, FieldError | null>>;
}

const cases: Case[] = [
  {
    name: 'nothing missing: no error',
    tables: ['tbl_o'],
    fields: [field('fld_amount', 'tbl_o', 'number'), formula('fld_f', 'tbl_o', '[fld_amount] * 2')],
    edges: [e('fld_f', 'fld_amount')],
    expected: { fld_f: null },
  },
  {
    name: 'a deleted field → REF on the field, indirect REF on its reader',
    tables: ['tbl_o'],
    fields: [
      formula('fld_f', 'tbl_o', '[fld_amount] * 2'),
      formula('fld_g', 'tbl_o', '[fld_f] + 1'),
    ],
    edges: [e('fld_f', 'fld_amount'), e('fld_g', 'fld_f')],
    inactive: { fld_amount: 'tbl_o' },
    expected: {
      fld_f: { code: 'REF', refs: [{ kind: 'field', id: 'fld_amount' }] },
      fld_g: { code: 'REF', refs: [{ kind: 'field', id: 'fld_f' }] },
    },
  },
  {
    name: 'a field of a trashed table → REF on the table (lookup `from`)',
    tables: ['tbl_c'],
    fields: [
      field('fld_total', 'tbl_c', 'lookup', {
        from: 'tbl_o',
        select: 'fld_amount',
        where: { field: 'fld_customer', operator: 'intersects', value: { field_ref: '__id' } },
      }),
    ],
    edges: [e('fld_total', 'fld_amount'), e('fld_total', 'fld_customer')],
    inactive: { fld_amount: 'tbl_o', fld_customer: 'tbl_o' },
    expected: { fld_total: { code: 'REF', refs: [{ kind: 'table', id: 'tbl_o' }] } },
  },
  {
    name: 'a link walked through whose linked table is in the trash → REF on that table',
    tables: ['tbl_o'],
    fields: [
      field('fld_customer', 'tbl_o', 'link', { link_table: 'tbl_c' }),
      formula('fld_n', 'tbl_o', 'COUNTA([fld_customer])'),
    ],
    edges: [e('fld_n', 'fld_customer')],
    expected: { fld_n: { code: 'REF', refs: [{ kind: 'table', id: 'tbl_c' }] } },
  },
  {
    name: 'a restore closing a cycle → CIRCLE on every field of it; its reader REF',
    tables: ['tbl_o'],
    fields: [
      formula('fld_a', 'tbl_o', '[fld_d] + 1'),
      formula('fld_d', 'tbl_o', '[fld_b] + 1'),
      formula('fld_b', 'tbl_o', '[fld_a] + 1'),
      formula('fld_r', 'tbl_o', '[fld_b] * 2'),
    ],
    edges: [e('fld_a', 'fld_d'), e('fld_d', 'fld_b'), e('fld_b', 'fld_a'), e('fld_r', 'fld_b')],
    expected: {
      fld_a: {
        code: 'CIRCLE',
        refs: [
          { kind: 'field', id: 'fld_a' },
          { kind: 'field', id: 'fld_b' },
          { kind: 'field', id: 'fld_d' },
        ],
      },
      fld_b: {
        code: 'CIRCLE',
        refs: [
          { kind: 'field', id: 'fld_a' },
          { kind: 'field', id: 'fld_b' },
          { kind: 'field', id: 'fld_d' },
        ],
      },
      fld_d: {
        code: 'CIRCLE',
        refs: [
          { kind: 'field', id: 'fld_a' },
          { kind: 'field', id: 'fld_b' },
          { kind: 'field', id: 'fld_d' },
        ],
      },
      fld_r: { code: 'REF', refs: [{ kind: 'field', id: 'fld_b' }] },
    },
  },
  {
    name: 'a self reference is a cycle too',
    tables: ['tbl_o'],
    fields: [formula('fld_s', 'tbl_o', '[fld_s]')],
    edges: [e('fld_s', 'fld_s')],
    expected: { fld_s: { code: 'CIRCLE', refs: [{ kind: 'field', id: 'fld_s' }] } },
  },
  {
    name: 'direct REF wins over a cycle through a deleted field',
    tables: ['tbl_o'],
    fields: [formula('fld_a', 'tbl_o', '[fld_b] + [fld_x]'), formula('fld_b', 'tbl_o', '[fld_a]')],
    edges: [e('fld_a', 'fld_b'), e('fld_a', 'fld_x'), e('fld_b', 'fld_a')],
    inactive: { fld_x: 'tbl_o' },
    expected: {
      fld_a: { code: 'REF', refs: [{ kind: 'field', id: 'fld_x' }] },
      fld_b: { code: 'REF', refs: [{ kind: 'field', id: 'fld_a' }] },
    },
  },
  {
    name: 'no longer typechecks → INVALID_CONFIG naming the converted field; reader REF',
    tables: ['tbl_o'],
    fields: [
      field('fld_amount', 'tbl_o', 'text'),
      formula('fld_f', 'tbl_o', '[fld_amount] * 2'),
      formula('fld_g', 'tbl_o', '[fld_f] + 1'),
    ],
    edges: [e('fld_f', 'fld_amount'), e('fld_g', 'fld_f')],
    failing: ['fld_f'],
    causes: ['fld_amount'],
    expected: {
      fld_f: { code: 'INVALID_CONFIG', refs: [{ kind: 'field', id: 'fld_amount' }] },
      fld_g: { code: 'REF', refs: [{ kind: 'field', id: 'fld_f' }] },
    },
  },
  {
    name: 'TIMEOUT from a job stays (and its readers are REF)',
    tables: ['tbl_o'],
    fields: [
      formula('fld_t', 'tbl_o', '1', { code: 'TIMEOUT', refs: [] }),
      formula('fld_u', 'tbl_o', '[fld_t] + 1'),
    ],
    edges: [e('fld_u', 'fld_t')],
    expected: {
      fld_t: { code: 'TIMEOUT', refs: [] },
      fld_u: { code: 'REF', refs: [{ kind: 'field', id: 'fld_t' }] },
    },
  },
  {
    name: 'an old REF whose field came back heals',
    tables: ['tbl_o'],
    fields: [
      field('fld_amount', 'tbl_o', 'number'),
      formula('fld_f', 'tbl_o', '[fld_amount]', {
        code: 'REF',
        refs: [{ kind: 'field', id: 'fld_amount' }],
      }),
    ],
    edges: [e('fld_f', 'fld_amount')],
    expected: { fld_f: null },
  },
];

describe('desiredFieldErrors (T460)', () => {
  it.each(cases)('$name', (item) => {
    const rows: BaseSchemaRows = {
      baseId: 'bse_x',
      tables: item.tables.map(table),
      fields: item.fields,
    };
    const failing = new Set(item.failing ?? []);
    const result = desiredFieldErrors({
      rows,
      edges: item.edges,
      tableOfField: (id) => item.inactive?.[id],
      analyses: (row) => !failing.has(row.id),
      ...(item.causes === undefined ? {} : { causes: new Set(item.causes) }),
    });
    const computed = item.fields.filter((row) => row.type === 'formula' || row.type === 'lookup');
    expect(Object.fromEntries(computed.map((row) => [row.id, result.get(row.id) ?? null]))).toEqual(
      item.expected,
    );
  });
});

describe('field error helpers (T460)', () => {
  it('reads stored errors back, rejecting unknown codes', () => {
    expect(fieldErrorOf({ code: 'REF', refs: [{ kind: 'table', id: 'tbl_x' }] })).toEqual({
      code: 'REF',
      refs: [{ kind: 'table', id: 'tbl_x' }],
    });
    expect(fieldErrorOf({ code: 'INVALID_CONFIG', refs: 'x' })).toEqual({
      code: 'INVALID_CONFIG',
      refs: [],
    });
    expect(fieldErrorOf({ code: 'NOPE', refs: [] })).toBeNull();
    expect(fieldErrorOf(null)).toBeNull();
  });

  it('compares errors by code and refs', () => {
    const a: FieldError = { code: 'REF', refs: [{ kind: 'field', id: 'fld_a' }] };
    expect(sameFieldError(a, { code: 'REF', refs: [{ kind: 'field', id: 'fld_a' }] })).toBe(true);
    expect(sameFieldError(a, { code: 'CIRCLE', refs: [{ kind: 'field', id: 'fld_a' }] })).toBe(
      false,
    );
    expect(sameFieldError(a, null)).toBe(false);
    expect(sameFieldError(null, null)).toBe(true);
  });

  it('lists what a definition names (formula ids, lookup from/select/where; `__id` excluded)', () => {
    const refs = definitionReferenceIds(
      field('fld_l', 'tbl_c', 'lookup', {
        from: 'tbl_o',
        select: 'fld_amount',
        where: {
          op: 'and',
          items: [
            { field: 'fld_customer', operator: 'intersects', value: { field_ref: '__id' } },
            { field: 'fld_code', operator: 'is', value: { field_ref: 'fld_ccode' } },
          ],
        },
      }),
    );
    expect([...refs.tables]).toEqual(['tbl_o']);
    expect([...refs.fields].sort()).toEqual([
      'fld_amount',
      'fld_ccode',
      'fld_code',
      'fld_customer',
    ]);
    const c = 'tbl_Customers0000001';
    const k = 'fld_Key0000000000001';
    const j = 'fld_Join000000000001';
    const v = 'fld_Value00000000001';
    const formulaRefs = definitionReferenceIds(
      formula('fld_f', 'tbl_o', `[${c}].FILTER(CurrentValue.[${k}] = [${j}]).[${v}].SUM()`),
    );
    expect([...formulaRefs.tables]).toEqual([c]);
    expect([...formulaRefs.fields].sort()).toEqual([j, k, v]);
    // Text that is not valid stored text names nothing.
    expect(definitionReferenceIds(formula('fld_x', 'tbl_o', '[not an id')).fields.size).toBe(0);
  });

  it('newlyFailing lists fields fine before and in error after', () => {
    const before = new Map<string, FieldError | null>([
      ['fld_a', null],
      ['fld_b', { code: 'TIMEOUT', refs: [] }],
      ['fld_c', null],
    ]);
    const after = new Map<string, FieldError | null>([
      ['fld_a', { code: 'REF', refs: [] }],
      ['fld_b', { code: 'REF', refs: [] }],
      ['fld_c', null],
    ]);
    expect(newlyFailing(before, after)).toEqual(['fld_a']);
  });
});
