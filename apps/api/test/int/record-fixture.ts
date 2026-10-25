import { newId, type Id } from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  GroupMembersRepository,
  GroupsRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
  type JsonObject,
  type TableRow,
} from '@cellhive/server-core';
import { expect } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { problemOf, type TestApp } from './support.js';

import type { RoleConfigInput } from '@cellhive/permissions';
import type { LightMyRequestResponse } from 'fastify';

export const FIXTURE_USERS = [
  'u_admin',
  'u_editor',
  'u_reader',
  'u_sales1',
  'u_sales2',
  'u_out',
] as const;
export type FixtureUser = (typeof FIXTURE_USERS)[number] | 'owner' | 'stranger';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * The permission fixture of CONTRACTS §5 behind the real HTTP API, plus the
 * `Tickets` table of the CONTRACTS §1.4 examples. Tables and fields are
 * created with `SchemaService` (their API is T103) and the custom `Sales`
 * role straight through the repositories (its API is T109).
 */
export interface RecordFixture {
  readonly orgId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly users: Record<FixtureUser, SeededUser>;
  readonly orders: TableRow;
  readonly customers: TableRow;
  readonly tickets: TableRow;
  readonly fld: Record<string, FieldRow>;
  call(
    user: FixtureUser,
    method: Method,
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  /** The session cookie header of `user` (signed in on first use), e.g. for WebSockets. */
  cookie(user: FixtureUser): Promise<string>;
}

/** `status` + `code` of a problem response (compared together for clear failures). */
export function expectProblem(
  response: LightMyRequestResponse,
  status: number,
  code: string,
): void {
  expect({ status: response.statusCode, code: problemOf(response.body).code }).toEqual({
    status,
    code,
  });
}

/** Rate limits high enough that a fast test run never trips them. */
export function relaxRateLimits(t: TestApp): void {
  const limits = t.app.get(ApiRateLimits);
  limits.perPrincipal = { limit: 100_000, windowSeconds: 1 };
  limits.perBase = { limit: 100_000, windowSeconds: 1 };
}

export async function buildRecordFixture(t: TestApp, db: Db): Promise<RecordFixture> {
  relaxRateLimits(t);
  const orgId = await seedOrg(db, 'Records');
  const otherOrg = await seedOrg(db, 'Elsewhere');
  const member = { memberships: [{ orgId, role: 'member' as const }] };
  const users = {
    owner: await seedUser(db, { memberships: [{ orgId, role: 'owner' }], displayName: 'Owner' }),
    stranger: await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] }),
  } as Record<FixtureUser, SeededUser>;
  for (const key of FIXTURE_USERS) {
    users[key] = await seedUser(db, { ...member, displayName: key.replace('u_', 'User ') });
  }

  const browsers = new Map<FixtureUser, Browser>();
  const browserOf = async (user: FixtureUser): Promise<Browser> => {
    let browser = browsers.get(user);
    if (browser === undefined) {
      browser = new Browser(t.app);
      expect((await browser.login(users[user].email)).statusCode).toBe(204);
      browsers.set(user, browser);
    }
    return browser;
  };
  const cookie: RecordFixture['cookie'] = async (user) => (await browserOf(user)).cookieHeader();
  const call: RecordFixture['call'] = async (user, method, url, payload, headers) => {
    const browser = await browserOf(user);
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
      ...(headers === undefined ? {} : { headers }),
    });
  };

  const workspace = await call('owner', 'POST', `/orgs/${orgId}/workspaces`, { name: 'Sales' });
  expect(workspace.statusCode).toBe(201);
  const workspaceId = workspace.json<{ id: Id<'wsp'> }>().id;
  const base = await call('owner', 'POST', `/workspaces/${workspaceId}/bases`, { name: 'B' });
  expect(base.statusCode).toBe(201);
  const baseId = base.json<{ id: Id<'bse'> }>().id;

  const scope = orgScope(orgId);
  const schema = t.app.get(SchemaService);
  const context = systemAuditContext();
  const add = (tableId: Id<'tbl'>, name: string, type: string, options: unknown = {}) =>
    schema.addField(scope, tableId, { name, type, options }, context);

  // CONTRACTS §5: Orders and Customers (link/formula fields arrive in S4).
  const { table: orders, primaryField: title } = await schema.createTable(
    scope,
    { baseId, name: 'Orders', primaryFieldName: 'title' },
    context,
  );
  const amount = await add(orders.id, 'amount', 'number');
  const cost = await add(orders.id, 'cost', 'number');
  const status = await add(orders.id, 'status', 'select', {
    options: [
      { id: newId('opt'), name: 'Mới' },
      { id: newId('opt'), name: 'Xong' },
    ],
  });
  const owner = await add(orders.id, 'owner', 'user', { multiple: false });
  const { table: customers, primaryField: customerName } = await schema.createTable(
    scope,
    { baseId, name: 'Customers', primaryFieldName: 'Tên' },
    context,
  );
  const customerCode = await add(customers.id, 'Mã khách hàng', 'text');

  // CONTRACTS §1.4: Tickets.
  const { table: tickets, primaryField: ticketTitle } = await schema.createTable(
    scope,
    { baseId, name: 'Tickets', primaryFieldName: 'Tiêu đề' },
    context,
  );
  const ticketStatus = await add(tickets.id, 'Trạng thái', 'select', {
    options: [
      { id: newId('opt'), name: 'Mới' },
      { id: newId('opt'), name: 'Đang xử lý' },
      { id: newId('opt'), name: 'Đã xong' },
    ],
  });
  const ticketAmount = await add(tickets.id, 'Số tiền', 'number', {
    style: { type: 'currency', currency_code: 'VND' },
  });
  const due = await add(tickets.id, 'Hạn', 'datetime', { style: { format: 'dd/MM/yyyy' } });
  const code = await add(tickets.id, 'Mã ticket', 'auto_number', {
    style: {
      rules: [
        { type: 'text', text: 'TK-' },
        { type: 'created_time', date_format: 'yyyyMMdd' },
        { type: 'text', text: '-' },
        { type: 'incremental_number', length: 4 },
      ],
    },
  });

  // Roles: system roles of the base by user, the custom Sales role by group.
  const roles = await new BaseRolesRepository(db).listByBase(scope, baseId);
  const roleOf = (kind: string) => {
    const role = roles.find((item) => item.kind === kind);
    if (role === undefined) throw new Error(`missing ${kind}`);
    return role.id;
  };
  const salesConfig: RoleConfigInput = {
    base_rule: { copy: false, download: false, share_link: false },
    tables: {
      [orders.id]: {
        perm: 'edit',
        view_rule: { allow_edit: false, visible_views: null },
        record_rule: {
          operations: ['add'],
          edit_filter: {
            op: 'and',
            items: [{ field: owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
          },
          read_scope: 'editable',
          read_filter: null,
        },
        field_rule: {
          mode: 'specify',
          fields: { [cost.id]: 'no_perm', [status.id]: 'read' },
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
    },
    dashboards: {},
  };
  const sales = await new BaseRolesRepository(db).create(scope, {
    baseId,
    name: 'Sales',
    kind: 'custom',
    config: salesConfig as unknown as JsonObject,
  });
  const group = await new GroupsRepository(db).create(scope, { name: 'g_sales' });
  const groupMembers = new GroupMembersRepository(db);
  await groupMembers.add(scope, group.id, users.u_sales1.id);
  await groupMembers.add(scope, group.id, users.u_sales2.id);
  const assignments = new BaseRoleMembersRepository(db);
  const assign = (
    roleId: Id<'rol'>,
    principalType: 'user' | 'group',
    principalId: Id<'usr'> | Id<'grp'>,
  ) => assignments.assign(scope, { baseId, roleId, principalType, principalId });
  await assign(roleOf('system_admin'), 'user', users.u_admin.id);
  await assign(roleOf('system_editor'), 'user', users.u_editor.id);
  await assign(roleOf('system_reader'), 'user', users.u_reader.id);
  await assign(sales.id, 'group', group.id);

  return {
    orgId,
    baseId,
    users,
    orders,
    customers,
    tickets,
    fld: {
      title,
      amount,
      cost,
      status,
      owner,
      customerName,
      customerCode,
      ticketTitle,
      ticketStatus,
      ticketAmount,
      due,
      code,
    },
    call,
    cookie,
  };
}
