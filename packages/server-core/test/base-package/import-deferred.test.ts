import { describe, expect, it } from 'vitest';

import {
  AppError,
  brokenRefsOf,
  checkImportedImage,
  computedImportOrder,
  importedDashboard,
  importedRoleConfig,
  isInvalidPackage,
  mentionedIds,
  mentionsAny,
  PackageLocation,
  reportDetached,
  roleSchemaOf,
  sortDetached,
  triggerTableOf,
  viewConfigContextOf,
  widgetTablesOf,
  type BaseSchemaRows,
  type FieldRow,
  type PlannedField,
  type PlannedTable,
} from '../../src/index.js';

import type { AutomationDefinition, BaseImportReport, Id } from '@cellhive/contracts';

const id = (prefix: string, label: string): string => `${prefix}_${label.padEnd(16, '0')}`;

const T = { things: id('tbl', 'Things') as Id<'tbl'>, gone: id('tbl', 'GoneTable') as Id<'tbl'> };
const F = {
  name: id('fld', 'Name') as Id<'fld'>,
  amount: id('fld', 'Amount') as Id<'fld'>,
  a: id('fld', 'FormulaA') as Id<'fld'>,
  b: id('fld', 'FormulaB') as Id<'fld'>,
  c: id('fld', 'FormulaC') as Id<'fld'>,
  gone: id('fld', 'Gone') as Id<'fld'>,
};

const TABLE = { id: T.things } as unknown as PlannedTable;

function planned(
  fieldId: Id<'fld'>,
  type: 'formula' | 'lookup',
  options: Record<string, unknown>,
  index: number,
): { table: PlannedTable; field: PlannedField } {
  return {
    table: TABLE,
    field: {
      id: fieldId,
      name: fieldId,
      kind: 'deferred',
      position: index,
      options,
      ai: null,
      location: PackageLocation.of('schema/tables.json').at('tables', 0, 'fields', index),
      source: {
        id: fieldId,
        name: fieldId,
        type,
        options,
        is_primary: false,
        required: false,
        unique_values: false,
        description: null,
        position: index,
        link_side: null,
        result_type: null,
      },
    },
  };
}

const formula = (fieldId: Id<'fld'>, expression: string, index: number) =>
  planned(fieldId, 'formula', { expression, style: null }, index);

function problemsOf(run: () => unknown): { path: string; code: string }[] {
  try {
    run();
  } catch (error) {
    if (isInvalidPackage(error)) {
      return (error.errors ?? []).map((item) => ({ path: item.path, code: item.code }));
    }
    throw error;
  }
  return [];
}

function emptyReport(): BaseImportReport {
  return {
    tables: 0,
    fields: 0,
    records: 0,
    links: 0,
    attachments: 0,
    views: 0,
    dashboards: 0,
    widgets: 0,
    automations: 0,
    roles: 0,
    unmatched_user_emails: [],
    unmatched_users: 0,
    automations_disabled: 0,
    secrets_to_reconnect: [],
    webhooks_to_recreate: [],
    ai_fields: [],
    skipped_personal_views: 0,
    files_skipped: [],
  };
}

function fieldRow(
  fieldId: Id<'fld'>,
  name: string,
  type: string,
  position: number,
  extra: Partial<FieldRow> = {},
): FieldRow {
  return {
    id: fieldId,
    table_id: T.things,
    name,
    type,
    options: {},
    required: false,
    position,
    deleted_at: null,
    compute_mode: null,
    result_type: null,
    ...extra,
  } as unknown as FieldRow;
}

const ROWS: BaseSchemaRows = {
  baseId: 'bse_Imported00000000',
  tables: [{ id: T.things }] as unknown as BaseSchemaRows['tables'],
  fields: [
    fieldRow(F.amount, 'Amount', 'number', 1),
    fieldRow(F.name, 'Name', 'text', 0),
    fieldRow(F.a, 'Double', 'formula', 2, {
      compute_mode: 'stored',
      result_type: { kind: 'number' },
    }),
  ],
};

describe('computedImportOrder (T1019)', () => {
  it('creates a field after every formula or lookup of the package it reads, else in package order', () => {
    const order = computedImportOrder([
      formula(F.a, `[${F.b}] + [${F.amount}]`, 0),
      formula(F.b, `[${F.c}] * 2`, 1),
      formula(F.c, `[${F.amount}]`, 2),
    ]);
    expect(order.map((step) => step.field.id)).toEqual([F.c, F.b, F.a]);
    expect(order.map((step) => step.reads)).toEqual([[], [F.c], [F.b]]);
  });

  it('follows the fields a lookup reads (select, where)', () => {
    const lookup = planned(
      F.a,
      'lookup',
      {
        from: T.things,
        select: F.b,
        where: { op: 'and', items: [{ field: F.c, operator: 'is_not_empty' }] },
        aggregate: 'raw_value',
      },
      0,
    );
    const order = computedImportOrder([lookup, formula(F.b, '1', 1), formula(F.c, '2', 2)]);
    expect(order.map((step) => step.field.id)).toEqual([F.b, F.c, F.a]);
  });

  it('refuses fields reading each other or themselves (INVALID_DEFINITION, each one)', () => {
    expect(
      problemsOf(() =>
        computedImportOrder([
          formula(F.a, `[${F.b}]`, 0),
          formula(F.b, `[${F.a}]`, 1),
          formula(F.c, `[${F.c}] + 1`, 2),
        ]),
      ),
    ).toEqual([
      { path: 'schema/tables.json#/tables/0/fields/0/options', code: 'INVALID_DEFINITION' },
      { path: 'schema/tables.json#/tables/0/fields/1/options', code: 'INVALID_DEFINITION' },
      { path: 'schema/tables.json#/tables/0/fields/2/options', code: 'INVALID_DEFINITION' },
    ]);
  });
});

describe('brokenRefsOf (T1019): what a definition names that the package does not hold', () => {
  const phantoms = new Set<string>([F.gone, T.gone]);
  const cases: [string, ReturnType<typeof planned>, ReadonlySet<string>, unknown][] = [
    ['a formula of present fields', formula(F.a, `[${F.amount}] * 2`, 0), new Set(), null],
    [
      'a formula naming a missing field',
      formula(F.a, `[${F.gone}] + [${F.amount}]`, 0),
      new Set(),
      [{ kind: 'field', id: F.gone }],
    ],
    [
      'a formula reading a field imported broken',
      formula(F.a, `[${F.b}] + 1`, 0),
      new Set([F.b]),
      [{ kind: 'field', id: F.b }],
    ],
    [
      'a lookup from a missing table',
      planned(F.a, 'lookup', { from: T.gone, select: F.amount, where: {} }, 0),
      new Set(),
      [{ kind: 'table', id: T.gone }],
    ],
  ];
  for (const [name, item, broken, expected] of cases) {
    it(name, () => {
      expect(brokenRefsOf(item.field, phantoms, broken)).toEqual(expected);
    });
  }
});

describe('mentionsAny / mentionedIds (T1019)', () => {
  const ids = new Set<string>([F.gone, T.gone]);
  it.each([
    ['an id as a value', { field: F.gone }, true],
    ['an id inside a text (a prompt)', { prompt: `Sum {{ [${F.gone}] }}` }, true],
    ['an id as a key', { tables: { [T.gone]: {} } }, true],
    ['nested in lists', [[{ items: [{ field: F.gone }] }]], true],
    ['nothing of it', { field: F.amount, other: [1, null, true] }, false],
  ])('%s', (_name, value, expected) => {
    expect(mentionsAny(value, ids)).toBe(expected);
  });

  it('nothing to look for: never', () => {
    expect(mentionsAny({ field: F.gone }, new Set())).toBe(false);
  });

  it('lists the ids found, sorted', () => {
    expect(mentionedIds({ a: T.gone, b: `[${F.gone}]` }, ids)).toEqual([F.gone, T.gone].sort());
  });
});

describe('reportDetached / sortDetached (T1019)', () => {
  it('lists each secret, identity, group and webhook once, with every automation using it', () => {
    const report = emptyReport();
    const one = { id: id('aut', 'One') as Id<'aut'>, name: 'One' };
    const two = { id: id('aut', 'Two') as Id<'aut'>, name: 'Two' };
    reportDetached(report, one, [
      { path: 'actions[0].config.secret_id', kind: 'secret', name: 'Bot' },
      { path: 'actions[1].config.secret_id', kind: 'secret', name: 'Bot' },
      { path: 'trigger.incoming_webhook_id', kind: 'incoming_webhook', name: 'Shop' },
    ]);
    reportDetached(report, two, [
      { path: 'actions[0].config.identity_id', kind: 'email_identity', name: 'Support <s@x.vn>' },
      { path: 'actions[1].config.recipients[0].group_id', kind: 'group', name: 'Sales' },
      { path: 'actions[2].config.secret_id', kind: 'secret', name: 'Bot' },
    ]);
    sortDetached(report);
    expect(report.secrets_to_reconnect).toEqual([
      { kind: 'email_identity', name: 'Support <s@x.vn>', automations: [two] },
      { kind: 'group', name: 'Sales', automations: [two] },
      { kind: 'secret', name: 'Bot', automations: [one, two] },
    ]);
    expect(report.webhooks_to_recreate).toEqual([
      { kind: 'incoming_webhook', name: 'Shop', automations: [one] },
    ]);
  });
});

describe('triggerTableOf (T1019)', () => {
  const views = new Map([[id('viw', 'Form'), T.things]]);
  it.each([
    ['schedule', { type: 'schedule', cron: '0 8 * * *' }, null],
    ['webhook.received', { type: 'webhook.received', incoming_webhook_id: null }, null],
    ['form.submitted', { type: 'form.submitted', view_id: id('viw', 'Form') }, T.things],
    [
      'form.submitted of an unknown view',
      { type: 'form.submitted', view_id: id('viw', 'X') },
      null,
    ],
    ['record.created', { type: 'record.created', table_id: T.things }, T.things],
  ])('%s', (_name, trigger, expected) => {
    const definition = { trigger, condition: null, actions: [] } as unknown as AutomationDefinition;
    expect(triggerTableOf(definition, views)).toBe(expected);
  });
});

describe('checkImportedImage (T1019): covers and email images, checked like their uploads', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const base = {
    filename: 'cover.png',
    mime: 'image/png',
    size: 100,
    head: PNG,
    maxBytes: 1000,
    types: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  };
  it.each([
    ['a PNG', {}, { ok: true, mime: 'image/png' }],
    [
      'a type that is not a raster image',
      { mime: 'image/svg+xml' },
      { ok: false, reason: 'blocked_file_type' },
    ],
    ['over its cap', { size: 1001 }, { ok: false, reason: 'file_too_large' }],
    [
      'content that is not its type',
      { head: Buffer.from('%PDF-1.7') },
      { ok: false, reason: 'content_mismatch' },
    ],
    ['no content', { head: Buffer.alloc(0) }, { ok: false, reason: 'content_mismatch' }],
    ['a name with a path', { filename: '../x/cover.png' }, { ok: true }],
  ])('%s', (_name, input, expected) => {
    const decision = checkImportedImage({ ...base, ...input });
    expect(decision).toMatchObject(expected);
    expect(decision.filename).not.toContain('/');
  });
});

describe('importedRoleConfig (T1019)', () => {
  const dashboard = id('dsh', 'Dash') as Id<'dsh'>;
  const schema = roleSchemaOf(ROWS, new Map([[T.things, [id('viw', 'Grid') as Id<'viw'>]]]), [
    dashboard,
  ]);
  const rule = (filterField: string) => ({
    perm: 'read_only',
    record_rule: {
      read_scope: 'filter',
      read_filter: { op: 'and', items: [{ field: filterField, operator: 'gt', value: 1 }] },
    },
  });

  it('checks a config as when saved; dashboards the base does not have are left out', () => {
    const config = importedRoleConfig(
      {
        tables: { [T.things]: rule(F.amount) },
        dashboards: { [dashboard]: 'read_only', [id('dsh', 'Other')]: 'read_only' },
      },
      schema,
      new Set(),
    );
    expect(config.dashboards).toEqual({ [dashboard]: 'read_only' });
    expect(config.tables[T.things]?.record_rule.read_filter).toEqual({
      op: 'and',
      items: [{ field: F.amount, operator: 'gt', value: 1 }],
    });
  });

  it('keeps a rule naming what the package does not hold, its shape checked', () => {
    const config = importedRoleConfig(
      { tables: { [T.things]: rule(F.gone) } },
      schema,
      new Set([F.gone]),
    );
    expect(config.tables[T.things]?.record_rule.read_filter).toEqual({
      op: 'and',
      items: [{ field: F.gone, operator: 'gt', value: 1 }],
    });
  });

  it('refuses a config naming a table of nowhere, or of a shape it does not know', () => {
    expect(() =>
      importedRoleConfig({ tables: { [T.gone]: rule(F.amount) } }, schema, new Set()),
    ).toThrow(AppError);
    expect(() => importedRoleConfig({ tables: 'all' }, schema, new Set([F.gone]))).toThrow(
      AppError,
    );
  });

  it('marks formula and AI fields as computed for the role check', () => {
    const fields = schema.tables[0]?.fields ?? [];
    expect(fields.find((field) => field.id === F.a)?.computed).toBe(true);
    expect(fields.find((field) => field.id === F.amount)?.computed).toBeUndefined();
  });
});

describe('importedDashboard (T1019)', () => {
  const at = PackageLocation.of('schema/dashboards.json').at('dashboards', 0);
  const tables = widgetTablesOf(ROWS);
  const kpi = (widgetId: string, fieldId: string, x: number) => ({
    id: widgetId as Id<'wgt'>,
    type: 'kpi' as const,
    title: ` ${widgetId} `,
    config: { table_id: T.things, metrics: [{ id: 'm1', aggregation: 'sum', field: fieldId }] },
    layout: { x, y: 0, w: 4, h: 3 },
  });
  const dashboard = (widgets: ReturnType<typeof kpi>[], globalFilters: unknown[] = []) => ({
    id: id('dsh', 'Dash') as Id<'dsh'>,
    name: 'Numbers',
    icon: null,
    description: null,
    theme: {},
    global_filters: globalFilters,
    position: 3,
    widgets,
  });

  it('checks every widget against the base; one naming a missing field keeps its config', () => {
    const input = importedDashboard(
      dashboard([kpi(id('wgt', 'Ok'), F.amount, 0), kpi(id('wgt', 'Stale'), F.gone, 4)]),
      0,
      at,
      tables,
      new Set([F.gone]),
    );
    expect(input.position).toBe(0);
    expect(input.widgets.map((widget) => widget.title)).toEqual([
      id('wgt', 'Ok'),
      id('wgt', 'Stale'),
    ]);
    expect(input.widgets[1]?.config).toMatchObject({ metrics: [{ field: F.gone }] });
  });

  it('leaves out a global filter target naming a missing field', () => {
    const input = importedDashboard(
      dashboard(
        [],
        [
          {
            id: 'f1',
            label: null,
            kind: 'text',
            targets: [{ table_id: T.things, field: F.gone }],
          },
          {
            id: 'f2',
            label: null,
            kind: 'text',
            targets: [{ table_id: T.things, field: F.name }],
          },
        ],
      ),
      0,
      at,
      tables,
      new Set([F.gone]),
    );
    expect(input.globalFilters.map((filter) => filter['id'])).toEqual(['f2']);
  });

  it('refuses widgets that overlap, and a widget of a field that does not fit', () => {
    expect(
      problemsOf(() =>
        importedDashboard(
          dashboard([kpi(id('wgt', 'A'), F.amount, 0), kpi(id('wgt', 'B'), F.amount, 2)]),
          0,
          at,
          tables,
          new Set(),
        ),
      ),
    ).toEqual([
      { path: 'schema/dashboards.json#/dashboards/0/widgets', code: 'INVALID_DEFINITION' },
    ]);
    expect(
      problemsOf(() =>
        importedDashboard(dashboard([kpi(id('wgt', 'A'), F.name, 0)]), 0, at, tables, new Set()),
      ),
    ).toEqual([
      { path: 'schema/dashboards.json#/dashboards/0/widgets/0/config', code: 'INVALID_DEFINITION' },
    ]);
  });
});

describe('viewConfigContextOf (T1019)', () => {
  it('lists the active fields of the table in display order, every one readable', () => {
    const context = viewConfigContextOf(ROWS, T.things);
    expect(context.fields.map((field) => field.id)).toEqual([F.name, F.amount, F.a]);
    expect([...context.readable].sort()).toEqual([F.a, F.amount, F.name].sort());
    expect(context.fields[2]).toMatchObject({ result_type: { kind: 'number' } });
    expect(context.locked?.size).toBe(0);
  });
});
