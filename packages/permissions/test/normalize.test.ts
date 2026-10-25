import { newId } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  normalizeRoleConfig,
  roleConfigSchema,
  type FilterNode,
  type RoleAdjustment,
  type RoleConfigInput,
} from '../src/index.js';

import { buildFixture } from './fixture.js';

const fx = buildFixture();
const orders = fx.tbl.orders;

const statusIsDone: FilterNode = {
  field: fx.fld.status,
  operator: 'is',
  value: 'opt_done',
};

/** Sales (CONTRACTS §5) with `status` both in edit_filter and set to no_perm. */
function salesWithStatusFilter(operations: ('add' | 'delete')[]): RoleConfigInput {
  return {
    ...fx.salesConfigInput,
    tables: {
      [orders]: {
        perm: 'edit',
        record_rule: {
          operations,
          edit_filter: { op: 'and', items: [fx.ownerIsCurrentUser, statusIsDone] },
          read_scope: 'editable',
          read_filter: null,
        },
        field_rule: {
          mode: 'specify',
          fields: { [fx.fld.cost]: 'no_perm', [fx.fld.status]: 'no_perm' },
        },
      },
    },
  };
}

describe('normalizeRoleConfig', () => {
  const cases: {
    name: string;
    config: RoleConfigInput;
    kind?: 'custom' | 'system_editor' | 'system_reader';
    adjustments: RoleAdjustment[];
    fields?: Record<string, string>;
    operations?: string[];
    perm?: string;
  }[] = [
    {
      name: 'P26 status in edit_filter set to no_perm (no add) is raised to read',
      config: salesWithStatusFilter([]),
      adjustments: [
        {
          table_id: orders,
          field_id: fx.fld.status,
          from: 'no_perm',
          to: 'read',
          reason: 'filter_field_min_read',
        },
      ],
      fields: { [fx.fld.cost]: 'no_perm', [fx.fld.status]: 'read' },
    },
    {
      name: 'P26 with the Sales `add` operation the filter fields are raised to create',
      config: salesWithStatusFilter(['add']),
      adjustments: [
        {
          table_id: orders,
          field_id: fx.fld.status,
          from: 'no_perm',
          to: 'create',
          reason: 'filter_field_min_create',
        },
      ],
      fields: { [fx.fld.cost]: 'no_perm', [fx.fld.status]: 'create' },
    },
    {
      name: 'P27 total_formula: edit is lowered to read',
      config: {
        tables: {
          [orders]: {
            perm: 'edit',
            field_rule: { mode: 'specify', fields: { [fx.fld.total_formula]: 'edit' } },
          },
        },
      },
      adjustments: [
        {
          table_id: orders,
          field_id: fx.fld.total_formula,
          from: 'edit',
          to: 'read',
          reason: 'computed_field_max_read',
        },
      ],
      fields: { [fx.fld.total_formula]: 'read' },
    },
    {
      name: 'a computed field in a filter with add is capped at read, not raised to create',
      config: {
        tables: {
          [orders]: {
            perm: 'edit',
            record_rule: {
              operations: ['add'],
              edit_filter: { field: fx.fld.total_formula, operator: 'gt', value: 1 },
            },
            field_rule: { mode: 'no_perm' },
          },
        },
      },
      adjustments: [
        {
          table_id: orders,
          field_id: fx.fld.total_formula,
          from: 'no_perm',
          to: 'read',
          reason: 'filter_field_min_read',
        },
      ],
      fields: { [fx.fld.total_formula]: 'read' },
    },
    {
      name: 'read_filter fields are raised too; fields already high enough are untouched',
      config: {
        tables: {
          [orders]: {
            perm: 'read_only',
            record_rule: {
              read_scope: 'filter',
              read_filter: {
                op: 'not',
                item: {
                  op: 'or',
                  items: [statusIsDone, { field: fx.fld.amount, operator: 'gt', value: 0 }],
                },
              },
            },
            field_rule: { mode: 'all_read', fields: { [fx.fld.status]: 'no_perm' } },
          },
        },
      },
      adjustments: [
        {
          table_id: orders,
          field_id: fx.fld.status,
          from: 'no_perm',
          to: 'read',
          reason: 'filter_field_min_read',
        },
      ],
      fields: { [fx.fld.status]: 'read' },
    },
    {
      name: 'read_only clears operations',
      config: {
        tables: { [orders]: { perm: 'read_only', record_rule: { operations: ['add', 'delete'] } } },
      },
      adjustments: [
        {
          table_id: orders,
          field_id: null,
          from: ['add', 'delete'],
          to: [],
          reason: 'operations_require_edit',
        },
      ],
      operations: [],
    },
    {
      name: 'no_perm clears operations and skips field rules',
      config: {
        tables: {
          [orders]: {
            perm: 'no_perm',
            record_rule: { operations: ['delete'], edit_filter: statusIsDone },
            field_rule: { mode: 'specify', fields: { [fx.fld.total_formula]: 'edit' } },
          },
        },
      },
      adjustments: [
        {
          table_id: orders,
          field_id: null,
          from: ['delete'],
          to: [],
          reason: 'operations_require_edit',
        },
      ],
      fields: { [fx.fld.total_formula]: 'edit' },
    },
    {
      name: 'reader ceiling lowers the perm and clears operations',
      kind: 'system_reader',
      config: { tables: { [orders]: { perm: 'edit', record_rule: { operations: ['add'] } } } },
      adjustments: [
        {
          table_id: orders,
          field_id: null,
          from: 'edit',
          to: 'read_only',
          reason: 'reader_ceiling',
        },
        {
          table_id: orders,
          field_id: null,
          from: ['add'],
          to: [],
          reason: 'operations_require_edit',
        },
      ],
      perm: 'read_only',
      operations: [],
    },
    {
      name: 'editor ceiling lowers manage to edit',
      kind: 'system_editor',
      config: { tables: { [orders]: { perm: 'manage' } } },
      adjustments: [
        { table_id: orders, field_id: null, from: 'manage', to: 'edit', reason: 'editor_ceiling' },
      ],
      perm: 'edit',
    },
    {
      name: 'a valid config needs no adjustment',
      config: fx.salesConfigInput,
      adjustments: [],
    },
  ];

  it.each(cases)('$name', ({ config, kind, adjustments, fields, operations, perm }) => {
    const parsed = roleConfigSchema.parse(config);
    const snapshot = JSON.stringify(parsed);
    const result = normalizeRoleConfig(parsed, fx.schema, kind === undefined ? {} : { kind });
    expect(result.adjustments).toEqual(adjustments);
    expect(JSON.stringify(parsed)).toBe(snapshot); // input untouched
    const table = result.config.tables[orders];
    if (fields !== undefined) expect(table?.field_rule.fields).toEqual(fields);
    if (operations !== undefined) expect(table?.record_rule.operations).toEqual(operations);
    if (perm !== undefined) expect(table?.perm).toBe(perm);
    // Normalising twice is a no-op.
    expect(
      normalizeRoleConfig(result.config, fx.schema, kind === undefined ? {} : { kind }).adjustments,
    ).toEqual([]);
  });

  it('keeps tables that are not in the schema unchanged', () => {
    const unknown = newId('tbl');
    const parsed = roleConfigSchema.parse({
      base_rule: { copy: true },
      tables: { [unknown]: { perm: 'read_only', record_rule: { operations: ['add'] } } },
      dashboards: { [newId('dsh')]: 'read_only' },
    });
    const result = normalizeRoleConfig(parsed, fx.schema);
    expect(result.adjustments).toEqual([]);
    expect(result.config).toEqual(parsed);
  });
});
