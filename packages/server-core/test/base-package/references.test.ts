import {
  automationDefinitionSchema,
  dashboardGlobalFiltersSchema,
  isId,
  VIEW_CONFIG_INPUT_SCHEMAS,
  WIDGET_CONFIG_SCHEMAS,
  type Id,
  type WidgetType,
} from '@cellhive/contracts';
import {
  datetimeOptionsSchema,
  formulaOptionsSchema,
  linkOptionsSchema,
  lookupOptionsSchema,
  selectOptionsSchema,
  textOptionsSchema,
  userOptionsSchema,
} from '@cellhive/field-types';
import { filterNodeSchema } from '@cellhive/filter-dsl';
import { parse } from '@cellhive/formula-engine';
import { roleConfigSchema } from '@cellhive/permissions';
import { describe, expect, it } from 'vitest';

import {
  assignPackageIds,
  formulaReferences,
  PackageIdMap,
  PackageLocation,
  PackageProblems,
  PackageRewriter,
  PackageSchemaCatalog,
  PackageUserEmails,
  PackageUserMatcher,
  type PackageIdResolver,
} from '../../src/base-package/index.js';

import {
  A,
  ATT,
  automations,
  C1,
  D1,
  dashboards,
  F,
  files,
  FOREIGN,
  GONE_EMAIL,
  id,
  idsIn,
  mainDefinition,
  MEMBER_EMAIL,
  O,
  R,
  record,
  recordIds,
  ROLE,
  roles,
  T_CUS,
  T_ORD,
  tables,
  V,
  views,
  W,
} from './fixture.js';

/**
 * The reference rewrite of every shape of the S9 research §2.3 (BACKLOG
 * T1016): each id of the package is replaced by the id the map gives it,
 * none is left, users become members of the target organization, and the
 * result is still a valid stored shape.
 */

const MEMBER_ID = id('usr', 'Member') as Id<'usr'>;
const at = (entry: string) => PackageLocation.of(entry);

function importSetup() {
  const problems = new PackageProblems();
  const map = new PackageIdMap();
  assignPackageIds(
    map,
    { tables, views, dashboards, automations, roles, files, missingIds: [] },
    problems,
  );
  for (const record of recordIds) map.assign(record);
  const users = new PackageUserMatcher([{ id: MEMBER_ID, email: 'An@Example.COM' }]);
  const rewriter = new PackageRewriter({
    direction: 'import',
    ids: map,
    users,
    catalog: new PackageSchemaCatalog({ tables }),
    problems,
  });
  return { map, users, rewriter, problems };
}

/** The package ids of `input` that must all be gone from `output`. */
const PACKAGE_KINDS = /^(?:tbl|fld|opt|viw|clr|dsh|wgt|aut|rol|rec|att)_/u;
const FOREIGN_KINDS = /^(?:sec|eid|grp|hok)_/u;

function expectNoOldIds(input: unknown, output: unknown): void {
  const old = new Set(idsIn(input).filter((value) => PACKAGE_KINDS.test(value)));
  const left = idsIn(output);
  expect(left.filter((value) => old.has(value))).toEqual([]);
  expect(left.filter((value) => FOREIGN_KINDS.test(value))).toEqual([]);
  const text = JSON.stringify(output);
  expect(text).not.toContain(MEMBER_EMAIL);
  expect(text).not.toContain(GONE_EMAIL);
}

describe('assignPackageIds', () => {
  it('gives every object a new id of its prefix, options per select field', () => {
    const { map, problems } = importSetup();
    expect(problems.size).toBe(0);
    for (const value of [T_ORD, F.status, V.grid, C1, D1, W.bar, A.main, ROLE, ATT.file, R.one]) {
      const mapped = map.resolve(value);
      expect(mapped).not.toBeNull();
      expect(mapped).not.toBe(value);
      expect(mapped?.slice(0, 4)).toBe(value.slice(0, 4));
    }
    expect(map.resolve(O.new)).toBeNull();
    expect(map.resolve(O.new, F.status)).toMatch(/^opt_/u);
    expect(map.resolve(O.new, F.tags)).toBeNull();
    expect(map.resolve('tbl_unknown000000000')).toBeNull();
  });

  it('reports two definitions of one id as DUPLICATE_ID', () => {
    const problems = new PackageProblems();
    assignPackageIds(
      new PackageIdMap(),
      { roles: [...roles, ...roles], missingIds: [ROLE] },
      problems,
    );
    expect(problems.list()).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_ID', path: 'schema/roles.json#/roles/1/id' }),
      expect.objectContaining({ code: 'DUPLICATE_ID', path: 'schema/base.json#/missing_ids/0' }),
    ]);
  });

  it('lets an option id repeat across select fields', () => {
    const problems = new PackageProblems();
    const map = new PackageIdMap();
    const twin = {
      ...tables[0],
      fields: [
        { id: id('fld', 'One'), type: 'select', options: { options: [{ id: O.new, name: 'x' }] } },
        { id: id('fld', 'Two'), type: 'select', options: { options: [{ id: O.new, name: 'x' }] } },
      ],
    };
    assignPackageIds(map, { tables: [twin] }, problems);
    expect(problems.size).toBe(0);
    expect(map.resolve(O.new, id('fld', 'One'))).not.toBe(map.resolve(O.new, id('fld', 'Two')));
  });
});

describe('formulaReferences', () => {
  it('walks long chains without recursion', () => {
    const expression = Array.from({ length: 5000 }, () => `[${F.price}]`).join(' + ');
    expect(formulaReferences(parse(expression, { form: 'stored' }))).toHaveLength(5000);
  });
});

describe('import: field options per type', () => {
  const fieldOf = (fieldId: string) => {
    const field = tables.flatMap((table) => table.fields).find((item) => item.id === fieldId);
    if (field === undefined) throw new Error(fieldId);
    return field;
  };

  const cases = [
    ['select (options, default, AI prompt)', F.status, selectOptionsSchema],
    ['multiple select (default list)', F.tags, selectOptionsSchema],
    ['user (default users)', F.owner, userOptionsSchema],
    ['datetime (reminder to users)', F.due, datetimeOptionsSchema],
    ['datetime (reminder to a user field)', F.due2, datetimeOptionsSchema],
    ['link (table, reverse field, record filter)', F.customer, linkOptionsSchema],
    ['formula (AST references)', F.total, formulaOptionsSchema],
    ['lookup (from, select, where, field_ref)', F.tier, lookupOptionsSchema],
    ['text (options.ai prompt)', F.summary, textOptionsSchema],
  ] as const;

  it.each(cases)('%s: every id changed, none missed, still valid', (_name, fieldId, schema) => {
    const { rewriter, problems } = importSetup();
    const field = fieldOf(fieldId);
    const output = rewriter.fieldOptions(field, at('schema/tables.json'));
    expect(problems.list()).toEqual([]);
    expectNoOldIds(field.options, output);
    expect(schema.safeParse(output).success).toBe(true);
  });

  it('maps each slot to the id the map gives', () => {
    const { rewriter, map } = importSetup();
    const select = rewriter.fieldOptions(fieldOf(F.status), at('t')) as Record<string, unknown>;
    expect(select).toMatchObject({
      options: [{ id: map.resolve(O.new, F.status) }, { id: map.resolve(O.done, F.status) }],
      default_value: map.resolve(O.new, F.status),
      ai: { prompt: `Pick a status for {{ [${String(map.resolve(F.name))}] }}` },
    });
    const link = rewriter.fieldOptions(fieldOf(F.customer), at('t'));
    expect(link).toMatchObject({
      link_table: map.resolve(T_CUS),
      symmetric_field_id: map.resolve(F.orders),
      record_filter: {
        items: [
          { field: map.resolve(F.cusTier), value: [map.resolve(O.gold, F.cusTier)] },
          { field: map.resolve(F.orders), value: [map.resolve(R.one)] },
        ],
      },
    });
    const lookup = rewriter.fieldOptions(fieldOf(F.tier), at('t'));
    expect(lookup).toMatchObject({
      from: map.resolve(T_CUS),
      select: map.resolve(F.cusTier),
      where: {
        items: [
          { value: [map.resolve(O.gold, F.cusTier), map.resolve(O.silver, F.cusTier)] },
          { field: map.resolve(F.cusName), value: { field_ref: map.resolve(F.name) } },
        ],
      },
    });
  });

  it('rewrites only the references of a formula, at their place', () => {
    const { rewriter, map } = importSetup();
    const output = rewriter.fieldOptions(fieldOf(F.total), at('t')) as { expression: string };
    const name = (value: string) => String(map.resolve(value));
    expect(output.expression).toBe(
      `IF([${name(F.status)}] = "Done", [${name(F.price)}] * 2, LEN("[Price] stays text")) + ` +
        `COUNTIF([${name(F.customer)}].[${name(F.cusTier)}], CurrentValue = "Gold") + ` +
        `LET(x, [${name(T_CUS)}].[${name(F.cusName)}], LEN(x))`,
    );
  });

  it('users: members by email (any case), others left out; a reminder with nobody left is off', () => {
    const { rewriter, users } = importSetup();
    expect(rewriter.fieldOptions(fieldOf(F.owner), at('t'))).toMatchObject({
      default_value: [{ $slot: 'current_user' }, { id: MEMBER_ID }],
    });
    expect(rewriter.fieldOptions(fieldOf(F.due), at('t'))).toMatchObject({
      reminder: { user_ids: [MEMBER_ID] },
    });
    const lonely = {
      ...fieldOf(F.due),
      options: {
        reminder: {
          recipients: 'users',
          user_ids: [GONE_EMAIL],
          offset_minutes: 0,
          time_of_day: null,
        },
      },
    };
    expect(rewriter.fieldOptions(lonely, at('t'))).toEqual({ reminder: null });
    expect(users.unmatchedEmails(10)).toEqual({ emails: [GONE_EMAIL], total: 1 });
  });
});

describe('import: Filter DSL operands by the kind of their field', () => {
  it('options, users, records, field refs; $var and $date untouched', () => {
    const { rewriter, map, problems } = importSetup();
    const input = views[0]?.config.filter;
    const output = rewriter.filter(input, at('schema/views.json'));
    expect(problems.list()).toEqual([]);
    expectNoOldIds(input, output);
    expect(filterNodeSchema.safeParse(output).success).toBe(true);
    const items = (output as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toEqual({
      field: map.resolve(F.status),
      operator: 'is',
      value: map.resolve(O.new, F.status),
    });
    const owners = items[1]?.['value'] as string[];
    expect(owners[0]).toBe(MEMBER_ID);
    // Not a member: a new user id nobody has, so the condition keeps its meaning.
    expect(isId('usr', owners[1])).toBe(true);
    expect(owners[1]).not.toBe(MEMBER_ID);
    expect(items[2]).toMatchObject({ value: [map.resolve(R.cus)] });
    // A lookup of a select: options of the source field.
    expect(items[3]).toMatchObject({ value: [map.resolve(O.gold, F.cusTier)] });
    expect(items[4]).toEqual({
      op: 'not',
      item: { field: map.resolve(F.price), operator: 'gt', value: 3 },
    });
    expect(items[5]).toMatchObject({ value: { $date: { relative: 'today' } } });
    expect(items[6]).toMatchObject({ value: [{ $var: 'current_user' }] });
    expect(items[7]).toMatchObject({ field: map.resolve(F.created), value: [MEMBER_ID] });
  });

  it('the same missing email is the same new user everywhere', () => {
    const { rewriter } = importSetup();
    const filter = { field: F.owner, operator: 'has_any_of', value: [GONE_EMAIL] };
    const first = rewriter.filter(filter, at('a')) as { value: string[] };
    const second = rewriter.filter(filter, at('b')) as { value: string[] };
    expect(first.value[0]).toBe(second.value[0]);
  });
});

describe('import: views', () => {
  it.each(views.map((view) => [view.type, view] as const))(
    '%s view: every id changed, none missed, config still valid',
    (type, view) => {
      const { rewriter, problems } = importSetup();
      const output = rewriter.view(view, at('schema/views.json').at('views', 0)) as {
        config: Record<string, unknown>;
      };
      expect(problems.list()).toEqual([]);
      expectNoOldIds(view, output);
      const schema = VIEW_CONFIG_INPUT_SCHEMAS[type as keyof typeof VIEW_CONFIG_INPUT_SCHEMAS];
      expect(schema.safeParse(output.config).success).toBe(true);
    },
  );

  it('maps every key of a grid config', () => {
    const { rewriter, map } = importSetup();
    const output = rewriter.view(views[0], at('v')) as {
      id: string;
      table_id: string;
      config: unknown;
    };
    expect(output.id).toBe(map.resolve(V.grid));
    expect(output.table_id).toBe(map.resolve(T_ORD));
    expect(output.config).toMatchObject({
      sort: [{ field: map.resolve(F.price), direction: 'desc' }],
      group: [{ field: map.resolve(F.status) }],
      hidden_fields: [map.resolve(F.files)],
      field_order: [map.resolve(F.name), map.resolve(F.status)],
      column_widths: { [String(map.resolve(F.name))]: 240 },
      record_detail: {
        link_columns: {
          [String(map.resolve(F.customer))]: [map.resolve(F.cusName), map.resolve(F.cusTier)],
        },
      },
      summaries: { [String(map.resolve(F.price))]: 'sum' },
      color_rules: [
        {
          id: map.resolve(C1),
          field_id: map.resolve(F.status),
          filter: { field: map.resolve(F.status), value: map.resolve(O.done, F.status) },
        },
      ],
    });
    const form = rewriter.view(views[2], at('v')) as { config: { form: Record<string, unknown> } };
    expect(form.config.form).toMatchObject({
      cover_attachment_id: map.resolve(ATT.cover),
      fields: [{ field: map.resolve(F.name) }],
    });
  });

  it('an id the package does not define → DANGLING_REFERENCE at its place', () => {
    const { rewriter, problems } = importSetup();
    const view = {
      ...views[0],
      config: { ...views[0]?.config, sort: [{ field: id('fld', 'Nowhere'), direction: 'asc' }] },
    };
    rewriter.view(view, at('schema/views.json').at('views', 0));
    expect(problems.list()).toEqual([
      {
        path: 'schema/views.json#/views/0/config/sort/0/field',
        code: 'DANGLING_REFERENCE',
        message: 'The package names an id it does not define.',
        params: { id: id('fld', 'Nowhere') },
      },
    ]);
  });
});

describe('import: dashboards and widgets', () => {
  it('every id changed, none missed; each widget config still valid', () => {
    const { rewriter, map, problems } = importSetup();
    const dashboard = dashboards[0];
    const output = rewriter.dashboard(dashboard, at('schema/dashboards.json')) as {
      id: string;
      global_filters: unknown;
      widgets: { id: string; type: WidgetType; config: Record<string, unknown> }[];
    };
    expect(problems.list()).toEqual([]);
    expectNoOldIds(dashboard, output);
    expect(output.id).toBe(map.resolve(D1));
    expect(dashboardGlobalFiltersSchema.safeParse(output.global_filters).success).toBe(true);
    for (const widget of output.widgets) {
      expect(WIDGET_CONFIG_SCHEMAS[widget.type].safeParse(widget.config).success, widget.type).toBe(
        true,
      );
    }
    const byId = new Map(output.widgets.map((widget) => [widget.id, widget.config]));
    expect(byId.get(String(map.resolve(W.bar)))).toMatchObject({
      table_id: map.resolve(T_ORD),
      filter_bindings: [map.resolve(W.ctrl), map.resolve(W.user)],
      dimension: { field: map.resolve(F.status) },
      metrics: [{ field: map.resolve(F.price) }],
      display: {
        colors: {
          [String(map.resolve(O.new, F.status))]: '#ff0000',
          [String(map.resolve(O.done, F.status))]: '#00ff00',
          Other: '#0000ff',
        },
      },
    });
    expect(byId.get(String(map.resolve(W.barUser)))).toMatchObject({
      series_dimension: { field: map.resolve(F.tags) },
      display: {
        colors: { [MEMBER_ID]: '#111111', [String(map.resolve(O.a, F.tags))]: '#333333' },
      },
    });
    expect(byId.get(String(map.resolve(W.user)))).toMatchObject({
      parent_control_id: map.resolve(W.ctrl),
      default: { values: [MEMBER_ID, expect.stringMatching(/^usr_/u)] },
    });
    expect(byId.get(String(map.resolve(W.ctrl)))).toMatchObject({
      default: { values: [map.resolve(O.new, F.status)] },
    });
    expect(byId.get(String(map.resolve(W.kpi)))).toMatchObject({
      compare: { date_field: map.resolve(F.due) },
    });
    expect(byId.get(String(map.resolve(W.table)))).toMatchObject({
      table: {
        fields: [map.resolve(F.name), map.resolve(F.price)],
        sort: { field: map.resolve(F.price) },
      },
    });
  });

  it('a widget id outside the dashboard is dropped, as remapWidgetIds does', () => {
    const { rewriter } = importSetup();
    const dashboard = {
      ...dashboards[0],
      widgets: dashboards[0]?.widgets.filter((widget) => widget.id !== W.ctrl),
    };
    const output = rewriter.dashboard(dashboard, at('d')) as {
      widgets: { config: Record<string, unknown> }[];
    };
    const user = output.widgets.find((widget) => widget.config['control'] === 'user');
    expect(user?.config['parent_control_id']).toBeNull();
  });
});

describe('import: roles', () => {
  it('every id changed, none missed, config still valid; rule filters keep every condition', () => {
    const { rewriter, map, problems } = importSetup();
    const output = rewriter.role(roles[0], at('schema/roles.json')) as {
      id: string;
      config: unknown;
    };
    expect(problems.list()).toEqual([]);
    expectNoOldIds(roles[0], output);
    expect(output.id).toBe(map.resolve(ROLE));
    expect(roleConfigSchema.safeParse(output.config).success).toBe(true);
    const ord = String(map.resolve(T_ORD));
    expect(output.config).toMatchObject({
      tables: {
        [ord]: {
          view_rule: { visible_views: [map.resolve(V.grid), map.resolve(V.kanban)] },
          record_rule: {
            edit_filter: { field: map.resolve(F.owner), value: [MEMBER_ID] },
            read_filter: {
              items: [
                { value: [{ $var: 'current_user' }] },
                { value: map.resolve(O.done, F.status) },
              ],
            },
          },
          field_rule: {
            fields: {
              [String(map.resolve(F.price))]: 'read',
              [String(map.resolve(F.name))]: 'edit',
            },
            option_edit_fields: [map.resolve(F.status)],
            file_download_fields: [map.resolve(F.files)],
          },
        },
        [String(map.resolve(T_CUS))]: { view_rule: { visible_views: null } },
      },
      dashboards: { [String(map.resolve(D1))]: 'read_only' },
    });
  });
});

describe('import: automations', () => {
  it.each(automations.map((automation) => [automation.name, automation] as const))(
    '%s: every id changed, none missed',
    (_name, automation) => {
      const { rewriter, problems } = importSetup();
      const { automation: output } = rewriter.automation(
        automation,
        at('schema/automations.json').at('automations', 0),
      );
      expect(problems.list()).toEqual([]);
      expectNoOldIds(automation, output);
    },
  );

  it.each(
    automations
      .filter((item) => item.id !== A.main && item.id !== A.hook)
      .map((item) => [item.name, item] as const),
  )('%s: the definition is still valid', (_name, automation) => {
    const { rewriter } = importSetup();
    const { automation: output } = rewriter.automation(automation, at('a'));
    expect(automationDefinitionSchema.safeParse(output['definition']).success).toBe(true);
  });

  it('empties every secret, identity, group and hook slot, whatever the package holds there', () => {
    const { rewriter } = importSetup();
    const listed = [
      { path: 'actions[4].config.secret_id', kind: 'secret', name: 'Sales bot' },
      {
        path: 'actions[3].config.then[0].config.identity_id',
        kind: 'email_identity',
        name: 'Sales',
      },
    ];
    const { automation, detached } = rewriter.automation(
      { ...automations[0], detached: listed },
      at('a'),
    );
    expect(detached).toEqual([
      {
        path: 'actions[3].config.then[0].config.identity_id',
        kind: 'email_identity',
        name: 'Sales',
      },
      {
        path: 'actions[3].config.then[0].config.reply_to.identity_id',
        kind: 'email_identity',
        name: '',
      },
      { path: 'actions[3].config.else[0].config.recipients[1].group_id', kind: 'group', name: '' },
      { path: 'actions[4].config.secret_id', kind: 'secret', name: 'Sales bot' },
      { path: 'actions[5].config.auth.secret_id', kind: 'secret', name: '' },
      { path: 'actions[5].config.signing_secret_id', kind: 'secret', name: '' },
      { path: 'actions[6].config.signing_secret_id', kind: 'secret', name: '' },
    ]);
    const definition = automation['definition'] as typeof mainDefinition;
    const [, , , branch, telegram, http] = definition.actions;
    expect(telegram?.config).toMatchObject({ secret_id: null });
    expect(http?.config).toMatchObject({
      auth: { header_name: 'Authorization', secret_id: null },
      signing_secret_id: null,
    });
    expect(branch?.config).toMatchObject({
      then: [{ config: { identity_id: null, reply_to: null } }],
      else: [
        {
          config: {
            recipients: [
              { user_ids: [MEMBER_ID, expect.stringMatching(/^usr_/u)] },
              { group_id: null },
              { field: expect.any(String) as unknown },
            ],
          },
        },
      ],
    });
    const hook = rewriter.automation(automations[1], at('a'));
    expect(hook.detached).toEqual([
      { path: 'trigger.incoming_webhook_id', kind: 'incoming_webhook', name: '' },
    ]);
    expect(hook.automation['definition']).toMatchObject({ trigger: { incoming_webhook_id: null } });
  });

  it('maps values, templates, step paths, literals by target field, digests and body images', () => {
    const { rewriter, map } = importSetup();
    const { automation } = rewriter.automation(automations[0], at('a'));
    const definition = automation['definition'] as typeof mainDefinition;
    const n = (value: string, owner?: string) => String(map.resolve(value, owner));
    expect(definition.trigger).toEqual({
      type: 'record.updated',
      table_id: n(T_ORD),
      watch_fields: [n(F.status), n(F.price)],
    });
    expect(definition.condition).toEqual({
      field: n(F.status),
      operator: 'changed_to',
      value: n(O.done, F.status),
    });
    const [find, update, many, branch, , , , , , , create] = definition.actions;
    expect(find?.config).toMatchObject({
      table_id: n(T_CUS),
      sort: [{ field: n(F.cusName) }],
      fields: [n(F.cusName)],
    });
    expect(update?.config).toMatchObject({
      record_id: { literal: n(R.two) },
      fields: {
        [n(F.status)]: { literal: n(O.new, F.status) },
        [n(F.tags)]: { literal: [n(O.a, F.tags), n(O.b, F.tags)] },
        [n(F.owner)]: { literal: [MEMBER_ID] },
        [n(F.name)]: { template: `Hi {{ [act_1].[${n(F.cusName)}] }} {{ [@actor] }}` },
        [n(F.price)]: { step: 'act_1', path: `records[0].fields.${n(F.cusName)}` },
        [n(F.customer)]: { literal: [n(R.cus)] },
      },
    });
    expect(many?.config).toMatchObject({ filter: { value: { field: n(F.customer) } } });
    const email = (branch?.config as { then: { config: Record<string, unknown> }[] }).then[0]
      ?.config;
    expect(email).toMatchObject({
      to: [{ literal: 'buyer@example.org' }, { field: n(F.owner) }],
      bcc: [{ step: 'act_1', path: `records[0].fields.${n(F.cusName)}` }],
      body: {
        template: `See ![logo](asset:${n(ATT.asset)}) and {{ [@digest] }} for {{ [${n(F.name)}] }}`,
        digest: { row_template: `- {{ [${n(F.cusName)}] }}` },
      },
      attachments: [{ field: n(F.files) }],
    });
    expect(create?.config).toMatchObject({
      table_id: n(T_CUS),
      fields: { [n(F.cusTier)]: { literal: n(O.gold, F.cusTier) } },
    });
  });

  it('an action this version does not know → INVALID_DEFINITION', () => {
    const { rewriter, problems } = importSetup();
    rewriter.automation(
      {
        ...automations[0],
        definition: {
          ...mainDefinition,
          actions: [{ id: 'act_1', type: 'launch_rocket', config: {} }],
        },
      },
      at('schema/automations.json').at('automations', 0),
    );
    expect(problems.list()).toMatchObject([
      {
        code: 'INVALID_DEFINITION',
        path: 'schema/automations.json#/automations/0/definition/actions/0/type',
      },
    ]);
  });

  it('a template or formula that does not parse → INVALID_DEFINITION', () => {
    const { rewriter, problems } = importSetup();
    rewriter.template('{{ [fld_broken', at('x'));
    rewriter.formula('[Name] +', at('y'));
    rewriter.template('{{ [Name] }}', at('z'));
    expect(problems.list().map((item) => [item.code, item.path])).toEqual([
      ['INVALID_DEFINITION', 'x'],
      ['INVALID_DEFINITION', 'y'],
      ['INVALID_DEFINITION', 'z'],
    ]);
  });
});

describe('import: records, links, files, tables', () => {
  it('record values by field type; users by email; created/updated by', () => {
    const { rewriter, map, problems } = importSetup();
    const fields = rewriter.recordFields(record.fields, T_ORD, at('data/x.ndjson'));
    expect(problems.list()).toEqual([]);
    expectNoOldIds(record.fields, fields);
    const n = (value: string, owner?: string) => String(map.resolve(value, owner));
    expect(fields).toEqual({
      [n(F.name)]: 'First order',
      [n(F.status)]: n(O.done, F.status),
      [n(F.tags)]: [n(O.a, F.tags), n(O.b, F.tags)],
      [n(F.owner)]: [MEMBER_ID],
      [n(F.files)]: [{ id: n(ATT.file), name: 'invoice.pdf', size: 10, mime: 'application/pdf' }],
      [n(F.price)]: 12.5,
      [n(F.due)]: '2026-03-01T10:00:00.000Z',
    });
    expect(rewriter.userOrNull(record.created_by_email, at('r'))).toBe(MEMBER_ID);
    expect(rewriter.userOrNull(record.updated_by_email, at('r'))).toBeNull();
    expect(rewriter.userOrNull(null, at('r'))).toBeNull();
  });

  it('refuses values of fields of another table or without a value of their own', () => {
    const { rewriter, problems } = importSetup();
    rewriter.recordFields(
      { [F.cusName]: 'x', [F.total]: 3, [F.created]: MEMBER_EMAIL },
      T_ORD,
      at('data/x.ndjson:3'),
    );
    expect(problems.list().map((item) => item.path)).toEqual([
      `data/x.ndjson:3#/${F.cusName}`,
      `data/x.ndjson:3#/${F.total}`,
      `data/x.ndjson:3#/${F.created}`,
    ]);
  });

  it('refuses a user id where a package holds emails', () => {
    const { rewriter, problems } = importSetup();
    rewriter.recordFields({ [F.owner]: [id('usr', 'Victim')] }, T_ORD, at('d'));
    rewriter.filter({ field: F.owner, operator: 'has_any_of', value: ['not an email'] }, at('f'));
    expect(problems.list().map((item) => [item.code, item.path])).toEqual([
      ['INVALID_ENTRY', `d#/${F.owner}/0`],
      ['INVALID_ENTRY', 'f#/value/0'],
    ]);
  });

  it('links, files and tables', () => {
    const { rewriter, map, problems } = importSetup();
    const n = (value: string) => String(map.resolve(value));
    expect(rewriter.link({ a: R.one, b: R.cus, position: 3 }, at('l'))).toEqual({
      a: n(R.one),
      b: n(R.cus),
      position: 3,
    });
    const outFiles = files.map((file, index) => rewriter.file(file, at('f').at(index)));
    expectNoOldIds(files, outFiles);
    expect(outFiles[1]).toMatchObject({ id: n(ATT.cover), table_id: n(T_ORD), view_id: n(V.form) });
    expect(outFiles[2]).toMatchObject({ id: n(ATT.asset), automation_id: n(A.main) });
    const outTables = tables.map((table, index) => rewriter.table(table, at('t').at(index)));
    expect(problems.list()).toEqual([]);
    expectNoOldIds(tables, outTables);
    expect(outTables[0]).toMatchObject({ id: n(T_ORD), primary_field_id: n(F.name) });
  });
});

describe('export: ids kept, users as emails, references out of the package left out or listed', () => {
  const USERS = new Map([
    [MEMBER_ID, MEMBER_EMAIL],
    [id('usr', 'Gone'), GONE_EMAIL],
  ]);

  /** Stored shapes: the fixture with emails turned back into user ids. */
  function stored<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value)
        .replaceAll(MEMBER_EMAIL, MEMBER_ID)
        .replaceAll(GONE_EMAIL, id('usr', 'Gone')),
    ) as T;
  }

  function exportSetup(exported: (value: string, owner?: string) => boolean) {
    const ids: PackageIdResolver = {
      resolve: (value, owner) => (exported(value, owner) ? value : null),
    };
    const emails = new PackageUserEmails(USERS);
    const names = new Map<string, string>([
      [FOREIGN.secret, 'Sales bot'],
      [FOREIGN.identity, 'Sales <sales@example.org>'],
    ]);
    return new PackageRewriter({
      direction: 'export',
      ids,
      users: { resolve: (value) => emails.emailOf(value) },
      catalog: new PackageSchemaCatalog({ tables: stored(tables) }),
      detachedName: (_kind, value) => names.get(value) ?? 'unnamed',
    });
  }

  it('round trip: export then import gives the stored shapes with new ids', () => {
    const everything = exportSetup(() => true);
    const exportedView = everything.view(stored(views[0]), at('v'));
    const exportedRole = everything.role(stored(roles[0]), at('r'));
    expect(exportedView).toEqual(views[0]);
    expect(exportedRole).toEqual(roles[0]);
    const exportedAutomation = everything.automation(stored(automations[0]), at('a'));
    expect(exportedAutomation.detached).toEqual([
      {
        path: 'actions[3].config.then[0].config.identity_id',
        kind: 'email_identity',
        name: 'Sales <sales@example.org>',
      },
      {
        path: 'actions[3].config.then[0].config.reply_to.identity_id',
        kind: 'email_identity',
        name: 'unnamed',
      },
      {
        path: 'actions[3].config.else[0].config.recipients[1].group_id',
        kind: 'group',
        name: 'unnamed',
      },
      { path: 'actions[4].config.secret_id', kind: 'secret', name: 'Sales bot' },
      { path: 'actions[5].config.auth.secret_id', kind: 'secret', name: 'unnamed' },
      { path: 'actions[5].config.signing_secret_id', kind: 'secret', name: 'unnamed' },
      { path: 'actions[6].config.signing_secret_id', kind: 'secret', name: 'unnamed' },
    ]);
    expect(
      idsIn(exportedAutomation.automation).filter((value) => FOREIGN_KINDS.test(value)),
    ).toEqual([]);
    const { rewriter, problems } = importSetup();
    const imported = rewriter.automation(exportedAutomation.automation, at('a'));
    expect(problems.list()).toEqual([]);
    expect(imported.detached.map((item) => item.name)).toEqual(
      exportedAutomation.detached.map((item) => item.name),
    );
    expectNoOldIds(automations[0], imported.automation);
  });

  it('an unknown user id becomes a placeholder email, the same for each use', () => {
    const rewriter = exportSetup(() => true);
    const stranger = id('usr', 'Stranger');
    const output = rewriter.filter(
      { field: F.owner, operator: 'has_any_of', value: [stranger, stranger] },
      at('f'),
    ) as { value: string[] };
    expect(output.value).toEqual(['unknown-1@cellhive.invalid', 'unknown-1@cellhive.invalid']);
  });

  it('view filters, lists and maps leave out what the package does not hold', () => {
    const trashed = new Set<string>([F.price, F.files]);
    const rewriter = exportSetup((value) => !trashed.has(value));
    const output = rewriter.view(stored(views[0]), at('v')) as { config: Record<string, unknown> };
    expect(output.config).toMatchObject({
      sort: [],
      hidden_fields: [],
      summaries: {},
    });
    // The `not` group held only the trashed field: it is gone.
    const items = (output.config['filter'] as { items: unknown[] }).items;
    expect(items).toHaveLength(7);
    expect(rewriter.missingIds()).toEqual([]);
  });

  it('formulas, rules and automations keep the reference and list it missing', () => {
    const trashed = new Set<string>([F.price, O.done]);
    const rewriter = exportSetup((value) => !trashed.has(value));
    rewriter.fieldOptions(
      stored(tables[0]?.fields.find((field) => field.id === F.total)) as never,
      at('t'),
    );
    rewriter.role(stored(roles[0]), at('r'));
    const automation = rewriter.automation(stored(automations[0]), at('a'));
    expect(rewriter.missingIds()).toEqual([O.done, F.price].sort());
    // Kept where it stands: a rule never selects more records than it did.
    expect(JSON.stringify(automation.automation)).toContain(F.price);
  });

  it('import maps missing ids to new ids that name nothing', () => {
    const problems = new PackageProblems();
    const map = new PackageIdMap();
    assignPackageIds(map, { missingIds: [F.price] }, problems);
    const rewriter = new PackageRewriter({
      direction: 'import',
      ids: map,
      users: new PackageUserMatcher([]),
      catalog: new PackageSchemaCatalog({ tables: [] }),
      problems,
    });
    const output = rewriter.formula(`[${F.price}] * 2`, at('x'));
    expect(problems.list()).toEqual([]);
    expect(output).toBe(`[${String(map.resolve(F.price))}] * 2`);
  });
});

describe('PackageSchemaCatalog', () => {
  it('knows the kind of each field, through lookups and formula results', () => {
    const catalog = new PackageSchemaCatalog({
      tables: [
        ...tables,
        {
          id: id('tbl', 'Extra'),
          fields: [
            {
              id: id('fld', 'UserFormula'),
              type: 'formula',
              result_type: { kind: 'list', element: { kind: 'user' } },
            },
            {
              id: id('fld', 'RowFormula'),
              type: 'formula',
              result_type: { kind: 'row', tableId: T_CUS },
            },
            {
              id: id('fld', 'Count'),
              type: 'lookup',
              options: { select: F.cusTier, aggregate: 'counta' },
            },
            { id: id('fld', 'FilesLookup'), type: 'lookup', options: { select: F.files } },
          ],
        },
      ],
    });
    expect(catalog.valueKind(F.status)).toBe('option');
    expect(catalog.valueKind(F.tier)).toBe('option');
    expect(catalog.optionOwner(F.tier)).toBe(F.cusTier);
    expect(catalog.valueKind(F.owner)).toBe('user');
    expect(catalog.valueKind(F.created)).toBe('user');
    expect(catalog.valueKind(F.customer)).toBe('record');
    expect(catalog.valueKind(F.parent)).toBe('record');
    expect(catalog.valueKind(F.files)).toBe('attachment');
    expect(catalog.valueKind(F.total)).toBe('plain');
    expect(catalog.valueKind(id('fld', 'UserFormula'))).toBe('user');
    expect(catalog.valueKind(id('fld', 'RowFormula'))).toBe('record');
    expect(catalog.valueKind(id('fld', 'Count'))).toBe('plain');
    expect(catalog.optionOwner(id('fld', 'Count'))).toBeNull();
    expect(catalog.valueKind(id('fld', 'FilesLookup'))).toBe('attachment');
    expect(catalog.valueKind('fld_unknown000000000')).toBe('plain');
  });
});
