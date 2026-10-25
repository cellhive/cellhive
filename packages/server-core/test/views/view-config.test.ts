import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import {
  buildViewConfig,
  copyViewConfig,
  defaultViewConfig,
  hiddenFilterOf,
  mergeHiddenFilter,
  pruneFilter,
  restrictViewConfig,
  storedViewConfigOf,
  visibleFilterOf,
  type ViewConfigContext,
  type ViewFieldMeta,
} from '../../src/views/view-config.js';

import type { StoredViewConfig, ViewType } from '@cellhive/contracts';

const F = {
  title: 'fld_TitleAAAAAAAAAAA',
  amount: 'fld_AmountAAAAAAAAAA',
  cost: 'fld_CostAAAAAAAAAAAA',
  status: 'fld_StatusAAAAAAAAAA',
  tags: 'fld_TagsAAAAAAAAAAAA',
  owner: 'fld_OwnerAAAAAAAAAAA',
  owners: 'fld_OwnersAAAAAAAAAA',
  number: 'fld_NumberAAAAAAAAAA',
  due: 'fld_DueAAAAAAAAAAAAA',
  gone: 'fld_GoneAAAAAAAAAAAA',
  other: 'fld_OtherTableAAAAAA',
} as const;
const OPT_NEW = 'opt_NewAAAAAAAAAAAAA';

const FIELDS: ViewFieldMeta[] = [
  { id: F.title, name: 'title', type: 'text', options: {}, required: true },
  { id: F.amount, name: 'amount', type: 'number', options: {}, required: false },
  { id: F.cost, name: 'cost', type: 'number', options: {}, required: false },
  {
    id: F.status,
    name: 'status',
    type: 'select',
    options: { multiple: false, options: [{ id: OPT_NEW, name: 'New', color: 1 }] },
    required: false,
  },
  {
    id: F.tags,
    name: 'tags',
    type: 'select',
    options: { multiple: true, options: [] },
    required: false,
  },
  { id: F.owner, name: 'owner', type: 'user', options: { multiple: false }, required: false },
  { id: F.owners, name: 'owners', type: 'user', options: { multiple: true }, required: false },
  { id: F.number, name: 'number', type: 'auto_number', options: {}, required: false },
  { id: F.due, name: 'due', type: 'datetime', options: {}, required: false },
];

/** Everything but `cost` is readable (like the Sales role, CONTRACTS §5). */
const SALES: ViewConfigContext = {
  fields: FIELDS,
  readable: new Set(FIELDS.map((field) => field.id).filter((id) => id !== F.cost)),
};
const ADMIN: ViewConfigContext = { fields: FIELDS, readable: new Set(FIELDS.map((f) => f.id)) };

function failure(run: () => unknown): { code: string; errors: { path: string; code: string }[] } {
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

describe('defaultViewConfig', () => {
  it.each<[ViewType, string[]]>([
    ['grid', ['summaries', 'color_rules']],
    ['kanban', ['kanban']],
    ['form', ['form']],
  ])('%s has the common keys plus %j', (type, extra) => {
    expect(Object.keys(defaultViewConfig(type, ADMIN)).sort()).toEqual(
      [
        'column_widths',
        'field_order',
        'filter',
        'frozen_count',
        'group',
        'hidden_fields',
        'record_detail',
        'row_height',
        'sort',
        'tree',
        ...extra,
      ].sort(),
    );
  });

  it('puts every writable readable field on a new form, required as in the table', () => {
    const form = defaultViewConfig('form', SALES).form;
    expect(form?.fields.map((item) => item.field)).toEqual([
      F.title,
      F.amount,
      F.status,
      F.tags,
      F.owner,
      F.owners,
      F.due,
    ]);
    expect(form?.fields[0]).toEqual({ field: F.title, required: true, label: null, help: null });
  });
});

describe('buildViewConfig: accepted input', () => {
  it('normalises a tuple filter to the DSL and keeps defaults for missing keys', () => {
    const config = buildViewConfig(
      'grid',
      {
        filter: { logic: 'and', conditions: [[F.status, '==', 'New']] },
        sort: [{ field: F.amount }],
        group: [{ field: F.status, direction: 'desc' }],
        column_widths: { [F.title]: 240 },
      },
      SALES,
      null,
    );
    expect(config.filter).toEqual({
      op: 'and',
      items: [{ field: F.status, operator: 'is', value: OPT_NEW }],
    });
    expect(config.sort).toEqual([{ field: F.amount, direction: 'asc' }]);
    expect(config.group).toEqual([{ field: F.status, direction: 'desc' }]);
    expect(config.column_widths).toEqual({ [F.title]: 240 });
    expect(config.row_height).toBe('short');
    expect(config.kanban).toBeUndefined();
  });

  it('replaces only the keys sent; lists keep the entries the saver cannot see', () => {
    const stored: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      filter: { op: 'and', items: [{ field: F.cost, operator: 'gt', value: 10 }] },
      hidden_fields: [F.cost, F.gone, F.amount],
      column_widths: { [F.cost]: 90, [F.amount]: 100 },
    };
    const next = buildViewConfig(
      'grid',
      { hidden_fields: [F.due], column_widths: { [F.title]: 300 } },
      SALES,
      stored,
    );
    // The filter was not sent: it stays, even on a field the saver cannot read.
    expect(next.filter).toEqual(stored.filter);
    expect(next.hidden_fields).toEqual([F.due, F.cost, F.gone]);
    expect(next.column_widths).toEqual({ [F.cost]: 90, [F.title]: 300 });
  });

  it('accepts a kanban grouped by a single select or a single user', () => {
    for (const field of [F.status, F.owner]) {
      const config = buildViewConfig('kanban', { kanban: { group_field: field } }, ADMIN, null);
      expect(config.kanban).toEqual({
        group_field: field,
        card_fields: [],
        cover_field: null,
        hide_empty_columns: false,
      });
    }
  });

  it('keeps "hide empty columns" of a kanban until it is sent again', () => {
    const hidden = buildViewConfig('kanban', { kanban: { hide_empty_columns: true } }, ADMIN, null);
    expect(hidden.kanban?.hide_empty_columns).toBe(true);
    const next = buildViewConfig('kanban', { kanban: { card_fields: [F.title] } }, ADMIN, hidden);
    expect(next.kanban).toMatchObject({ card_fields: [F.title], hide_empty_columns: true });
  });

  it('forces table-required fields to be required on the form', () => {
    const config = buildViewConfig(
      'form',
      {
        form: { title: 'Order', fields: [{ field: F.title }, { field: F.amount, required: true }] },
      },
      SALES,
      null,
    );
    expect(config.form?.title).toBe('Order');
    expect(config.form?.fields).toEqual([
      { field: F.title, required: true, label: null, help: null },
      { field: F.amount, required: true, label: null, help: null },
    ]);
  });
});

describe('buildViewConfig: rejected input', () => {
  it.each<[string, ViewType, unknown, string, { path: string; code: string }[]]>([
    [
      'filter on a field the saver cannot read (P08)',
      'grid',
      { filter: { op: 'and', items: [{ field: F.cost, operator: 'gt', value: 1 }] } },
      'INVALID_FILTER',
      [{ path: 'config.filter.items[0].field', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'filter on a field of another table',
      'grid',
      { filter: { field: F.other, operator: 'is_empty' } },
      'INVALID_FILTER',
      [{ path: 'config.filter.field', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'sort on a hidden field',
      'grid',
      { sort: [{ field: F.amount }, { field: F.cost }] },
      'INVALID_SORT',
      [{ path: 'config.sort[1].field', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'the same group field twice',
      'grid',
      { group: [{ field: F.status }, { field: F.status }] },
      'INVALID_SORT',
      [{ path: 'config.group[1].field', code: 'DUPLICATE_FIELD' }],
    ],
    [
      'more than 3 group levels',
      'grid',
      { group: [F.title, F.amount, F.status, F.due].map((field) => ({ field })) },
      'VALIDATION_FAILED',
      [{ path: 'config.group', code: 'TOO_BIG' }],
    ],
    [
      'hidden field of another table',
      'grid',
      { hidden_fields: [F.other] },
      'VALIDATION_FAILED',
      [{ path: 'config.hidden_fields[0]', code: 'UNKNOWN_FIELD' }],
    ],
    [
      'width of a hidden field',
      'grid',
      { column_widths: { [F.cost]: 100 } },
      'VALIDATION_FAILED',
      [{ path: `config.column_widths.${F.cost}`, code: 'UNKNOWN_FIELD' }],
    ],
    [
      'kanban settings on a grid',
      'grid',
      { kanban: { group_field: null } },
      'VALIDATION_FAILED',
      [{ path: 'config.kanban', code: 'UNRECOGNIZED_KEY' }],
    ],
    [
      'kanban grouped by a multiple select',
      'kanban',
      { kanban: { group_field: F.tags } },
      'VALIDATION_FAILED',
      [{ path: 'config.kanban.group_field', code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'kanban grouped by a multiple user field',
      'kanban',
      { kanban: { group_field: F.owners } },
      'VALIDATION_FAILED',
      [{ path: 'config.kanban.group_field', code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'kanban cover that is not an attachment',
      'kanban',
      { kanban: { cover_field: F.title } },
      'VALIDATION_FAILED',
      [{ path: 'config.kanban.cover_field', code: 'INVALID_FIELD_TYPE' }],
    ],
    [
      'form with a computed field',
      'form',
      { form: { fields: [{ field: F.title }, { field: F.number }] } },
      'VALIDATION_FAILED',
      [{ path: 'config.form.fields[1].field', code: 'FIELD_READ_ONLY' }],
    ],
    [
      'form without a required field',
      'form',
      { form: { fields: [{ field: F.amount }] } },
      'VALIDATION_FAILED',
      [{ path: 'config.form.fields', code: 'REQUIRED_FIELD_MISSING' }],
    ],
    [
      'form redirect that is not http(s)',
      'form',
      { form: { redirect_url: 'javascript:alert(1)' } },
      'VALIDATION_FAILED',
      [{ path: 'config.form.redirect_url', code: 'INVALID_FORMAT' }],
    ],
  ])('%s', (_name, type, input, code, errors) => {
    const result = failure(() => buildViewConfig(type, input, SALES, null));
    expect(result.code).toBe(code);
    expect(result.errors).toEqual(errors.map((error) => expect.objectContaining(error) as unknown));
  });
});

describe('link fields in a view (T401)', () => {
  const LINK = 'fld_LinkAAAAAAAAAAAA';
  const withLink: ViewConfigContext = {
    fields: [
      ...FIELDS,
      {
        id: LINK,
        name: 'customer',
        type: 'link',
        options: { link_table: 'tbl_CustomersAAAAAAA' },
        required: false,
      },
    ],
    readable: new Set([...FIELDS.map((field) => field.id), LINK]),
  };

  it.each([['sort'], ['group']])('refuses to %s on a link field (INVALID_SORT)', (key) => {
    expect(
      failure(() => buildViewConfig('grid', { [key]: [{ field: LINK }] }, withLink, null)),
    ).toEqual({
      code: 'INVALID_SORT',
      errors: [{ path: `config.${key}[0].field`, code: 'FIELD_NOT_SORTABLE' }],
    });
  });

  it('asks link questions on forms since T410', () => {
    const form = defaultViewConfig('form', withLink).form;
    expect(form?.fields.map((field) => field.field)).toContain(LINK);
    const saved = buildViewConfig(
      'form',
      { form: { fields: [{ field: F.title }, { field: LINK }] } },
      withLink,
      null,
    );
    expect(saved.form?.fields.map((field) => field.field)).toEqual([F.title, LINK]);
  });
});

describe('form submission settings (T306, S3 decision 9)', () => {
  const form = (input: Record<string, unknown>, stored: StoredViewConfig | null = null) =>
    buildViewConfig('form', { form: input }, ADMIN, stored).form;

  it('starts without login and without a limit', () => {
    expect(form({})).toMatchObject({
      require_login: false,
      submission_limit: 'none',
      allow_multiple_submissions: true,
    });
  });

  it('keeps allow_multiple_submissions in step with submission_limit', () => {
    expect(form({ require_login: true, submission_limit: 'daily' })).toMatchObject({
      submission_limit: 'daily',
      allow_multiple_submissions: false,
    });
    expect(form({ require_login: true, allow_multiple_submissions: false })).toMatchObject({
      submission_limit: 'once',
      allow_multiple_submissions: false,
    });
    const weekly = buildViewConfig(
      'form',
      { form: { require_login: true, submission_limit: 'weekly' } },
      ADMIN,
      null,
    );
    expect(form({ allow_multiple_submissions: true }, weekly)).toMatchObject({
      submission_limit: 'none',
      allow_multiple_submissions: true,
    });
    expect(form({ title: 'Renamed' }, weekly)).toMatchObject({ submission_limit: 'weekly' });
  });

  it.each([
    [
      'a limit without require_login',
      { submission_limit: 'once' },
      'config.form.submission_limit',
      'REQUIRES_LOGIN',
    ],
    [
      'one submission without require_login',
      { allow_multiple_submissions: false },
      'config.form.submission_limit',
      'REQUIRES_LOGIN',
    ],
    [
      'contradicting keys',
      { require_login: true, submission_limit: 'daily', allow_multiple_submissions: true },
      'config.form.allow_multiple_submissions',
      'NOT_ALLOWED',
    ],
    [
      'an unknown limit',
      { submission_limit: 'hourly' },
      'config.form.submission_limit',
      'INVALID_VALUE',
    ],
  ])('rejects %s', (_name, input, path, code) => {
    const result = failure(() => form(input));
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.errors).toEqual([expect.objectContaining({ path, code })]);
  });

  it('reads older rows: allow_multiple_submissions = false means once', () => {
    const config = storedViewConfigOf('form', {
      form: { allow_multiple_submissions: false },
    });
    expect(config.form).toMatchObject({ submission_limit: 'once', require_login: false });
  });
});

describe('restrictViewConfig (responses: S3 decision 3)', () => {
  const stored: StoredViewConfig = {
    ...defaultViewConfig('kanban'),
    filter: {
      op: 'and',
      items: [
        { field: F.cost, operator: 'gt', value: 10 },
        { op: 'or', items: [{ field: F.gone, operator: 'is_empty' }] },
        { op: 'not', item: { field: F.cost, operator: 'is_empty' } },
        { field: F.amount, operator: 'lt', value: 5 },
      ],
    },
    sort: [
      { field: F.cost, direction: 'desc' },
      { field: F.amount, direction: 'asc' },
    ],
    group: [{ field: F.gone, direction: 'asc' }],
    hidden_fields: [F.cost, F.due],
    field_order: [F.gone, F.title],
    column_widths: { [F.cost]: 90, [F.title]: 200 },
    kanban: {
      group_field: F.cost,
      card_fields: [F.cost, F.title],
      cover_field: null,
      hide_empty_columns: true,
    },
  };

  it('leaves out every reference to unreadable or deleted fields', () => {
    const visible = new Set([...SALES.readable]);
    expect(restrictViewConfig(stored, visible)).toEqual({
      ...stored,
      filter: { op: 'and', items: [{ field: F.amount, operator: 'lt', value: 5 }] },
      sort: [{ field: F.amount, direction: 'asc' }],
      group: [],
      hidden_fields: [F.due],
      field_order: [F.title],
      column_widths: { [F.title]: 200 },
      kanban: {
        group_field: null,
        card_fields: [F.title],
        cover_field: null,
        hide_empty_columns: true,
      },
    });
  });

  it('returns no filter when every condition is hidden', () => {
    expect(
      pruneFilter({ op: 'and', items: [{ field: F.cost, operator: 'is_empty' }] }, () => false),
    ).toBeNull();
    // An empty group sent as such stays (it hides nothing).
    expect(pruneFilter({ op: 'and', items: [] }, () => false)).toEqual({ op: 'and', items: [] });
  });

  it('copies a view for someone else without what they cannot read', () => {
    const copy = copyViewConfig('kanban', stored, SALES);
    expect(copy.filter).toEqual({
      op: 'and',
      items: [{ field: F.amount, operator: 'lt', value: 5 }],
    });
    expect(copy.hidden_fields).toEqual([F.due]);
    expect(copy.kanban?.group_field).toBeNull();
  });
});

describe('storedViewConfigOf', () => {
  it('fills keys missing from older rows and drops settings of other types', () => {
    const config = storedViewConfigOf('grid', {
      row_height: 'tall',
      kanban: { group_field: null },
    });
    expect(config.row_height).toBe('tall');
    expect(config.sort).toEqual([]);
    expect(config.kanban).toBeUndefined();
    expect(storedViewConfigOf('form', null).form?.fields).toEqual([]);
  });
});

describe('filters with conditions the reader cannot read (S3 decision 3, T311)', () => {
  const hidden = (id: string) => id === F.cost;
  const visible = (id: string) => id !== F.cost && id !== F.gone;
  const costOver = { field: F.cost, operator: 'gt', value: 10 };
  const amountUnder = { field: F.amount, operator: 'lt', value: 5 };
  const statusNew = { field: F.status, operator: 'is', value: OPT_NEW };
  const goneEmpty = { field: F.gone, operator: 'is_empty' };

  it.each<[string, unknown, unknown, unknown]>([
    [
      'nothing hidden',
      { op: 'and', items: [amountUnder] },
      { op: 'and', items: [amountUnder] },
      null,
    ],
    [
      'one hidden condition of an and',
      { op: 'and', items: [costOver, amountUnder] },
      { op: 'and', items: [amountUnder] },
      { op: 'and', items: [costOver] },
    ],
    ['everything hidden', { op: 'and', items: [costOver] }, null, { op: 'and', items: [costOver] }],
    ['a hidden condition alone', costOver, null, costOver],
    [
      'an or holding a hidden condition is hidden whole',
      { op: 'and', items: [amountUnder, { op: 'or', items: [statusNew, costOver] }] },
      { op: 'and', items: [amountUnder] },
      { op: 'and', items: [{ op: 'or', items: [statusNew, costOver] }] },
    ],
    [
      'a not holding a hidden condition is hidden whole',
      { op: 'not', item: { op: 'and', items: [amountUnder, costOver] } },
      null,
      { op: 'not', item: { op: 'and', items: [amountUnder, costOver] } },
    ],
    [
      'nested and groups split condition by condition',
      { op: 'and', items: [{ op: 'and', items: [amountUnder, costOver] }] },
      { op: 'and', items: [{ op: 'and', items: [amountUnder] }] },
      { op: 'and', items: [{ op: 'and', items: [costOver] }] },
    ],
    [
      'deleted fields are neither shown nor kept',
      { op: 'and', items: [goneEmpty, { op: 'or', items: [goneEmpty, statusNew] }] },
      { op: 'and', items: [{ op: 'or', items: [statusNew] }] },
      null,
    ],
  ])('%s', (_, stored, shown, kept) => {
    expect(visibleFilterOf(stored, visible, hidden)).toEqual(shown);
    expect(hiddenFilterOf(stored, hidden)).toEqual(kept);
  });

  it('merges a saved filter back with the hidden part, flat', () => {
    expect(mergeHiddenFilter(null, null)).toBeNull();
    expect(mergeHiddenFilter({ op: 'and', items: [amountUnder] }, null)).toEqual({
      op: 'and',
      items: [amountUnder],
    });
    expect(mergeHiddenFilter(null, { op: 'and', items: [costOver] })).toEqual({
      op: 'and',
      items: [costOver],
    });
    expect(
      mergeHiddenFilter(
        { op: 'or', items: [amountUnder, statusNew] },
        { op: 'and', items: [costOver] },
      ),
    ).toEqual({ op: 'and', items: [{ op: 'or', items: [amountUnder, statusNew] }, costOver] });
  });

  it('keeps the hidden conditions when someone who cannot read them saves the filter', () => {
    const stored: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      filter: { op: 'and', items: [costOver, amountUnder] },
    };
    const next = buildViewConfig(
      'grid',
      { filter: { op: 'and', items: [statusNew] } },
      SALES,
      stored,
    );
    expect(next.filter).toEqual({ op: 'and', items: [statusNew, costOver] });
    // Clearing the filter clears only what the saver sees.
    expect(buildViewConfig('grid', { filter: null }, SALES, stored).filter).toEqual({
      op: 'and',
      items: [costOver],
    });
    // Someone who reads every field replaces it all.
    expect(buildViewConfig('grid', { filter: null }, ADMIN, stored).filter).toBeNull();
  });

  it('refuses a save whose merged filter exceeds the condition limit', () => {
    const stored: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      filter: { op: 'and', items: [costOver] },
    };
    const items = Array.from({ length: 50 }, (_, index) => ({
      field: F.amount,
      operator: 'gt',
      value: index,
    }));
    expect(
      failure(() => buildViewConfig('grid', { filter: { op: 'and', items } }, SALES, stored)),
    ).toEqual({
      code: 'INVALID_FILTER',
      errors: [{ path: 'config.filter', code: 'MAX_CONDITIONS_EXCEEDED' }],
    });
  });

  it('leaves an or holding a hidden condition out of responses when active fields are known', () => {
    const stored: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      filter: { op: 'and', items: [amountUnder, { op: 'or', items: [statusNew, costOver] }] },
    };
    const active = new Set<string>(FIELDS.map((field) => field.id));
    expect(restrictViewConfig(stored, new Set(SALES.readable), active).filter).toEqual({
      op: 'and',
      items: [amountUnder],
    });
  });
});

describe('record_detail.link_columns (T402, F§10.2)', () => {
  const LINK = 'fld_LinkAAAAAAAAAAAA';
  const LINK2 = 'fld_Link2AAAAAAAAAAA';
  const T = {
    name: 'fld_TName0000000000A',
    tier: 'fld_TTier0000000000A',
    secret: 'fld_TSecret00000000A',
    back: 'fld_TBack0000000000A',
    gone: 'fld_TGone0000000000A',
  } as const;
  const linkField = (id: string, name: string): ViewFieldMeta => ({
    id,
    name,
    type: 'link',
    options: { link_table: 'tbl_CustomersAAAAAAA' },
    required: false,
  });
  const fields = [...FIELDS, linkField(LINK, 'customer'), linkField(LINK2, 'buyer')];
  const targetFields = [T.name, T.tier, T.secret, T.back].map((id) => ({ id }));
  const context = (
    readable: readonly string[],
    targetReadable: readonly string[],
  ): ViewConfigContext => {
    const target = { fields: targetFields, readable: new Set(targetReadable) };
    return {
      fields,
      readable: new Set(readable),
      linkTargets: new Map([
        [LINK, target],
        [LINK2, target],
      ]),
    };
  };
  const all = fields.map((field) => field.id);
  const admin = context(all, [T.name, T.tier, T.secret, T.back]);
  // Reads the link but not `secret` of the linked table, nor `buyer`.
  const sales = context(
    all.filter((id) => id !== LINK2),
    [T.name, T.tier, T.back],
  );
  const withColumns = (linkColumns: Record<string, string[]>) =>
    buildViewConfig('grid', { record_detail: { link_columns: linkColumns } }, admin, null);

  it('defaults to no entry and reads older rows without the key', () => {
    expect(defaultViewConfig('grid').record_detail).toEqual({ link_columns: {} });
    expect(storedViewConfigOf('kanban', { frozen_count: 2 }).record_detail).toEqual({
      link_columns: {},
    });
  });

  it('stores the columns of each link field in the order sent', () => {
    expect(withColumns({ [LINK]: [T.tier, T.name, T.back] }).record_detail).toEqual({
      link_columns: { [LINK]: [T.tier, T.name, T.back] },
    });
  });

  it.each<[string, Record<string, string[]>, string, string]>([
    ['a field that does not exist', { [F.gone]: [T.name] }, `.${F.gone}`, 'UNKNOWN_FIELD'],
    ['a field that is not a link', { [F.title]: [T.name] }, `.${F.title}`, 'INVALID_FIELD_TYPE'],
    ['a column of another table', { [LINK]: [F.title] }, `.${LINK}[0]`, 'UNKNOWN_FIELD'],
    ['a deleted column', { [LINK]: [T.gone] }, `.${LINK}[0]`, 'UNKNOWN_FIELD'],
    ['a column listed twice', { [LINK]: [T.name, T.name] }, `.${LINK}[1]`, 'DUPLICATE_FIELD'],
  ])('rejects %s', (_, linkColumns, path, code) => {
    const result = failure(() => withColumns(linkColumns));
    expect(result).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: `config.record_detail.link_columns${path}`, code }],
    });
  });

  it.each<[string, Record<string, string[]>, string]>([
    ['a link field the saver cannot read', { [LINK2]: [T.name] }, `.${LINK2}`],
    ['a column the saver cannot read', { [LINK]: [T.secret] }, `.${LINK}[0]`],
  ])('treats %s as unknown', (_, linkColumns, path) => {
    const result = failure(() =>
      buildViewConfig('grid', { record_detail: { link_columns: linkColumns } }, sales, null),
    );
    expect(result.errors).toEqual([
      { path: `config.record_detail.link_columns${path}`, code: 'UNKNOWN_FIELD' },
    ]);
  });

  it('rejects unknown keys and more than 50 columns', () => {
    expect(
      failure(() => buildViewConfig('grid', { record_detail: { columns: {} } }, admin, null)).code,
    ).toBe('VALIDATION_FAILED');
    const many = Array.from({ length: 51 }, () => T.name);
    expect(failure(() => withColumns({ [LINK]: many })).code).toBe('VALIDATION_FAILED');
  });

  it('keeps what the saver cannot see when they save', () => {
    // Saved earlier by an admin; `gone` was deleted since.
    const stored: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      record_detail: { link_columns: { [LINK]: [T.secret, T.name, T.gone], [LINK2]: [T.tier] } },
    };
    const next = buildViewConfig(
      'grid',
      { record_detail: { link_columns: { [LINK]: [T.back] } } },
      sales,
      stored,
    );
    // `secret` (unreadable) and `gone` (deleted) stay after the sent columns; `buyer` stays whole.
    expect(next.record_detail.link_columns).toEqual({
      [LINK2]: [T.tier],
      [LINK]: [T.back, T.secret, T.gone],
    });
    // Sending no entry for a visible link removes it (default columns) but keeps unseen ones.
    const cleared = buildViewConfig('grid', { record_detail: { link_columns: {} } }, admin, next);
    expect(cleared.record_detail.link_columns).toEqual({});
    const salesCleared = buildViewConfig(
      'grid',
      { record_detail: { link_columns: { [LINK]: [] } } },
      sales,
      next,
    );
    expect(salesCleared.record_detail.link_columns).toEqual({
      [LINK2]: [T.tier],
      [LINK]: [T.secret, T.gone],
    });
  });

  it('shows a reader only the link fields and columns they read', () => {
    const stored = {
      ...withColumns({ [LINK]: [T.secret, T.name], [LINK2]: [T.tier] }),
    };
    stored.record_detail.link_columns[LINK]?.push(T.gone);
    const visible = new Set([...sales.readable]);
    expect(restrictViewConfig(stored, visible, undefined, sales.linkTargets).record_detail).toEqual(
      { link_columns: { [LINK]: [T.name] } },
    );
    // A reader of no column of the linked table gets no entry at all.
    const none = context(all, []);
    expect(
      restrictViewConfig(stored, new Set(all), undefined, none.linkTargets).record_detail,
    ).toEqual({ link_columns: {} });
    // Without linked table information no column is shown.
    expect(restrictViewConfig(stored, new Set(all)).record_detail).toEqual({ link_columns: {} });
  });

  it('copies a view for someone else without the columns they cannot read', () => {
    const stored = withColumns({ [LINK]: [T.secret, T.name], [LINK2]: [T.tier] });
    expect(copyViewConfig('grid', stored, sales).record_detail).toEqual({
      link_columns: { [LINK]: [T.name] },
    });
  });
});

describe('summaries (T472, CONTRACTS §15)', () => {
  it('saves functions the field types take; keeps entries the saver cannot see', () => {
    const stored = buildViewConfig('grid', { summaries: { [F.cost]: 'sum' } }, ADMIN, null);
    const saved = buildViewConfig(
      'grid',
      { summaries: { [F.amount]: 'avg', [F.due]: 'date_range', [F.tags]: 'unique' } },
      SALES,
      stored,
    );
    expect(saved.summaries).toEqual({
      [F.cost]: 'sum',
      [F.amount]: 'avg',
      [F.due]: 'date_range',
      [F.tags]: 'unique',
    });
  });

  it.each<[string, Record<string, string>, string, string]>([
    [
      'a text field takes no sum',
      { [F.title]: 'sum' },
      `config.summaries.${F.title}`,
      'INVALID_FIELD_TYPE',
    ],
    [
      'an auto number is text',
      { [F.number]: 'avg' },
      `config.summaries.${F.number}`,
      'INVALID_FIELD_TYPE',
    ],
    ['a hidden field', { [F.cost]: 'sum' }, `config.summaries.${F.cost}`, 'UNKNOWN_FIELD'],
    ['a deleted field', { [F.gone]: 'filled' }, `config.summaries.${F.gone}`, 'UNKNOWN_FIELD'],
  ])('refuses %s', (_label, summaries, path, code) => {
    expect(failure(() => buildViewConfig('grid', { summaries }, SALES, null))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path, code })],
    });
  });

  it('kanban and form views have no summaries', () => {
    expect(failure(() => buildViewConfig('kanban', { summaries: {} }, ADMIN, null)).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(defaultViewConfig('kanban')).not.toHaveProperty('summaries');
    expect(storedViewConfigOf('grid', {}).summaries).toEqual({});
  });

  it('reading: unreadable fields and functions no longer valid are left out', () => {
    const config: StoredViewConfig = {
      ...defaultViewConfig('grid'),
      summaries: { [F.amount]: 'sum', [F.cost]: 'sum', [F.title]: 'sum', [F.gone]: 'filled' },
    };
    const visible = new Set([...SALES.readable]);
    expect(restrictViewConfig(config, visible, undefined, undefined, FIELDS).summaries).toEqual({
      [F.amount]: 'sum',
    });
    // Without the field list only readability is checked.
    expect(restrictViewConfig(config, visible).summaries).toEqual({
      [F.amount]: 'sum',
      [F.title]: 'sum',
    });
  });
});
