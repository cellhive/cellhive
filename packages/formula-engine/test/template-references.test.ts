import { describe, expect, it } from 'vitest';

import {
  checkTemplate,
  evaluate,
  formatTemplateValue,
  parse,
  renderTemplateNames,
  tryParse,
  type FormulaRecord,
  type SchemaSnapshot,
} from '../src/index.js';

import { fixedId } from './fixture.js';

/**
 * Extra reference IDs and single-record links (BACKLOG T505): what
 * automation templates use for `[act_…]` step records and `[@…]` trigger
 * data, resolved, typechecked and evaluated like ordinary fields.
 */

const tbl = { orders: fixedId('tbl', 'orders'), customers: fixedId('tbl', 'customers') };
const fld = {
  title: fixedId('fld', 'title'),
  name: fixedId('fld', 'name'),
  credit: fixedId('fld', 'credit'),
};
const referenceIds = (id: string) => /^(?:act_[0-9A-Za-z_]{1,32}|@[a-z_]{1,32})$/u.test(id);

const snapshot: SchemaSnapshot = {
  tableId: tbl.orders,
  tables: [
    {
      id: tbl.orders,
      name: 'Orders',
      primaryFieldId: fld.title,
      fields: [
        { id: fld.title, name: 'Title', type: 'text' },
        { id: 'act_1', name: 'act_1', type: 'link', linkTableId: tbl.customers, single: true },
        { id: '@fired_at', name: '@fired_at', type: 'datetime' },
        { id: '@url', name: '@url', type: 'text' },
      ],
    },
    {
      id: tbl.customers,
      name: 'Customers',
      primaryFieldId: fld.name,
      fields: [
        { id: fld.name, name: 'Name', type: 'text' },
        { id: fld.credit, name: 'Credit', type: 'number' },
        { id: '@url', name: '@url', type: 'text' },
      ],
    },
  ],
};

describe('parse: referenceIds', () => {
  const cases = [
    { source: '[act_1]', accepted: true },
    { source: '[@fired_at]', accepted: true },
    { source: `[act_1].[${fld.name}]`, accepted: true },
    { source: '[act-1]', accepted: false },
    { source: '[Name]', accepted: false },
  ];
  it.each(cases)('$source (stored) → accepted: $accepted', ({ source, accepted }) => {
    expect(tryParse(source, { form: 'stored', referenceIds }).ok).toBe(accepted);
  });

  it('without the option an extra ID is an invalid stored reference', () => {
    const result = tryParse('[act_1]', { form: 'stored' });
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.detail).toBe('INVALID_REFERENCE');
  });

  it('accepts #REF[act_…] in the display form', () => {
    expect(parse('#REF[act_9]', { form: 'display', referenceIds })).toMatchObject({
      type: 'reference',
      id: 'act_9',
      kind: 'field',
    });
  });
});

describe('checkTemplate: single-record links and extra references', () => {
  it('a field of a step record has the field type, not a list', () => {
    const check = checkTemplate(
      `Credit {{ [act_1].[${fld.credit}] }} at {{ [@fired_at] }}`,
      snapshot,
      { referenceIds },
    );
    expect(check.errors).toEqual([]);
    const [credit, firedAt] = check.placeholders;
    expect(credit?.type).toEqual({ kind: 'number' });
    expect(credit?.dependencies).toContainEqual(
      expect.objectContaining({ field_id: fld.credit, link_path: ['act_1'] }),
    );
    expect(firedAt?.type).toEqual({ kind: 'datetime' });
  });

  it('round-trips stored IDs and display names', () => {
    const stored = `{{ [act_1].[${fld.name}] }} {{ [act_1].[@url] }}`;
    const display = renderTemplateNames(stored, snapshot, { referenceIds });
    expect(display).toBe('{{ [act_1].[Name] }} {{ [act_1].[@url] }}');
    expect(checkTemplate(display, snapshot, { form: 'display', referenceIds }).stored).toBe(stored);
  });

  it('a step that is not in the snapshot is #REF and UNKNOWN_FIELD', () => {
    const stored = `{{ [act_9].[${fld.name}] }}`;
    expect(renderTemplateNames(stored, snapshot, { referenceIds })).toBe(
      '{{ #REF[act_9].[Name] }}',
    );
    const check = checkTemplate(stored, snapshot, { referenceIds });
    expect(check.errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
  });

  it('a step record as text is its title (depends on the primary field)', () => {
    const check = checkTemplate('{{ [act_1] }}', snapshot, { referenceIds });
    expect(check.errors).toEqual([]);
    expect(check.placeholders[0]?.type).toEqual({ kind: 'row', tableId: tbl.customers });
  });
});

describe('evaluate: single-record links', () => {
  const customer: FormulaRecord = {
    id: 'rec_customer000000001',
    title: 'An',
    fields: { [fld.name]: 'An', [fld.credit]: 12.5, '@url': 'https://x/rec' },
  };
  const row: FormulaRecord = {
    id: 'rec_order00000000001',
    fields: { [fld.title]: 'Order', act_1: customer.id, '@fired_at': '2026-10-05T03:00:00.000Z' },
  };
  const run = (expression: string) => {
    const check = checkTemplate(`{{ ${expression} }}`, snapshot, { referenceIds });
    const placeholder = check.placeholders[0];
    if (placeholder === undefined) throw new Error(JSON.stringify(check.errors));
    const value = evaluate(placeholder.ast, {
      snapshot,
      row,
      resolve: {
        table: () => [],
        record: (tableId, id) =>
          tableId === tbl.customers && id === customer.id ? customer : null,
      },
      tz: 'UTC',
      now: new Date('2026-10-05T03:00:00.000Z'),
      types: placeholder.types,
    });
    return formatTemplateValue(value, placeholder.type, placeholder.style, {
      locale: 'en',
      timeZone: 'UTC',
    });
  };

  const cases = [
    { expression: `[act_1].[${fld.name}]`, text: 'An' },
    { expression: `[act_1].[${fld.credit}] * 2`, text: '25' },
    { expression: '[act_1].[@url]', text: 'https://x/rec' },
    { expression: '[act_1]', text: 'An' },
    { expression: `UPPER([act_1].[${fld.name}])`, text: 'AN' },
  ];
  it.each(cases)('$expression → $text', ({ expression, text }) => {
    expect(run(expression)).toBe(text);
  });

  it('an empty step reference gives empty values', () => {
    const empty = { ...row, fields: { ...row.fields, act_1: null } };
    const check = checkTemplate(`{{ [act_1].[${fld.name}] }}`, snapshot, { referenceIds });
    const placeholder = check.placeholders[0];
    expect(placeholder).toBeDefined();
    if (placeholder === undefined) return;
    const value = evaluate(placeholder.ast, {
      snapshot,
      row: empty,
      resolve: null,
      tz: 'UTC',
      now: new Date(),
      types: placeholder.types,
    });
    expect(value).toBeNull();
  });
});

describe('stored form: reference ids with brackets (BACKLOG T604)', () => {
  // Automation references to webhook data may hold `]` (`@body.items[0].sku`).
  const id = '@body.items[0].sku';
  const withBrackets: SchemaSnapshot = {
    ...snapshot,
    tables: snapshot.tables.map((table) =>
      table.id === tbl.orders
        ? { ...table, fields: [...table.fields, { id, name: id, type: 'text' }] }
        : table,
    ),
  };
  const accept = (candidate: string) => candidate === id || referenceIds(candidate);

  it('escapes `]` and `\\` when writing an id, so the stored form parses back', () => {
    const source = '{{ UPPER([@body.items[0\\].sku]) }}';
    const check = checkTemplate(source, withBrackets, { referenceIds: accept });
    expect(check.errors).toEqual([]);
    expect(check.stored).toBe(source);
    const again = checkTemplate(check.stored ?? '', withBrackets, { referenceIds: accept });
    expect(again.errors).toEqual([]);
    expect(again.placeholders[0]?.dependencies).toMatchObject([
      { kind: 'same_row', field_id: id, link_path: [] },
    ]);
  });

  it('writes ordinary ids exactly as before', () => {
    const check = checkTemplate(`{{ [${fld.title}] & [@fired_at] }}`, snapshot, { referenceIds });
    expect(check.stored).toBe(`{{ [${fld.title}] & [@fired_at] }}`);
  });
});
