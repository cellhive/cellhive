import { newId, type Id } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  canReadDashboard,
  canShareLinks,
  publicSharingAllows,
  resolveBaseAccess,
  resolveShareLinkAccess,
  roleConfigSchema,
  shareLinkState,
  type BaseRoleDef,
  type FilterNode,
  type ResolvedBaseAccess,
  type RoleConfigInput,
  type ShareLinkScope,
} from '../src/index.js';

import { buildFixture } from './fixture.js';

const fx = buildFixture();
const { tbl, fld, viw, usr } = fx;

const costPositive: FilterNode = {
  op: 'and',
  items: [{ field: fld.cost, operator: 'gt', value: 0 }],
};
const amountFilter: FilterNode = { field: fld.amount, operator: 'gt', value: 10 };
const customerIsC1: FilterNode = {
  field: fld.customer,
  operator: 'has_any_of',
  value: [newId('rec')],
};

/** Sales role variant with `share_link = true` (BACKLOG S3 decision 1). */
function salesVariant(patch: (config: RoleConfigInput) => void = () => undefined): BaseRoleDef {
  const input = structuredClone(fx.salesConfigInput);
  input.base_rule = { copy: false, download: false, share_link: true };
  patch(input);
  return { ...fx.roles.sales, config: roleConfigSchema.parse(input) };
}

function creatorAccess(
  userId: Id<'usr'>,
  sales: BaseRoleDef = salesVariant(),
  dashboards: Id<'dsh'>[] = [],
) {
  return resolveBaseAccess(
    fx.input(fx.principal(userId), {
      roles: [fx.roles.admin, fx.roles.editor, fx.roles.reader, sales],
      schema: { ...fx.schema, dashboards },
    }),
  );
}

function viewScope(overrides: Partial<Extract<ShareLinkScope, { kind: 'view' }>> = {}) {
  return {
    kind: 'view',
    tableId: tbl.orders,
    viewId: viw.sales,
    filter: null,
    hiddenFields: [],
    ...overrides,
  } satisfies ShareLinkScope;
}

function formScope(formFields: Id<'fld'>[], viewId: Id<'viw'> = viw.sales): ShareLinkScope {
  return { kind: 'form', tableId: tbl.orders, viewId, formFields };
}

function must(result: ResolvedBaseAccess | null): ResolvedBaseAccess {
  expect(result).not.toBeNull();
  return result as ResolvedBaseAccess;
}

function orders(result: ResolvedBaseAccess) {
  const table = result.access.tables[tbl.orders];
  expect(table).toBeDefined();
  return table as NonNullable<typeof table>;
}

describe('resolveShareLinkAccess — view links (SPEC §15A.2, CONTRACTS §5 P30)', () => {
  it('P30: a Sales link sees only what u_sales1 sees, read only, without `cost`', () => {
    const link = must(resolveShareLinkAccess(creatorAccess(usr.u_sales1), viewScope()));
    const table = orders(link);
    expect(Object.keys(link.access.tables)).toEqual([tbl.orders]);
    expect(table.perm).toBe('read_only');
    expect(table.operations).toEqual([]);
    expect(table.fields[fld.cost]).toBeUndefined();
    expect(Object.values(table.fields).every((perm) => perm === 'read')).toBe(true);
    expect(table.view_rule).toEqual({ allow_edit: false, visible_views: [viw.sales] });
    expect(link.internal.readFilters[tbl.orders]).toEqual(fx.ownerIsCurrentUser);
    expect(link.internal.editFilters).toEqual({});
    expect(link.access.base_rule).toEqual({ copy: false, download: false, share_link: false });
    expect(link.access.is_admin).toBe(false);
  });

  const cases: {
    name: string;
    creator: () => ResolvedBaseAccess | null;
    scope: ShareLinkScope;
    fields?: { present: Id<'fld'>[]; absent: Id<'fld'>[] };
    readFilter?: FilterNode | null;
  }[] = [
    {
      name: 'creator lost read on a field → the link has no such field',
      creator: () =>
        creatorAccess(
          usr.u_sales1,
          salesVariant((config) => {
            const rule = config.tables?.[tbl.orders];
            if (rule?.field_rule !== undefined) {
              rule.field_rule.fields = { ...rule.field_rule.fields, [fld.amount]: 'no_perm' };
            }
          }),
        ),
      scope: viewScope(),
      fields: { present: [fld.title, fld.status], absent: [fld.amount, fld.cost] },
    },
    {
      name: 'creator has a read_filter → the link sees the intersection with the view filter',
      creator: () =>
        creatorAccess(
          usr.u_sales1,
          salesVariant((config) => {
            const rule = config.tables?.[tbl.orders];
            if (rule?.record_rule !== undefined) {
              rule.record_rule = {
                ...rule.record_rule,
                read_scope: 'filter',
                read_filter: amountFilter,
              };
            }
          }),
        ),
      scope: viewScope({ filter: costPositive }),
      readFilter: { op: 'and', items: [amountFilter, costPositive] },
    },
    {
      name: 'creator has a read_filter on a link field (T710) → the link keeps it',
      creator: () =>
        creatorAccess(
          usr.u_sales1,
          salesVariant((config) => {
            const rule = config.tables?.[tbl.orders];
            if (rule?.record_rule !== undefined) {
              rule.record_rule = {
                ...rule.record_rule,
                read_scope: 'filter',
                read_filter: customerIsC1,
              };
            }
          }),
        ),
      scope: viewScope({ filter: costPositive }),
      readFilter: { op: 'and', items: [customerIsC1, costPositive] },
    },
    {
      name: 'fields hidden in the view are left out',
      creator: () => creatorAccess(usr.u_admin),
      scope: viewScope({ viewId: viw.all, hiddenFields: [fld.amount, fld.total_formula] }),
      fields: {
        present: [fld.title, fld.cost, fld.status, fld.owner, fld.customer],
        absent: [fld.amount, fld.total_formula],
      },
      readFilter: null,
    },
    {
      name: 'an admin creator: only the view filter restricts records',
      creator: () => creatorAccess(usr.u_admin),
      scope: viewScope({ viewId: viw.all, filter: costPositive }),
      readFilter: costPositive,
    },
  ];

  it.each(cases)('$name', ({ creator, scope, fields, readFilter }) => {
    const link = must(resolveShareLinkAccess(creator(), scope));
    const table = orders(link);
    for (const id of fields?.present ?? []) expect(table.fields[id]).toBe('read');
    for (const id of fields?.absent ?? []) expect(table.fields[id]).toBeUndefined();
    if (readFilter !== undefined) expect(link.internal.readFilters[tbl.orders]).toEqual(readFilter);
    expect(table.read_scope).toBe(
      link.internal.readFilters[tbl.orders] === null ? 'all' : 'filter',
    );
  });
});

describe('resolveShareLinkAccess — form links', () => {
  it('creates only, on the form fields the creator may write', () => {
    const link = must(
      resolveShareLinkAccess(
        creatorAccess(usr.u_sales1),
        formScope([fld.title, fld.amount, fld.status, fld.owner, fld.cost]),
      ),
    );
    const table = orders(link);
    expect(table.perm).toBe('edit');
    expect(table.operations).toEqual(['add']);
    // `status` is `read` and `cost` is `no_perm` for Sales: never writable through the form.
    expect(table.fields).toEqual({
      [fld.title]: 'create',
      [fld.amount]: 'create',
      [fld.owner]: 'create',
    });
    // The new record must still match the creator's edit rule (P14).
    expect(link.internal.editFilters[tbl.orders]).toEqual(fx.ownerIsCurrentUser);
  });

  it('an admin creator gets every writable form field, never computed ones', () => {
    const link = must(
      resolveShareLinkAccess(
        creatorAccess(usr.u_admin),
        formScope([fld.title, fld.total_formula], viw.all),
      ),
    );
    expect(orders(link).fields).toEqual({ [fld.title]: 'create' });
    expect(link.internal.editFilters[tbl.orders]).toBeNull();
  });
});

describe('resolveShareLinkAccess — gone (410)', () => {
  const cases: { name: string; creator: () => ResolvedBaseAccess | null; scope: ShareLinkScope }[] =
    [
      {
        name: 'creator has no access to the base',
        creator: () => creatorAccess(usr.u_out),
        scope: viewScope(),
      },
      {
        name: 'creator may no longer share (Sales with share_link = false)',
        creator: () => creatorAccess(usr.u_sales1, fx.roles.sales),
        scope: viewScope(),
      },
      {
        name: 'system reader cannot share',
        creator: () => creatorAccess(usr.u_reader),
        scope: viewScope({ viewId: viw.all }),
      },
      {
        name: 'the view is hidden from the creator (visible_views)',
        creator: () => creatorAccess(usr.u_sales1),
        scope: viewScope({ viewId: viw.all }),
      },
      {
        name: 'the table is not readable by the creator',
        creator: () => creatorAccess(usr.u_sales1),
        scope: { ...viewScope(), tableId: tbl.customers },
      },
      {
        name: 'a form whose creator lost `add`',
        creator: () =>
          creatorAccess(
            usr.u_sales1,
            salesVariant((config) => {
              const rule = config.tables?.[tbl.orders];
              if (rule?.record_rule !== undefined) {
                rule.record_rule = { ...rule.record_rule, operations: [] };
              }
            }),
          ),
        scope: formScope([fld.title]),
      },
    ];

  it.each(cases)('$name → null', ({ creator, scope }) => {
    expect(resolveShareLinkAccess(creator(), scope)).toBeNull();
  });
});

describe('resolveShareLinkAccess — dashboard links (T809, SPEC §15A.2, P71)', () => {
  const dsh = newId('dsh');
  const other = newId('dsh');
  const known = [dsh, other];
  const salesWithDashboard = (patch: (config: RoleConfigInput) => void = () => undefined) =>
    salesVariant((config) => {
      config.dashboards = { [dsh]: 'read_only' };
      patch(config);
    });
  const dashboardScope = (tableIds: Id<'tbl'>[] = [tbl.orders, tbl.customers]): ShareLinkScope => ({
    kind: 'dashboard',
    dashboardId: dsh,
    tableIds,
  });

  it("P71: a Sales link reads the dashboard's tables as u_sales1 reads them, read only", () => {
    const link = must(
      resolveShareLinkAccess(
        creatorAccess(usr.u_sales1, salesWithDashboard(), known),
        dashboardScope(),
      ),
    );
    // Sales does not read Customers: the link neither.
    expect(Object.keys(link.access.tables)).toEqual([tbl.orders]);
    const table = orders(link);
    expect(table.perm).toBe('read_only');
    expect(table.operations).toEqual([]);
    expect(table.view_rule).toEqual({ allow_edit: false, visible_views: [] });
    expect(table.fields[fld.cost]).toBeUndefined();
    expect(table.fields[fld.amount]).toBe('read');
    expect(Object.values(table.fields).every((perm) => perm === 'read')).toBe(true);
    expect(table.option_edit_fields).toEqual([]);
    expect(table.file_download_fields).toEqual([]);
    // The creator's read rule (`editable` → their edit filter) keeps applying.
    expect(link.internal.readFilters[tbl.orders]).toEqual(fx.ownerIsCurrentUser);
    expect(link.internal.editFilters).toEqual({});
    expect(link.access.dashboards).toEqual({ [dsh]: 'read_only' });
    expect(link.access.base_rule).toEqual({ copy: false, download: false, share_link: false });
    expect(link.access.is_admin).toBe(false);
  });

  it('an admin link reads every field of the tables the dashboard names, and only those', () => {
    const link = must(
      resolveShareLinkAccess(
        creatorAccess(usr.u_admin, salesVariant(), known),
        dashboardScope([tbl.customers]),
      ),
    );
    expect(Object.keys(link.access.tables)).toEqual([tbl.customers]);
    expect(link.access.tables[tbl.customers]?.fields).toEqual({
      [fld.name]: 'read',
      [fld.phone]: 'read',
    });
    expect(link.internal.readFilters).toEqual({ [tbl.customers]: null });
  });

  it('a dashboard without tables (text only) gives an access without tables', () => {
    const link = must(
      resolveShareLinkAccess(creatorAccess(usr.u_admin, salesVariant(), known), dashboardScope([])),
    );
    expect(link.access.tables).toEqual({});
  });

  it.each([
    {
      name: 'creator lost the dashboard (`dashboards.<id>` no longer read_only)',
      creator: () => creatorAccess(usr.u_sales1, salesVariant(), known),
    },
    {
      name: 'creator reads another dashboard only',
      creator: () =>
        creatorAccess(
          usr.u_sales1,
          salesVariant((config) => {
            config.dashboards = { [other]: 'read_only' };
          }),
          known,
        ),
    },
    {
      name: 'creator may no longer share',
      creator: () =>
        creatorAccess(
          usr.u_sales1,
          salesWithDashboard((config) => {
            config.base_rule = { copy: false, download: false, share_link: false };
          }),
          known,
        ),
    },
    { name: 'creator has no access to the base', creator: () => null },
  ])('$name → null', ({ creator }) => {
    expect(resolveShareLinkAccess(creator(), dashboardScope())).toBeNull();
  });

  it('canReadDashboard: base admins, or `dashboards.<id> = read_only`', () => {
    expect(
      canReadDashboard(must(creatorAccess(usr.u_admin, salesVariant(), known)).access, dsh),
    ).toBe(true);
    const sales = must(creatorAccess(usr.u_sales1, salesWithDashboard(), known)).access;
    expect(canReadDashboard(sales, dsh)).toBe(true);
    expect(canReadDashboard(sales, other)).toBe(false);
    expect(
      canReadDashboard(must(creatorAccess(usr.u_sales1, salesVariant(), known)).access, dsh),
    ).toBe(false);
  });
});

describe('share link helpers', () => {
  it('canShareLinks: admin or base_rule.share_link', () => {
    expect(canShareLinks(must(creatorAccess(usr.u_admin)).access)).toBe(true);
    expect(canShareLinks(must(creatorAccess(usr.u_editor)).access)).toBe(true);
    expect(canShareLinks(must(creatorAccess(usr.u_reader)).access)).toBe(false);
    expect(canShareLinks(must(creatorAccess(usr.u_sales1)).access)).toBe(true);
    expect(canShareLinks(must(creatorAccess(usr.u_sales1, fx.roles.sales)).access)).toBe(false);
  });

  it.each([
    ['allowed', 'view', true],
    ['allowed', 'form', true],
    ['forms_only', 'view', false],
    ['forms_only', 'form', true],
    ['disabled', 'view', false],
    ['disabled', 'form', false],
  ] as const)('publicSharingAllows(%s, %s) = %s', (policy, target, expected) => {
    expect(publicSharingAllows(policy, target)).toBe(expected);
  });

  const now = new Date('2026-09-24T10:00:00.000Z');
  const past = new Date('2026-09-24T09:59:59.999Z');
  const future = new Date('2026-09-25T00:00:00.000Z');
  it.each([
    [{ enabled: true, expiresAt: null, revokedAt: null }, 'active'],
    [{ enabled: true, expiresAt: future, revokedAt: null }, 'active'],
    [{ enabled: true, expiresAt: now, revokedAt: null }, 'expired'],
    [{ enabled: true, expiresAt: past, revokedAt: null }, 'expired'],
    [{ enabled: false, expiresAt: past, revokedAt: null }, 'disabled'],
    [{ enabled: true, expiresAt: null, revokedAt: past }, 'revoked'],
    [{ enabled: false, expiresAt: null, revokedAt: past }, 'revoked'],
  ] as const)('shareLinkState(%o) = %s', (link, expected) => {
    expect(shareLinkState(link, now)).toBe(expected);
  });
});
