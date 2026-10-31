import { listCatalogue } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

import {
  aiFormulaAnswerSchema,
  FORMULA_DIGEST_MAX_DESCRIPTION,
  FORMULA_DIGEST_MAX_FIELDS,
  FORMULA_DIGEST_MAX_OPTIONS,
  FORMULA_DIGEST_MAX_TABLES,
  formulaCatalogueText,
  formulaDigest,
  formulaMessages,
  formulaRepairProblems,
} from '../../src/ai/features/formula/formula.js';
import { UNTRUSTED_DATA_INSTRUCTIONS } from '../../src/ai/untrusted.js';
import { AppError } from '../../src/errors/app-error.js';

import type {
  BaseSchemaRows,
  SchemaReadability,
} from '../../src/computed/definition/schema-rows.js';
import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * BACKLOG T907: the schema digest of "Write the formula with AI" (what the
 * caller reads, names only, capped), the catalogue generated from the
 * formula engine, the prompt (names in untrusted data blocks) and the
 * repair problems of a rejected formula.
 */

const table = (id: string, name: string): TableRow =>
  ({ id, name, primary_field_id: null }) as unknown as TableRow;

const field = (
  id: string,
  tableId: string,
  name: string,
  type: string,
  extra: Partial<Record<keyof FieldRow, unknown>> = {},
): FieldRow =>
  ({
    id,
    table_id: tableId,
    name,
    type,
    options: {},
    deleted_at: null,
    description: null,
    result_type: null,
    compute_mode: null,
    ...extra,
  }) as unknown as FieldRow;

const orders = 'tbl_orders' as Id<'tbl'>;

const rows: BaseSchemaRows = {
  baseId: 'bse_b',
  tables: [
    table(orders, 'Orders'),
    table('tbl_customers', 'Customers'),
    table('tbl_secret', 'Secret plans'),
  ],
  fields: [
    field('fld_title', orders, 'title', 'text', {
      description: `Order title ${'x'.repeat(300)}`,
    }),
    field('fld_amount', orders, 'Unit price', 'number'),
    field('fld_cost', orders, 'cost', 'number'),
    field('fld_status', orders, 'status', 'select', {
      options: {
        options: [
          { id: 'opt_new', name: 'New' },
          { id: 'opt_done', name: 'Done' },
        ],
      },
    }),
    field('fld_owner', orders, 'owner', 'user'),
    field('fld_customer', orders, 'customer', 'link', {
      options: { link_table: 'tbl_customers' },
    }),
    field('fld_plan', orders, 'plan', 'link', { options: { link_table: 'tbl_secret' } }),
    field('fld_margin', orders, 'margin', 'formula', {
      result_type: { kind: 'number' },
      compute_mode: 'stored',
    }),
    field('fld_button', orders, 'Approve', 'button'),
    field('fld_name', 'tbl_customers', 'Tên', 'text'),
    field('fld_codename', 'tbl_secret', 'codename', 'text'),
  ],
};

const readable: SchemaReadability = {
  table: (tableId) => tableId !== 'tbl_secret',
  field: (_tableId, fieldId) => fieldId !== 'fld_cost',
};

describe('formulaDigest', () => {
  it('lists what the caller reads by name, minus the edited field', () => {
    const digest = formulaDigest(rows, orders, readable, 'fld_margin');
    expect(digest).toEqual({
      table: {
        name: 'Orders',
        fields: [
          {
            name: 'title',
            type: 'text',
            value: 'text',
            description: `Order title ${'x'.repeat(FORMULA_DIGEST_MAX_DESCRIPTION - 12)}`,
          },
          { name: 'Unit price', type: 'number', value: 'number' },
          { name: 'status', type: 'select', value: 'text', options: ['New', 'Done'] },
          { name: 'owner', type: 'user', value: 'list<user>' },
          { name: 'customer', type: 'link', value: 'list<record<Customers>>' },
          // The target table is hidden: no name, no id.
          { name: 'plan', type: 'link', value: 'list<record>' },
        ],
      },
      other_tables: [{ name: 'Customers', fields: [{ name: 'Tên', type: 'text', value: 'text' }] }],
    });
    const text = JSON.stringify(digest);
    for (const hidden of [
      'cost',
      'Secret',
      'codename',
      'margin',
      'Approve',
      'fld_',
      'tbl_',
      'opt_',
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it('keeps computed fields with their result type when not edited', () => {
    const digest = formulaDigest(rows, orders, readable, null);
    expect(digest.table.fields).toContainEqual({
      name: 'margin',
      type: 'formula',
      value: 'number',
    });
  });

  it.each([
    ['options per field', FORMULA_DIGEST_MAX_OPTIONS],
    ['fields per table', FORMULA_DIGEST_MAX_FIELDS],
    ['other tables', FORMULA_DIGEST_MAX_TABLES],
  ])('caps the %s at %i', (what, cap) => {
    const many = Array.from({ length: cap + 5 }, (_, index) => index);
    const big: BaseSchemaRows = {
      baseId: rows.baseId,
      tables: [
        table(orders, 'Orders'),
        ...many.map((index) => table(`tbl_t${String(index)}`, `T${String(index)}`)),
      ],
      fields: [
        field('fld_s', orders, 's', 'select', {
          options: {
            options: many.map((index) => ({
              id: `opt_${String(index)}`,
              name: `o${String(index)}`,
            })),
          },
        }),
        ...many.map((index) =>
          field(`fld_${String(index)}`, orders, `f${String(index)}`, 'number'),
        ),
      ],
    };
    const digest = formulaDigest(big, orders, { table: () => true, field: () => true }, null);
    const counts: Record<string, number> = {
      'options per field': digest.table.fields[0]?.options?.length ?? 0,
      'fields per table': digest.table.fields.length,
      'other tables': digest.other_tables.length,
    };
    expect(counts[what]).toBe(cap);
  });
});

describe('formulaCatalogueText', () => {
  it('has one line per supported function and no Phase 2 one', () => {
    const lines = formulaCatalogueText().split('\n');
    const supported = listCatalogue().filter((entry) => !entry.phase2);
    expect(lines).toHaveLength(supported.length);
    expect(lines).toContainEqual(expect.stringMatching(/^- SUM\(number.*\) → number: /u));
    expect(lines).toContainEqual(expect.stringMatching(/^- FILTER\(/u));
    expect(formulaCatalogueText()).not.toContain('RANDOMBETWEEN');
  });
});

describe('formulaMessages', () => {
  const digest = formulaDigest(rows, orders, readable, null);

  it('puts names and the current formula in data blocks and the description as the task', () => {
    const [system, user] = formulaMessages({
      digest,
      description: 'Lãi = tiền trừ chi phí',
      current: '[Unit price] -',
    });
    expect(system?.role).toBe('system');
    expect(system?.content).toContain(UNTRUSTED_DATA_INSTRUCTIONS);
    expect(system?.content).toContain(formulaCatalogueText());
    expect(user?.role).toBe('user');
    expect(user?.content).toMatch(/<<DATA schema [0-9a-f]{16}>>\n\{.*"Unitˆprice".*\}\n<<END /u);
    expect(user?.content).toMatch(
      /<<DATA current_formula [0-9a-f]{16}>>\n\[Unitˆprice\]ˆ-\n<<END /u,
    );
    expect(
      user?.content.endsWith('Description of the formula to write:\nLãi = tiền trừ chi phí'),
    ).toBe(true);
  });

  it.each([null, '  '])('leaves out an empty current formula (%j)', (current) => {
    const [, user] = formulaMessages({ digest, description: 'x', current });
    expect(user?.content).not.toContain('current_formula');
  });
});

describe('formulaRepairProblems', () => {
  it.each([
    [
      'formula errors with positions',
      new AppError('FORMULA_SYNTAX_ERROR', {
        detail: 'Unexpected end.',
        errors: [
          {
            path: 'options.expression',
            code: 'UNKNOWN_FIELD',
            message: 'Unknown field "cost".',
            params: { name: 'cost', position: { start: 13, length: 6 } },
          },
          { path: 'options.expression', code: 'UNEXPECTED_END', message: 'Unexpected end.' },
        ],
      }),
      [
        {
          path: 'formula',
          code: 'UNKNOWN_FIELD',
          message: 'Unknown field "cost". (at character 14)',
        },
        { path: 'formula', code: 'UNEXPECTED_END', message: 'Unexpected end.' },
      ],
    ],
    [
      'an error without items',
      new AppError('FORMULA_CYCLE', { detail: 'The formula refers to itself.' }),
      [{ path: 'formula', code: 'FORMULA_CYCLE', message: 'The formula refers to itself.' }],
    ],
  ])('%s', (_name, error, expected) => {
    expect(formulaRepairProblems(error)).toEqual(expected);
  });
});

describe('aiFormulaAnswerSchema', () => {
  it.each([
    [{ formula: ' [a] + 1 ', explanation: ' Adds one. ' }, true],
    [{ formula: '  ', explanation: '' }, false],
    [{ formula: 'x'.repeat(4001), explanation: '' }, false],
    [{ formula: '[a]', explanation: 'x'.repeat(1001) }, false],
    [{ formula: '[a]' }, false],
  ])('%j → %s', (answer, ok) => {
    expect(aiFormulaAnswerSchema.safeParse(answer).success).toBe(ok);
  });
});
