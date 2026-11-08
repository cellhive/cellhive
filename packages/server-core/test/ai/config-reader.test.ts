import { describe, expect, it } from 'vitest';

import { aiConfigFieldIds, aiConfigVisible, aiOptionsForReader } from '../../src/index.js';

import type {
  BaseSchemaRows,
  SchemaReadability,
} from '../../src/computed/definition/schema-rows.js';
import type { FieldRow, TableRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * BACKLOG T1006 (CONTRACTS §29.5): who gets the whole `options.ai` of an AI
 * field — schema rights on its table and every active field flowing into
 * the prompt readable (sources, and what a computed source reads on the
 * same record); everyone else `{ task }`.
 */

const ORDERS = 'tbl_CfgOrders0000001' as Id<'tbl'>;
const TITLE = 'fld_CfgTitle00000001' as Id<'fld'>;
const COST = 'fld_CfgCost000000001' as Id<'fld'>;
const MARGIN = 'fld_CfgMargin0000001' as Id<'fld'>;
const GONE = 'fld_CfgGone000000001' as Id<'fld'>;

const field = (
  id: string,
  name: string,
  type: string,
  extra: Partial<Record<keyof FieldRow, unknown>> = {},
): FieldRow =>
  ({
    id,
    table_id: ORDERS,
    name,
    type,
    options: {},
    deleted_at: null,
    description: null,
    result_type: null,
    compute_mode: null,
    ...extra,
  }) as unknown as FieldRow;

const ai = (prompt: string, extra: Record<string, unknown> = {}) =>
  field('fld_CfgNote000000001', 'note', 'text', {
    options: {
      style: { type: 'plain' },
      ai: {
        task: 'summarize',
        prompt,
        instructions: 'Be brief.',
        auto_update: true,
        max_output_tokens: 300,
        ...extra,
      },
    },
  });

const rows: BaseSchemaRows = {
  baseId: 'bse_CfgBase000000001',
  tables: [{ id: ORDERS, name: 'Orders', primary_field_id: TITLE } as unknown as TableRow],
  fields: [
    field(TITLE, 'title', 'text'),
    field(COST, 'cost', 'number'),
    // A same-record formula reading `cost`: what it reads flows into a prompt naming it.
    field(MARGIN, 'margin', 'formula', {
      options: { expression: `[${COST}] * 2` },
      result_type: { kind: 'number', list: false },
      compute_mode: 'stored',
    }),
  ],
};

const readsAll: SchemaReadability = { table: () => true, field: () => true };
const noCost: SchemaReadability = { table: () => true, field: (_table, id) => id !== COST };

describe('aiConfigFieldIds (T1006)', () => {
  it.each<[string, string, Id<'fld'>[]]>([
    ['the sources named', `{{ [${TITLE}] }} {{ [${COST}] }}`, [COST, TITLE]],
    ['and what a same-record formula reads', `{{ [${MARGIN}] }}`, [COST, MARGIN]],
    ['a deleted source is left out (#REF)', `{{ [${TITLE}] }} {{ [${GONE}] }}`, [TITLE]],
  ])('%s', (_name, prompt, expected) => {
    expect(aiConfigFieldIds(ai(prompt), rows).sort()).toEqual([...expected].sort());
  });

  it('is empty for a field that is not an AI field', () => {
    expect(aiConfigFieldIds(field(TITLE, 'title', 'text'), rows)).toEqual([]);
  });
});

describe('aiConfigVisible / aiOptionsForReader (T1006)', () => {
  const whole = {
    task: 'summarize',
    prompt: 'Sum {{ [title] }} at {{ [cost] }}',
    instructions: 'Be brief.',
    auto_update: true,
    max_output_tokens: 300,
  };
  const prompt = `Sum {{ [${TITLE}] }} at {{ [${COST}] }}`;

  it.each<[string, { canManage: boolean; readable: SchemaReadability }, string, unknown]>([
    [
      'a manager who reads every source: whole, in names',
      { canManage: true, readable: readsAll },
      prompt,
      whole,
    ],
    [
      'a manager who cannot read cost: { task }',
      { canManage: true, readable: noCost },
      prompt,
      { task: 'summarize' },
    ],
    [
      'a reader of every source without schema rights: { task }',
      { canManage: false, readable: readsAll },
      prompt,
      { task: 'summarize' },
    ],
    [
      'cost through a formula the prompt names: { task }',
      { canManage: true, readable: noCost },
      `Margin {{ [${MARGIN}] }}`,
      { task: 'summarize' },
    ],
    [
      'a deleted source does not hide it from a manager: #REF',
      { canManage: true, readable: noCost },
      `{{ [${TITLE}] }} {{ [${GONE}] }}`,
      { ...whole, prompt: `{{ [title] }} {{ #REF[${GONE}] }}` },
    ],
  ])('%s', (_name, reader, stored, expected) => {
    const note = ai(stored);
    expect(aiOptionsForReader(note, rows, reader)).toEqual(expected);
    expect(aiConfigVisible(reader, ORDERS, aiConfigFieldIds(note, rows))).toBe(
      typeof expected === 'object' && expected !== null && 'prompt' in expected,
    );
  });

  it('is null for a field that is not an AI field (or whose AI was removed)', () => {
    const reader = { canManage: true, readable: readsAll };
    expect(aiOptionsForReader(field(TITLE, 'title', 'text'), rows, reader)).toBeNull();
    expect(
      aiOptionsForReader(field(TITLE, 'title', 'text', { options: { ai: null } }), rows, reader),
    ).toBeNull();
  });
});
