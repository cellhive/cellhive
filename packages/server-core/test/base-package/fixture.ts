/**
 * A package schema that names every kind of id in every place a stored
 * shape can hold one (S9 research §2.3), for the reference rewrite tests.
 * Users are emails, as in a package: `an@example.com` is a member of the
 * target organization, `gone@example.com` is not.
 */

export const id = (prefix: string, label: string): string => `${prefix}_${label.padEnd(16, '0')}`;

export const MEMBER_EMAIL = 'an@example.com';
export const GONE_EMAIL = 'gone@example.com';

export const T_ORD = id('tbl', 'Orders');
export const T_CUS = id('tbl', 'Customers');

export const F = {
  name: id('fld', 'Name'),
  status: id('fld', 'Status'),
  tags: id('fld', 'Tags'),
  owner: id('fld', 'Owner'),
  due: id('fld', 'Due'),
  due2: id('fld', 'Due2'),
  customer: id('fld', 'Customer'),
  total: id('fld', 'Total'),
  price: id('fld', 'Price'),
  files: id('fld', 'Files'),
  tier: id('fld', 'TierLookup'),
  summary: id('fld', 'Summary'),
  parent: id('fld', 'Parent'),
  button: id('fld', 'Button'),
  created: id('fld', 'CreatedBy'),
  cusName: id('fld', 'CusName'),
  cusTier: id('fld', 'CusTier'),
  orders: id('fld', 'Orders'),
} as const;

export const O = {
  new: id('opt', 'New'),
  done: id('opt', 'Done'),
  a: id('opt', 'A'),
  b: id('opt', 'B'),
  gold: id('opt', 'Gold'),
  silver: id('opt', 'Silver'),
} as const;

export const V = { grid: id('viw', 'Grid'), kanban: id('viw', 'Kanban'), form: id('viw', 'Form') };
export const C1 = id('clr', 'Rule');
export const D1 = id('dsh', 'Sales');
export const W = {
  ctrl: id('wgt', 'Ctrl'),
  user: id('wgt', 'User'),
  bar: id('wgt', 'Bar'),
  barUser: id('wgt', 'BarUser'),
  kpi: id('wgt', 'Kpi'),
  table: id('wgt', 'Table'),
  pivot: id('wgt', 'Pivot'),
  text: id('wgt', 'Text'),
};
export const A = {
  main: id('aut', 'Main'),
  hook: id('aut', 'Hook'),
  form: id('aut', 'Form'),
  button: id('aut', 'Button'),
  date: id('aut', 'Date'),
  matches: id('aut', 'Matches'),
  schedule: id('aut', 'Schedule'),
  created: id('aut', 'Created'),
};
export const ROLE = id('rol', 'Sales');
export const R = { one: id('rec', 'One'), two: id('rec', 'Two'), cus: id('rec', 'Cus') };
export const ATT = {
  file: id('att', 'File'),
  cover: id('att', 'Cover'),
  asset: id('att', 'Asset'),
};

/** Ids of the source org the package must never carry into the target. */
export const FOREIGN = {
  secret: id('sec', 'Bot'),
  header: id('sec', 'Header'),
  signing: id('sec', 'Signing'),
  identity: id('eid', 'Sender'),
  replyIdentity: id('eid', 'Reply'),
  group: id('grp', 'Sales'),
  hook: id('hok', 'Shop'),
};

const ai = (prompt: string) => ({
  task: 'custom',
  prompt,
  instructions: null,
  auto_update: true,
  max_output_tokens: 256,
});

export const tables = [
  {
    id: T_ORD,
    name: 'Orders',
    description: null,
    position: 0,
    primary_field_id: F.name,
    fields: [
      { id: F.name, type: 'text', options: {} },
      {
        id: F.status,
        type: 'select',
        options: {
          multiple: false,
          options: [
            { id: O.new, name: 'New', color: 1 },
            { id: O.done, name: 'Done', color: 2 },
          ],
          default_value: O.new,
          ai: ai(`Pick a status for {{ [${F.name}] }}`),
        },
      },
      {
        id: F.tags,
        type: 'select',
        options: {
          multiple: true,
          options: [
            { id: O.a, name: 'A' },
            { id: O.b, name: 'B' },
          ],
          default_value: [O.a],
        },
      },
      {
        id: F.owner,
        type: 'user',
        options: {
          multiple: true,
          notify_on_assign: false,
          default_value: [{ $slot: 'current_user' }, { id: MEMBER_EMAIL }, { id: GONE_EMAIL }],
        },
      },
      {
        id: F.due,
        type: 'datetime',
        options: {
          style: { format: 'yyyy-MM-dd HH:mm' },
          reminder: {
            offset_minutes: -60,
            time_of_day: null,
            recipients: 'users',
            user_ids: [MEMBER_EMAIL, GONE_EMAIL],
          },
        },
      },
      {
        id: F.due2,
        type: 'datetime',
        options: {
          style: { format: 'yyyy-MM-dd' },
          reminder: {
            offset_minutes: 0,
            time_of_day: '08:30',
            recipients: 'field_user',
            user_field_id: F.owner,
          },
        },
      },
      {
        id: F.customer,
        type: 'link',
        options: {
          link_table: T_CUS,
          bidirectional: true,
          allow_multiple: true,
          record_filter: {
            op: 'and',
            items: [
              { field: F.cusTier, operator: 'is_any_of', value: [O.gold] },
              { field: F.orders, operator: 'has_any_of', value: [R.one] },
            ],
          },
          symmetric_field_id: F.orders,
        },
      },
      {
        id: F.total,
        type: 'formula',
        options: {
          expression:
            `IF([${F.status}] = "Done", [${F.price}] * 2, LEN("[Price] stays text")) + ` +
            `COUNTIF([${F.customer}].[${F.cusTier}], CurrentValue = "Gold") + ` +
            `LET(x, [${T_CUS}].[${F.cusName}], LEN(x))`,
          style: null,
        },
        result_type: { kind: 'number' },
      },
      { id: F.price, type: 'number', options: {} },
      { id: F.files, type: 'attachment', options: {} },
      {
        id: F.tier,
        type: 'lookup',
        options: {
          from: T_CUS,
          select: F.cusTier,
          where: {
            op: 'and',
            items: [
              { field: F.cusTier, operator: 'is_any_of', value: [O.gold, O.silver] },
              { field: F.cusName, operator: 'eq', value: { field_ref: F.name } },
            ],
          },
          aggregate: 'raw_value',
          style: null,
        },
        result_type: { kind: 'list', element: { kind: 'text' } },
      },
      {
        id: F.summary,
        type: 'text',
        options: {
          ai: ai(`Summarize {{ [${F.name}] }} for {{ [${F.customer}].[${F.cusName}] }}`),
        },
      },
      { id: F.parent, type: 'parent', options: {} },
      { id: F.button, type: 'button', options: { label: 'Run', color: 0, confirm: null } },
      { id: F.created, type: 'created_by', options: {} },
    ],
  },
  {
    id: T_CUS,
    name: 'Customers',
    description: null,
    position: 1,
    primary_field_id: F.cusName,
    fields: [
      { id: F.cusName, type: 'text', options: {} },
      {
        id: F.cusTier,
        type: 'select',
        options: {
          multiple: false,
          options: [
            { id: O.gold, name: 'Gold' },
            { id: O.silver, name: 'Silver' },
          ],
        },
      },
      {
        id: F.orders,
        type: 'link',
        options: {
          link_table: T_ORD,
          bidirectional: true,
          allow_multiple: true,
          record_filter: null,
          symmetric_field_id: F.customer,
        },
      },
    ],
  },
].map((table) => ({
  ...table,
  fields: table.fields.map((field, index) => ({
    name: `Field ${String(index)}`,
    is_primary: index === 0,
    required: false,
    unique_values: false,
    description: null,
    position: index,
    link_side: field.type === 'link' ? (field.id === F.customer ? 'a' : 'b') : null,
    result_type: 'result_type' in field ? field.result_type : null,
    ...field,
  })),
}));

const viewCommon = {
  sort: [],
  group: [],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: false },
  record_detail: { link_columns: {} },
  filter: null,
};

export const views = [
  {
    id: V.grid,
    table_id: T_ORD,
    type: 'grid',
    name: 'Grid',
    position: 0,
    locked: false,
    config: {
      ...viewCommon,
      filter: {
        op: 'and',
        items: [
          { field: F.status, operator: 'is', value: O.new },
          { field: F.owner, operator: 'has_any_of', value: [MEMBER_EMAIL, GONE_EMAIL] },
          { field: F.customer, operator: 'has_any_of', value: [R.cus] },
          { field: F.tier, operator: 'has_any_of', value: [O.gold] },
          { op: 'not', item: { field: F.price, operator: 'gt', value: 3 } },
          { field: F.due, operator: 'is', value: { $date: { relative: 'today' } } },
          { field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
          { field: F.created, operator: 'has_any_of', value: [MEMBER_EMAIL] },
        ],
      },
      sort: [{ field: F.price, direction: 'desc' }],
      group: [{ field: F.status, direction: 'asc' }],
      hidden_fields: [F.files],
      field_order: [F.name, F.status],
      column_widths: { [F.name]: 240 },
      record_detail: { link_columns: { [F.customer]: [F.cusName, F.cusTier] } },
      summaries: { [F.price]: 'sum' },
      color_rules: [
        {
          id: C1,
          enabled: true,
          filter: { field: F.status, operator: 'is', value: O.done },
          color: 'green',
          target: 'cell',
          field_id: F.status,
        },
      ],
    },
  },
  {
    id: V.kanban,
    table_id: T_ORD,
    type: 'kanban',
    name: 'Board',
    position: 1,
    locked: false,
    config: {
      ...viewCommon,
      kanban: {
        group_field: F.status,
        card_fields: [F.name, F.price],
        cover_field: F.files,
        hide_empty_columns: false,
      },
    },
  },
  {
    id: V.form,
    table_id: T_ORD,
    type: 'form',
    name: 'Order form',
    position: 2,
    locked: false,
    config: {
      ...viewCommon,
      form: {
        title: 'Order',
        description: '',
        cover_attachment_id: ATT.cover,
        fields: [{ field: F.name, required: true, label: null, help: null }],
        success_message: 'Thanks',
        redirect_url: null,
        allow_multiple_submissions: true,
        require_login: false,
        submission_limit: 'none',
      },
    },
  },
];

const metric = (field: string | null) => ({
  id: 'm1',
  aggregation: field === null ? 'count' : 'sum',
  field,
  label: null,
  color: null,
});

export const dashboards = [
  {
    id: D1,
    name: 'Sales',
    icon: null,
    description: null,
    theme: {},
    position: 0,
    global_filters: [
      {
        id: 'gf1',
        label: 'Status',
        kind: 'select',
        targets: [{ table_id: T_ORD, field: F.status }],
      },
    ],
    widgets: [
      {
        id: W.ctrl,
        type: 'filter_control',
        title: 'Status',
        layout: { x: 0, y: 0, w: 3, h: 2 },
        config: {
          table_id: T_ORD,
          field: F.status,
          control: 'select',
          parent_control_id: null,
          default: { values: [O.new] },
        },
      },
      {
        id: W.user,
        type: 'filter_control',
        title: 'Owner',
        layout: { x: 3, y: 0, w: 3, h: 2 },
        config: {
          table_id: T_ORD,
          field: F.owner,
          control: 'user',
          parent_control_id: W.ctrl,
          default: { values: [MEMBER_EMAIL, GONE_EMAIL] },
        },
      },
      {
        id: W.bar,
        type: 'bar',
        title: 'By status',
        layout: { x: 0, y: 2, w: 6, h: 6 },
        config: {
          table_id: T_ORD,
          filter: { field: F.status, operator: 'is_any_of', value: [O.new, O.done] },
          filter_bindings: [W.ctrl, W.user],
          dimension: { field: F.status, date_bucket: null, bucket_width: null },
          series_dimension: null,
          metrics: [metric(F.price)],
          sort: 'metric_desc',
          limit: 10,
          group_others: false,
          display: { colors: { [O.new]: '#ff0000', [O.done]: '#00ff00', Other: '#0000ff' } },
        },
      },
      {
        id: W.barUser,
        type: 'bar',
        title: 'By owner',
        layout: { x: 6, y: 2, w: 6, h: 6 },
        config: {
          table_id: T_ORD,
          filter: null,
          filter_bindings: [],
          dimension: { field: F.owner, date_bucket: null, bucket_width: null },
          series_dimension: { field: F.tags, date_bucket: null, bucket_width: null },
          metrics: [metric(null)],
          sort: 'metric_desc',
          limit: 10,
          group_others: false,
          display: {
            colors: { [MEMBER_EMAIL]: '#111111', [GONE_EMAIL]: '#222222', [O.a]: '#333333' },
          },
        },
      },
      {
        id: W.kpi,
        type: 'kpi',
        title: 'Orders',
        layout: { x: 0, y: 8, w: 3, h: 3 },
        config: {
          table_id: T_ORD,
          filter: null,
          filter_bindings: [W.ctrl],
          metrics: [metric(null)],
          compare: { mode: 'previous_period', date_field: F.due, range: 'month' },
          display: {},
        },
      },
      {
        id: W.table,
        type: 'table',
        title: 'Top',
        layout: { x: 3, y: 8, w: 6, h: 6 },
        config: {
          table_id: T_ORD,
          filter: null,
          filter_bindings: [],
          table: {
            mode: 'records',
            fields: [F.name, F.price],
            sort: { field: F.price, direction: 'desc' },
            limit: 10,
          },
          display: {},
        },
      },
      {
        id: W.pivot,
        type: 'table',
        title: 'Pivot',
        layout: { x: 9, y: 8, w: 3, h: 6 },
        config: {
          table_id: T_ORD,
          filter: null,
          filter_bindings: [],
          table: {
            mode: 'pivot',
            dimension: { field: F.status, date_bucket: null, bucket_width: null },
            metrics: [metric(F.price)],
            sort: 'metric_desc',
            limit: 10,
          },
          display: {},
        },
      },
      {
        id: W.text,
        type: 'text',
        title: 'Notes',
        layout: { x: 0, y: 14, w: 12, h: 2 },
        config: { markdown: 'Plain **text**' },
      },
    ],
  },
];

const trigger = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

export const mainDefinition = {
  trigger: trigger('record.updated', { table_id: T_ORD, watch_fields: [F.status, F.price] }),
  condition: { field: F.status, operator: 'changed_to', value: O.done },
  actions: [
    {
      id: 'act_1',
      type: 'find_records',
      config: {
        table_id: T_CUS,
        filter: { field: F.cusTier, operator: 'is', value: O.gold },
        sort: [{ field: F.cusName, direction: 'asc' }],
        fields: [F.cusName],
        limit: 10,
      },
    },
    {
      id: 'act_2',
      type: 'update_record',
      config: {
        table_id: T_ORD,
        record_id: { literal: R.two },
        fields: {
          [F.status]: { literal: O.new },
          [F.tags]: { literal: [O.a, O.b] },
          [F.owner]: { literal: [MEMBER_EMAIL, GONE_EMAIL] },
          [F.name]: { template: `Hi {{ [act_1].[${F.cusName}] }} {{ [@actor] }}` },
          [F.price]: { step: 'act_1', path: `records[0].fields.${F.cusName}` },
          [F.customer]: { literal: [R.cus] },
        },
      },
    },
    {
      id: 'act_3',
      type: 'update_records',
      config: {
        table_id: T_ORD,
        filter: { field: F.customer, operator: 'has_any_of', value: { field: F.customer } },
        fields: { [F.tags]: { literal: [O.a] } },
        limit: 100,
      },
    },
    {
      id: 'act_4',
      type: 'if',
      config: {
        match: 'and',
        conditions: [
          { filter: { field: F.price, operator: 'gt', value: 1 } },
          { value: { field: F.price }, operator: 'gt', compare: { literal: 5 } },
        ],
        on_false: 'else',
        then: [
          {
            id: 'act_5',
            type: 'send_email',
            config: {
              identity_id: FOREIGN.identity,
              to: [{ literal: 'buyer@example.org' }, { field: F.owner }],
              cc: [],
              bcc: [{ step: 'act_1', path: `records[0].fields.${F.cusName}` }],
              reply_to: { identity_id: FOREIGN.replyIdentity },
              subject: { template: `Order {{ [${F.name}] }}` },
              body: {
                format: 'markdown',
                template: `See ![logo](asset:${ATT.asset}) and {{ [@digest] }} for {{ [${F.name}] }}`,
                digest: {
                  step: 'act_1',
                  row_template: `- {{ [${F.cusName}] }}`,
                  max_rows: 10,
                  separator: '\n',
                },
              },
              include_signature: true,
              footer: 'minimal',
              attachments: [{ field: F.files }],
              on_missing_attachment: 'fail',
            },
          },
        ],
        else: [
          {
            id: 'act_6',
            type: 'send_notification',
            config: {
              recipients: [
                { user_ids: [MEMBER_EMAIL, GONE_EMAIL] },
                { group_id: FOREIGN.group },
                { field: F.owner },
              ],
              title: { template: `{{ [${F.name}] }}` },
              body: { template: '' },
              link_record: 'trigger',
              skip_actor: false,
            },
          },
        ],
      },
    },
    {
      id: 'act_7',
      type: 'send_telegram',
      config: {
        secret_id: FOREIGN.secret,
        chat_id: { literal: '-100123' },
        text: {
          template: `{{ [${F.name}] }}: {{ [@digest] }}`,
          digest: {
            step: 'act_1',
            row_template: `{{ [${F.cusName}] }}`,
            max_rows: 5,
            separator: '\n',
          },
        },
      },
    },
    {
      id: 'act_8',
      type: 'http_request',
      config: {
        method: 'POST',
        url: { template: `https://hooks.example.org/{{ [${F.name}] }}` },
        query: [{ name: 'price', value: { field: F.price } }],
        headers: [{ name: 'x-order', value: { template: `{{ [${F.name}] }}` } }],
        auth: { header_name: 'Authorization', secret_id: FOREIGN.header },
        body: {
          type: 'form',
          fields: [{ name: 'name', value: { field: F.name } }],
        },
        signing_secret_id: FOREIGN.signing,
        fail_on_http_error: true,
      },
    },
    {
      id: 'act_9',
      type: 'run_n8n_workflow',
      config: {
        url: { literal: 'https://n8n.example.org/webhook/x' },
        signing_secret_id: FOREIGN.signing,
        fields: [F.name, F.price],
      },
    },
    {
      id: 'act_10',
      type: 'ai_generate_text',
      config: {
        prompt: `Write about {{ [${F.name}] }}`,
        instructions: null,
        max_output_tokens: 256,
        target_field_id: F.summary,
      },
    },
    {
      id: 'act_11',
      type: 'ai_classify',
      config: { input: `{{ [${F.name}] }}`, instructions: null, target_field_id: F.status },
    },
    {
      id: 'act_12',
      type: 'delay',
      config: {
        minutes: null,
        until: { field: F.due },
        recheck_condition: { field: F.status, operator: 'is', value: O.new },
      },
    },
    {
      id: 'act_13',
      type: 'create_record',
      config: {
        table_id: T_CUS,
        fields: {
          [F.cusName]: { template: `{{ [${F.name}] }} ({{ [act_10] }})` },
          [F.cusTier]: { literal: O.gold },
        },
      },
    },
    {
      id: 'act_14',
      type: 'http_request',
      config: {
        method: 'POST',
        url: { literal: 'https://hooks.example.org/plain' },
        query: [],
        headers: [],
        auth: null,
        body: { type: 'json', value: { field: F.price } },
        signing_secret_id: null,
        fail_on_http_error: false,
      },
    },
  ],
};

export const automations = [
  {
    id: A.main,
    name: 'Main',
    description: '',
    definition: mainDefinition,
    detached: [],
  },
  {
    id: A.hook,
    name: 'Hook',
    description: '',
    definition: {
      trigger: { type: 'webhook.received', incoming_webhook_id: FOREIGN.hook, condition: null },
      condition: null,
      actions: [],
    },
    detached: [],
  },
  {
    id: A.form,
    name: 'Form',
    description: '',
    definition: {
      trigger: trigger('form.submitted', { view_id: V.form }),
      condition: null,
      actions: [],
    },
    detached: [],
  },
  {
    id: A.button,
    name: 'Button',
    description: '',
    definition: {
      trigger: trigger('button.clicked', {
        table_id: T_ORD,
        field_id: F.button,
        min_permission: 'edit',
        enabled_when: { field: F.status, operator: 'is', value: O.new },
      }),
      condition: null,
      actions: [{ id: 'act_1', type: 'delete_record', config: {} }],
    },
    detached: [],
  },
  {
    id: A.date,
    name: 'Date',
    description: '',
    definition: {
      trigger: trigger('record.date_reached', {
        table_id: T_ORD,
        field_id: F.due,
        offset_minutes: 0,
        time_of_day: null,
      }),
      condition: null,
      actions: [],
    },
    detached: [],
  },
  {
    id: A.matches,
    name: 'Matches',
    description: '',
    definition: {
      trigger: trigger('record.matches', {
        table_id: T_ORD,
        condition: { field: F.owner, operator: 'has_any_of', value: [GONE_EMAIL] },
      }),
      condition: null,
      actions: [],
    },
    detached: [],
  },
  {
    id: A.schedule,
    name: 'Schedule',
    description: '',
    definition: {
      trigger: trigger('schedule', { cron: '0 9 * * 1', timezone: 'Asia/Ho_Chi_Minh' }),
      condition: null,
      actions: [],
    },
    detached: [],
  },
  {
    id: A.created,
    name: 'Created',
    description: '',
    definition: {
      trigger: trigger('record.created', { table_id: T_CUS }),
      condition: { field: F.cusTier, operator: 'is', value: O.silver },
      actions: [],
    },
    detached: [],
  },
];

export const roles = [
  {
    id: ROLE,
    name: 'Sales',
    position: 0,
    config: {
      base_rule: { copy: false, download: true, share_link: false },
      tables: {
        [T_ORD]: {
          perm: 'edit',
          view_rule: { allow_edit: false, visible_views: [V.grid, V.kanban] },
          record_rule: {
            operations: ['add'],
            edit_filter: { field: F.owner, operator: 'has_any_of', value: [MEMBER_EMAIL] },
            read_scope: 'filter',
            read_filter: {
              op: 'or',
              items: [
                { field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                { field: F.status, operator: 'is', value: O.done },
              ],
            },
          },
          field_rule: {
            mode: 'specify',
            fields: { [F.price]: 'read', [F.name]: 'edit' },
            option_edit_fields: [F.status],
            file_download_fields: [F.files],
          },
        },
        [T_CUS]: {
          perm: 'read_only',
          view_rule: { allow_edit: false, visible_views: null },
          record_rule: { operations: [], edit_filter: null, read_scope: 'all', read_filter: null },
          field_rule: {
            mode: 'all_read',
            fields: {},
            option_edit_fields: [],
            file_download_fields: [],
          },
        },
      },
      dashboards: { [D1]: 'read_only' },
    },
  },
];

export const files = [
  {
    id: ATT.file,
    kind: 'cell',
    filename: 'invoice.pdf',
    mime: 'application/pdf',
    size: 10,
    sha256: '0'.repeat(64),
    table_id: T_ORD,
    field_id: F.files,
    record_id: R.one,
  },
  {
    id: ATT.cover,
    kind: 'form_cover',
    filename: 'cover.png',
    mime: 'image/png',
    size: 10,
    sha256: '1'.repeat(64),
    table_id: T_ORD,
    view_id: V.form,
  },
  {
    id: ATT.asset,
    kind: 'email_asset',
    filename: 'logo.png',
    mime: 'image/png',
    size: 10,
    sha256: '2'.repeat(64),
    automation_id: A.main,
    width: 64,
    height: 64,
  },
];

export const record = {
  id: R.one,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  created_by_email: MEMBER_EMAIL,
  updated_by_email: GONE_EMAIL,
  auto: 7,
  parent_id: R.two,
  fields: {
    [F.name]: 'First order',
    [F.status]: O.done,
    [F.tags]: [O.a, O.b],
    [F.owner]: [MEMBER_EMAIL, GONE_EMAIL],
    [F.files]: [{ id: ATT.file, name: 'invoice.pdf', size: 10, mime: 'application/pdf' }],
    [F.price]: 12.5,
    [F.due]: '2026-03-01T10:00:00.000Z',
  },
};

export const recordIds = [R.one, R.two, R.cus];

/** Every id of this file's kinds in a JSON value (tests only: production code never scans). */
export function idsIn(value: unknown): string[] {
  return [
    ...JSON.stringify(value).matchAll(
      /(?:tbl|fld|opt|viw|clr|dsh|wgt|aut|rol|rec|att|usr|sec|eid|grp|hok)_[0-9A-Za-z]{16}/gu,
    ),
  ].map((match) => match[0]);
}
