import { AUTOMATION_DISALLOWED_FUNCTIONS } from '@cellhive/contracts';
import { describe, expect, it, vi } from 'vitest';

import { compileRegex } from '../src/evaluate/regex.js';
import {
  checkTemplate,
  disallowedCalls,
  evaluate,
  EvaluationInterrupted,
  FormulaError,
  formatTemplateValue,
  parse,
  renderTemplateNames,
  templateResultType,
  T,
  listOf,
  rowOf,
  type CheckTemplateOptions,
  type SchemaSnapshot,
} from '../src/index.js';

import { fixedId } from './fixture.js';
import { cpuTimeMs, timingBudgetsApply } from './timing.js';

vi.mock('../src/evaluate/regex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/evaluate/regex.js')>();
  return { ...actual, compileRegex: vi.fn(actual.compileRegex) };
});

const tbl = { orders: fixedId('tbl', 'orders'), customers: fixedId('tbl', 'customers') };
const fld = {
  title: fixedId('fld', 'title'),
  amount: fixedId('fld', 'amount'),
  status: fixedId('fld', 'status'),
  customer: fixedId('fld', 'customer'),
  due: fixedId('fld', 'due'),
  tags: fixedId('fld', 'tags'),
  owner: fixedId('fld', 'owner'),
  name: fixedId('fld', 'name'),
  odd: fixedId('fld', 'odd'),
};

const snapshot: SchemaSnapshot = {
  tableId: tbl.orders,
  tables: [
    {
      id: tbl.orders,
      name: 'Orders',
      primaryFieldId: fld.title,
      fields: [
        { id: fld.title, name: 'Title', type: 'text' },
        {
          id: fld.amount,
          name: 'Amount',
          type: 'number',
          options: { style: { type: 'currency', currency_code: 'VND' } },
        },
        {
          id: fld.status,
          name: 'Status',
          type: 'select',
          options: { options: [{ id: 'opt_done', name: 'Done' }] },
        },
        { id: fld.customer, name: 'Customer', type: 'link', linkTableId: tbl.customers },
        {
          id: fld.due,
          name: 'Due',
          type: 'datetime',
          options: { style: { format: 'dd/MM/yyyy' } },
        },
        {
          id: fld.tags,
          name: 'Tags',
          type: 'select',
          options: { multiple: true, options: [] },
        },
        { id: fld.owner, name: 'Owner', type: 'user' },
        { id: fld.odd, name: 'a]b "q"', type: 'text' },
      ],
    },
    {
      id: tbl.customers,
      name: 'Customers',
      primaryFieldId: fld.name,
      fields: [{ id: fld.name, name: 'Name', type: 'text' }],
    },
  ],
};

const automation: CheckTemplateOptions = {
  disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
  allowTables: false,
};

describe('checkTemplate: stored ↔ display round trip', () => {
  const cases: { name: string; display: string; stored: string }[] = [
    { name: 'literal only', display: 'Hello', stored: 'Hello' },
    {
      name: 'one field',
      display: 'Ticket {{ [Title] }} done',
      stored: `Ticket {{ [${fld.title}] }} done`,
    },
    {
      name: 'canonical spacing and upper-case functions',
      display: '{{if([Amount]>1,"big","small")}}',
      stored: `{{ IF([${fld.amount}] > 1, "big", "small") }}`,
    },
    {
      name: 'link chain',
      display: 'For {{ [Customer].[Name] }}',
      stored: `For {{ [${fld.customer}].[${fld.name}] }}`,
    },
    {
      name: 'escaped braces and backslashes stay as written',
      display: '\\{{ not }} \\\\ {{ [Title] }}',
      stored: `\\{{ not }} \\\\ {{ [${fld.title}] }}`,
    },
    {
      name: 'names needing escapes',
      display: '{{ [a\\]b "q"] }}',
      stored: `{{ [${fld.odd}] }}`,
    },
    {
      name: 'nested functions, strings with braces',
      display: '{{ TEXT([Amount], "#,##0") & "}}" }}đ',
      stored: `{{ TEXT([${fld.amount}], "#,##0") & "}}" }}đ`,
    },
    {
      name: 'now and today',
      display: '{{ NOW() }} / {{ TODAY() }}',
      stored: '{{ NOW() }} / {{ TODAY() }}',
    },
  ];
  it.each(cases)('$name', ({ display, stored }) => {
    const fromDisplay = checkTemplate(display, snapshot, { ...automation, form: 'display' });
    expect(fromDisplay.errors).toEqual([]);
    expect(fromDisplay.stored).toBe(stored);
    const fromStored = checkTemplate(stored, snapshot, automation);
    expect(fromStored.errors).toEqual([]);
    expect(fromStored.stored).toBe(stored);
    expect(renderTemplateNames(stored, snapshot)).toBe(fromStored.display);
    expect(checkTemplate(fromStored.display ?? '', snapshot, { form: 'display' }).stored).toBe(
      stored,
    );
  });

  it('renaming a field keeps the stored template and changes the display', () => {
    const stored = `Hi {{ [${fld.title}] }}`;
    const renamed: SchemaSnapshot = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        fields: table.fields.map((field) =>
          field.id === fld.title ? { ...field, name: 'Subject' } : field,
        ),
      })),
    };
    expect(renderTemplateNames(stored, renamed)).toBe('Hi {{ [Subject] }}');
    expect(checkTemplate(stored, renamed).stored).toBe(stored);
  });

  it('a deleted field renders as #REF and fails the check (UNKNOWN_FIELD)', () => {
    const stored = `Hi {{ [${fld.title}] }}!`;
    const without: SchemaSnapshot = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({
        ...table,
        fields: table.fields.filter((field) => field.id !== fld.title),
      })),
    };
    expect(renderTemplateNames(stored, without)).toBe(`Hi {{ #REF[${fld.title}] }}!`);
    const checked = checkTemplate(stored, without);
    expect(checked.stored).toBeNull();
    expect(checked.errors).toEqual([
      expect.objectContaining({
        code: 'UNKNOWN_FIELD',
        params: expect.objectContaining({ position: { start: 6, length: 22 } }) as unknown,
      }),
    ]);
    // The display form with #REF parses again and heals once the field is back.
    const display = renderTemplateNames(stored, without);
    expect(checkTemplate(display, snapshot, { form: 'display' }).stored).toBe(stored);
  });

  it('keeps an expression that does not parse as written when rendering names', () => {
    expect(renderTemplateNames('a {{ 1 + }} b', snapshot)).toBe('a {{ 1 + }} b');
  });
});

describe('checkTemplate: errors with positions in the template', () => {
  const cases: {
    name: string;
    source: string;
    form?: 'display' | 'stored';
    errors: { code: string; text: string; params?: Record<string, unknown> }[];
  }[] = [
    {
      name: 'syntax error inside a placeholder',
      source: 'x {{ 1 + }} y',
      errors: [{ code: 'UNEXPECTED_END', text: '' }],
    },
    {
      name: 'unknown name in display form',
      source: 'Hi {{ [Nope] }}',
      form: 'display',
      errors: [{ code: 'UNKNOWN_FIELD', text: '[Nope]' }],
    },
    {
      name: 'a name in the stored form is not an ID',
      source: 'Hi {{ [Title] }}',
      errors: [{ code: 'INVALID_REFERENCE', text: '[Title]' }],
    },
    {
      name: 'REGEXMATCH is refused (S4b-followup §1.4)',
      source: 'x {{ REGEXMATCH("aaaa", "^(a+)+$") }}',
      errors: [
        {
          code: 'UNSUPPORTED_FUNCTION',
          text: 'REGEXMATCH("aaaa", "^(a+)+$")',
          params: { function: 'REGEXMATCH' },
        },
      ],
    },
    {
      name: 'REGEX nested and chained, each reported',
      source: '{{ IF(TRUE, "a".REGEXREPLACE("a", "b"), REGEXEXTRACT("a", "a")) }}',
      errors: [
        { code: 'UNSUPPORTED_FUNCTION', text: '"a".REGEXREPLACE("a", "b")' },
        { code: 'UNSUPPORTED_FUNCTION', text: 'REGEXEXTRACT("a", "a")' },
      ],
    },
    {
      name: 'REGEX is refused even when names do not resolve',
      source: '{{ REGEXMATCH([Nope], "a") }}',
      form: 'display',
      errors: [{ code: 'UNSUPPORTED_FUNCTION', text: 'REGEXMATCH([Nope], "a")' }],
    },
    {
      name: 'a whole table is refused',
      source: '{{ COUNTA([Customers].[Name]) }}',
      form: 'display',
      errors: [{ code: 'CROSS_TABLE_NOT_SUPPORTED', text: '[Customers]' }],
    },
    {
      name: 'type errors keep their formula code',
      source: '{{ [Title] * 2 }}',
      form: 'display',
      errors: [{ code: 'TYPE_MISMATCH', text: '[Title]' }],
    },
    {
      name: 'a table as the result',
      source: '{{ [Customer] }} {{ [Customer].FILTER(TRUE) }}',
      form: 'display',
      errors: [],
    },
    {
      name: 'unterminated, then empty',
      source: '{{ }} and {{ [Title]',
      form: 'display',
      errors: [
        { code: 'EMPTY_PLACEHOLDER', text: '{{ }}' },
        { code: 'UNTERMINATED_PLACEHOLDER', text: '{{ [Title]' },
      ],
    },
    {
      name: 'every placeholder is checked',
      source: '{{ 1 + }} {{ [Nope] }}',
      form: 'display',
      errors: [
        { code: 'UNEXPECTED_END', text: '' },
        { code: 'UNKNOWN_FIELD', text: '[Nope]' },
      ],
    },
  ];
  it.each(cases)('$name', ({ source, form, errors }) => {
    const checked = checkTemplate(source, snapshot, { ...automation, form: form ?? 'stored' });
    expect(
      checked.errors.map((error) => ({
        code: error.code,
        text: source.slice(
          error.params.position.start,
          error.params.position.start + error.params.position.length,
        ),
        ...(errors.find((item) => item.code === error.code)?.params === undefined
          ? {}
          : { params: error.params }),
      })),
    ).toEqual(
      errors.map((error) =>
        error.params === undefined
          ? { code: error.code, text: error.text }
          : { ...error, params: expect.objectContaining(error.params) as unknown },
      ),
    );
    if (errors.length > 0) expect(checked.stored).toBeNull();
  });

  it('REGEX passes when nothing is disallowed (formula fields)', () => {
    expect(checkTemplate('{{ REGEXMATCH("a", "a") }}', snapshot).errors).toEqual([]);
  });

  it('a whole table passes when tables are allowed', () => {
    const checked = checkTemplate('{{ COUNTA([Customers].[Name]) }}', snapshot, {
      form: 'display',
    });
    expect(checked.errors).toEqual([]);
    expect(checked.placeholders[0]?.dependencies).toEqual([
      expect.objectContaining({ field_id: fld.name, kind: 'cross_table' }),
    ]);
  });

  it('reports dependencies, type and style of each placeholder', () => {
    const checked = checkTemplate('{{ [Amount] }} {{ [Customer].[Name] }} {{ [Tags] }}', snapshot, {
      ...automation,
      form: 'display',
    });
    expect(checked.placeholders.map((item) => [item.type, item.style])).toEqual([
      [T.number, { type: 'currency', currency_code: 'VND' }],
      [listOf(T.text), null],
      [listOf(T.text), null],
    ]);
    expect(checked.placeholders[1]?.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_id: fld.customer, kind: 'same_row' }),
        expect.objectContaining({
          field_id: fld.name,
          kind: 'via_link',
          link_path: [fld.customer],
        }),
      ]),
    );
  });
});

describe('disallowedCalls', () => {
  it('finds calls in LET bindings and members', () => {
    const ast = parse(
      'LET(x, REGEXMATCH("a", "b"), [A].FILTER(REGEXMATCH(CurrentValue.[B], x)).[C])',
    );
    expect(disallowedCalls(ast, ['REGEXMATCH']).map((error) => error.start)).toEqual([7, 40]);
    expect(disallowedCalls(ast, [])).toEqual([]);
  });
});

describe('evaluate: disallow and interrupt (BACKLOG T504)', () => {
  const row = { id: 'rec_1', fields: {} };
  const base = { snapshot, row, tz: 'UTC', now: '2026-10-05T00:00:00Z' };

  it('refuses a disallowed function without reaching RegExp', () => {
    const compile = vi.mocked(compileRegex);
    compile.mockClear();
    const ast = parse('REGEXMATCH("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "^(a+)+$")');
    let caught: unknown;
    // CPU time of this process (QA S5c: the wall clock failed under a parallel turbo run);
    // a catastrophic backtrack would take seconds of CPU, refusing takes well under 50 ms.
    const spent = cpuTimeMs(() => {
      try {
        evaluate(ast, { ...base, disallow: new Set(AUTOMATION_DISALLOWED_FUNCTIONS) });
      } catch (error) {
        caught = error;
      }
    });
    if (timingBudgetsApply()) expect(spent).toBeLessThan(50);
    expect(caught).toBeInstanceOf(FormulaError);
    expect(caught).toMatchObject({
      detail: 'UNSUPPORTED_FUNCTION',
      params: { function: 'REGEXMATCH' },
    });
    expect(compile).not.toHaveBeenCalled();
    // Without `disallow` the same call does reach the regex engine.
    evaluate(parse('REGEXMATCH("ab", "a")'), base);
    expect(compile).toHaveBeenCalled();
  });

  it('runs other functions as usual', () => {
    expect(
      evaluate(parse('UPPER("a") & LEN("abc")'), {
        ...base,
        disallow: new Set(AUTOMATION_DISALLOWED_FUNCTIONS),
      }),
    ).toBe('A3');
  });

  it('stops when interrupt answers true', () => {
    let calls = 0;
    const ast = parse(Array.from({ length: 300 }, () => '1').join(' + '));
    expect(() =>
      evaluate(ast, {
        ...base,
        interrupt: () => {
          calls += 1;
          return calls > 2;
        },
      }),
    ).toThrow(EvaluationInterrupted);
    expect(calls).toBe(3);
  });

  it('keeps going while interrupt answers false', () => {
    const ast = parse(Array.from({ length: 300 }, () => '1').join(' + '));
    expect(evaluate(ast, { ...base, interrupt: () => false })).toBe('300');
  });
});

describe('formatTemplateValue: like cell_format=text (CONTRACTS §2)', () => {
  const vi_ = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
  const cases: {
    name: string;
    value: Parameters<typeof formatTemplateValue>[0];
    type: Parameters<typeof formatTemplateValue>[1];
    style?: Record<string, unknown> | null;
    text: string;
  }[] = [
    { name: 'text', value: 'abc', type: T.text, text: 'abc' },
    { name: 'empty', value: null, type: T.text, text: '' },
    { name: 'plain number', value: '1234.5', type: T.number, text: '1234,5' },
    {
      name: 'currency style',
      value: '1500000',
      type: T.number,
      style: { type: 'currency', currency_code: 'VND' },
      text: '1.500.000 ₫',
    },
    { name: 'boolean', value: true, type: T.boolean, text: 'TRUE' },
    { name: 'date', value: '2026-10-05', type: T.date, text: '2026-10-05' },
    {
      name: 'datetime with style, in the zone',
      value: '2026-10-05T03:00:00.000Z',
      type: T.datetime,
      style: { format: 'dd/MM/yyyy HH:mm' },
      text: '05/10/2026 10:00',
    },
    { name: 'list joined with ", "', value: ['a', 'b'], type: listOf(T.text), text: 'a, b' },
    {
      name: 'records by title',
      value: [{ id: 'rec_1', title: 'Acme' }],
      type: listOf(rowOf(tbl.customers)),
      text: 'Acme',
    },
    { name: 'users by name', value: ['usr_1'], type: listOf(T.user), text: 'Lan' },
    { name: 'unknown user keeps the id', value: 'usr_2', type: T.user, text: 'usr_2' },
    { name: 'untyped number', value: 3 as never, type: T.any, text: '3' },
  ];
  it.each(cases)('$name', ({ value, type, style, text }) => {
    expect(
      formatTemplateValue(value, type, style ?? null, {
        ...vi_,
        userName: (id) => (id === 'usr_1' ? 'Lan' : null),
      }),
    ).toBe(text);
  });

  it('maps result types like computed fields', () => {
    expect(templateResultType(listOf(rowOf(tbl.orders)))).toEqual({ kind: 'record', list: true });
    expect(templateResultType(T.any)).toEqual({ kind: 'text', list: false });
  });
});
