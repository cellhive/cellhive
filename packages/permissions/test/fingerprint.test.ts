import { newId } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  permissionFingerprintMaterial,
  resolveBaseAccess,
  roleConfigSchema,
  type ResolvedBaseAccess,
  type RoleAssignment,
} from '../src/index.js';

import { buildFixture } from './fixture.js';

import type { ResolveContext } from '@cellhive/filter-dsl';

const fx = buildFixture();
const NOW = new Date('2026-10-25T03:00:00.000Z');

function access(userId: (typeof fx.usr)[keyof typeof fx.usr], extra = {}): ResolvedBaseAccess {
  const resolved = resolveBaseAccess(fx.input(fx.principal(userId), extra));
  if (resolved === null) throw new Error('no access');
  return resolved;
}

function context(userId: string | null, overrides: Partial<ResolveContext> = {}): ResolveContext {
  return { userId, groupMemberUserIds: [], timeZone: 'Asia/Ho_Chi_Minh', now: NOW, ...overrides };
}

const material = (
  userId: (typeof fx.usr)[keyof typeof fx.usr],
  tables = [fx.tbl.orders],
  ctx: Partial<ResolveContext> = {},
  extra = {},
) => permissionFingerprintMaterial(access(userId, extra), tables, context(userId, ctx));

describe('permissionFingerprintMaterial (T807, SPEC §10.4)', () => {
  it('two members of one role with a current_user rule never share a fingerprint', () => {
    const sales1 = material(fx.usr.u_sales1);
    const sales2 = material(fx.usr.u_sales2);
    expect(sales1).not.toBeNull();
    expect(sales2).not.toBeNull();
    expect(sales1).not.toBe(sales2);
    // The variable is replaced by the user id (the caller hashes it).
    expect(sales1).toContain(fx.usr.u_sales1);
    expect(sales1).not.toContain('current_user');
  });

  it('readers who read the same records and fields share one', () => {
    // Editor and reader both read every record and field of Orders.
    expect(material(fx.usr.u_editor)).toBe(material(fx.usr.u_reader));
    // So do an admin and an editor: the cache key does not tell who reads.
    expect(material(fx.usr.u_admin)).toBe(material(fx.usr.u_editor));
    // A role without variables: one fingerprint for all its members.
    const sameRule = roleConfigSchema.parse({
      ...fx.salesConfigInput,
      tables: {
        [fx.tbl.orders]: {
          ...fx.salesConfigInput.tables?.[fx.tbl.orders],
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [{ field: fx.fld.amount, operator: 'gt', value: 10 }],
            },
          },
        },
      },
    });
    const roles = Object.values(fx.roles).map((role) =>
      role.id === fx.roles.sales.id ? { ...role, config: sameRule } : role,
    );
    expect(material(fx.usr.u_sales1, undefined, {}, { roles })).toBe(
      material(fx.usr.u_sales2, undefined, {}, { roles }),
    );
  });

  it('differs between roles that read different records or fields', () => {
    const fingerprints = new Set(
      [fx.usr.u_admin, fx.usr.u_sales1].map((userId) => material(userId)),
    );
    expect(fingerprints.size).toBe(2);
    // Sales does not read `cost`: the field set differs even without a rule.
    expect(material(fx.usr.u_sales1)).not.toContain(fx.fld.cost);
    expect(material(fx.usr.u_admin)).toContain(fx.fld.cost);
  });

  it('changes when the role of a reader changes', () => {
    const before = material(fx.usr.u_sales1);
    const assignments: RoleAssignment[] = [
      ...fx.assignments.filter((assignment) => assignment.principalType !== 'group'),
      { roleId: fx.roles.reader.id, principalType: 'user', principalId: fx.usr.u_sales1 },
    ];
    expect(material(fx.usr.u_sales1, undefined, {}, { assignments })).not.toBe(before);
  });

  it('resolves group variables and dates for the reader', () => {
    const groupRule = roleConfigSchema.parse({
      ...fx.salesConfigInput,
      tables: {
        [fx.tbl.orders]: {
          ...fx.salesConfigInput.tables?.[fx.tbl.orders],
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [
                {
                  field: fx.fld.owner,
                  operator: 'has_any_of',
                  value: [{ $var: 'current_user_groups' }],
                },
              ],
            },
          },
        },
      },
    });
    const roles = Object.values(fx.roles).map((role) =>
      role.id === fx.roles.sales.id ? { ...role, config: groupRule } : role,
    );
    const members = [fx.usr.u_sales1, fx.usr.u_sales2];
    // Same group members → one fingerprint for both.
    expect(material(fx.usr.u_sales1, undefined, { groupMemberUserIds: members }, { roles })).toBe(
      material(fx.usr.u_sales2, undefined, { groupMemberUserIds: members }, { roles }),
    );
    // Another group content → another fingerprint.
    expect(
      material(fx.usr.u_sales1, undefined, { groupMemberUserIds: members }, { roles }),
    ).not.toBe(
      material(fx.usr.u_sales1, undefined, { groupMemberUserIds: [fx.usr.u_sales1] }, { roles }),
    );
  });

  it('covers every table asked for, sorted, a hidden one as null', () => {
    const one = material(fx.usr.u_sales1, [fx.tbl.orders, fx.tbl.customers]);
    const other = material(fx.usr.u_sales1, [fx.tbl.customers, fx.tbl.orders, fx.tbl.orders]);
    expect(one).toBe(other);
    expect(one).toContain(`["${fx.tbl.customers}",null]`);
    // A table outside the base is just hidden.
    const unknown = newId('tbl');
    expect(material(fx.usr.u_admin, [unknown])).toContain(`["${unknown}",null]`);
  });

  it('reads tables outside `resolved` with `related` (share links)', () => {
    const narrow: ResolvedBaseAccess = {
      access: {
        ...access(fx.usr.u_admin).access,
        tables: { [fx.tbl.orders]: access(fx.usr.u_admin).access.tables[fx.tbl.orders] },
      } as ResolvedBaseAccess['access'],
      internal: {
        editFilters: {},
        readFilters: { [fx.tbl.orders]: null },
      },
    };
    const related = access(fx.usr.u_editor);
    const withRelated = permissionFingerprintMaterial(
      narrow,
      [fx.tbl.orders, fx.tbl.customers],
      context(null),
      related,
    );
    const without = permissionFingerprintMaterial(
      narrow,
      [fx.tbl.orders, fx.tbl.customers],
      context(null),
    );
    expect(withRelated).not.toBe(without);
  });

  it('fails closed (null) when a rule cannot be resolved', () => {
    const resolved = access(fx.usr.u_sales1);
    const broken: ResolvedBaseAccess = {
      ...resolved,
      internal: {
        ...resolved.internal,
        readFilters: {
          [fx.tbl.orders]: {
            op: 'and',
            items: [{ field: fx.fld.amount, operator: 'gt', value: { $date: 'nonsense' } }],
          } as never,
        },
      },
    };
    expect(
      permissionFingerprintMaterial(broken, [fx.tbl.orders], context(fx.usr.u_sales1)),
    ).toBeNull();
  });
});
