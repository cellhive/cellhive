import {
  baseDetailSchema,
  baseMemberListSchema,
  shareFormMemberListSchema,
  shareMetaSchema,
  createdShareLinkSchema,
  fieldListSchema,
  fieldSchema,
  formSubmissionStatusSchema,
  formSubmitResponseSchema,
  formSubmitTokenSchema,
  recordHistoryResponseSchema,
  recordSchema,
  recordListResponseSchema,
  roleListSchema,
  roleSchema,
  tableSchema,
  viewListSchema,
  viewSchema,
  workspaceSchema,
  type CreatedShareLinkDto,
  type FieldDto,
  type Id,
  type RoleDto,
  type TableDto,
  type ViewDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { FormSpamGuard } from '../../src/modules/form/form-spam-guard.js';

import { Browser, seedOrg, seedUser, uniqueIp, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen, TestSocket } from './realtime-support.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T306: form submissions by members (`POST /views/:id/submit`) and through
 * share links (`POST /shares/:token/submit`): record creation through the
 * record service, permissions (404/403/410), actor + history + event +
 * audit, validation, anti-spam (rate limit, submit token, honeypot, size),
 * sign-in and per-person limits across time zone boundaries, realtime.
 */
describe('form submissions (T306)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let guard: FormSpamGuard;
  let org: Id<'org'>;
  let owner: SeededUser;
  let editor: SeededUser;
  let reader: SeededUser;
  let sales1: SeededUser;
  let sales2: SeededUser;
  let outsider: SeededUser;
  let stranger: SeededUser;
  let baseId: Id<'bse'>;
  let orders: TableDto;
  let primary: FieldDto;
  const f = {} as Record<'amount' | 'cost' | 'status' | 'owner' | 'note', FieldDto>;
  let form: ViewDto;
  let hiddenForm: ViewDto;
  let grid: ViewDto;
  let link: CreatedShareLinkDto;
  const browsers = new Map<string, Browser>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    guard = t.app.get(FormSpamGuard);
    guard.minFillMs = 0;
    guard.perMinute = { limit: 100_000, windowSeconds: 60 };
    // Submit tokens count against the per-IP share read limit (T319); one test checks it.
    t.app.get(ShareRateLimits).read = { limit: 100_000, windowSeconds: 1 };
    org = await seedOrg(db, 'Forms');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    editor = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    sales1 = await seedUser(db, member('member'));
    sales2 = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

    expect(
      (
        await call(owner, 'PATCH', `/orgs/${org}`, {
          settings: { timezone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
        })
      ).statusCode,
    ).toBe(200);
    const workspace = workspaceSchema.parse(
      (await call(owner, 'POST', `/orgs/${org}/workspaces`, { name: 'Main' })).json(),
    );
    baseId = baseDetailSchema.parse(
      (await call(owner, 'POST', `/workspaces/${workspace.id}/bases`, { name: 'CRM' })).json(),
    ).id;
    orders = tableSchema.parse(
      (await call(owner, 'POST', `/bases/${baseId}/tables`, { name: 'Orders' })).json(),
    );
    const field = async (body: object) => {
      const response = await call(owner, 'POST', `/tables/${orders.id}/fields`, body);
      expect(response.statusCode, response.body).toBe(201);
      return fieldSchema.parse(response.json());
    };
    f.amount = await field({ name: 'amount', type: 'number' });
    f.cost = await field({ name: 'cost', type: 'number' });
    f.status = await field({
      name: 'status',
      type: 'select',
      options: { options: [{ name: 'New' }, { name: 'Done' }] },
    });
    f.owner = await field({ name: 'owner', type: 'user', options: { multiple: false } });
    f.note = await field({ name: 'note', type: 'text' });
    primary = fieldListSchema
      .parse((await call(owner, 'GET', `/tables/${orders.id}/fields`)).json())
      .items.find((item) => item.is_primary) as FieldDto;

    grid = viewListSchema.parse((await call(owner, 'GET', `/tables/${orders.id}/views`)).json())
      .items[0] as ViewDto;
    form = await createView({
      name: 'Order form',
      type: 'form',
      config: {
        form: {
          fields: [
            { field: primary.id, required: true },
            { field: f.amount.id },
            { field: f.status.id },
            { field: f.owner.id },
            { field: f.note.id },
          ],
          success_message: 'Thanks!',
          redirect_url: 'https://example.com/done',
        },
      },
    });
    hiddenForm = await createView({ name: 'Hidden form', type: 'form' });

    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    const roleOf = (kind: string) => roles.items.find((item) => item.kind === kind) as RoleDto;
    await assign(editor, roleOf('system_editor').id);
    await assign(reader, roleOf('system_reader').id);
    const sales = await createSalesRole();
    await assign(sales1, sales.id);
    await assign(sales2, sales.id);

    link = await createLink(owner, form.id, { audience: 'public' });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- helpers ----------------------------------------------------------------------

  async function as(user: SeededUser): Promise<Browser> {
    let browser = browsers.get(user.id);
    if (browser === undefined) {
      browser = new Browser(t.app);
      expect((await browser.login(user.email)).statusCode).toBe(204);
      browsers.set(user.id, browser);
    }
    return browser;
  }

  async function call(
    user: SeededUser,
    method: Method,
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return (await as(user)).request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async function assign(user: SeededUser, roleId: Id<'rol'>): Promise<void> {
    const response = await call(owner, 'PUT', `/bases/${baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: user.id,
      role_id: roleId,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function createView(body: Record<string, unknown>): Promise<ViewDto> {
    const response = await call(owner, 'POST', `/tables/${orders.id}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  async function patchForm(view: ViewDto, formConfig: object): Promise<void> {
    const response = await call(owner, 'PATCH', `/views/${view.id}`, {
      config: { form: formConfig },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Sales of CONTRACTS §5 (P13/P14), seeing the form but not the hidden one. */
  async function createSalesRole(): Promise<RoleDto> {
    const response = await call(owner, 'POST', `/bases/${baseId}/roles`, {
      name: 'Sales',
      config: {
        base_rule: { copy: false, download: false, share_link: false },
        tables: {
          [orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: [form.id, grid.id] },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  { field: f.owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                ],
              },
              read_scope: 'editable',
            },
            field_rule: {
              mode: 'specify',
              fields: { [f.cost.id]: 'no_perm', [f.status.id]: 'read' },
            },
          },
        },
        dashboards: {},
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return roleSchema.parse(response.json());
  }

  async function createLink(
    user: SeededUser,
    viewId: Id<'viw'>,
    body: object,
  ): Promise<CreatedShareLinkDto> {
    const response = await call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    return createdShareLinkSchema.parse(response.json());
  }

  /** An anonymous browser at a fresh IP (or `ip`). */
  function anonymous(ip: string = uniqueIp()): Browser {
    return new Browser(t.app, ip);
  }

  async function submitToken(token: string, browser: Browser = anonymous()): Promise<string> {
    const response = await browser.request({
      method: 'GET',
      url: `/api/v1/shares/${token}/submit-token`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return formSubmitTokenSchema.parse(response.json()).submit_token;
  }

  /** Submits through a link, fetching a submit token first unless `body` has one. */
  async function submitLink(
    token: string,
    body: Record<string, unknown>,
    browser: Browser = anonymous(),
  ): Promise<LightMyRequestResponse> {
    const submit_token =
      'submit_token' in body ? body['submit_token'] : await submitToken(token, browser);
    return browser.request({
      method: 'POST',
      url: `/api/v1/shares/${token}/submit`,
      payload: { ...body, submit_token },
    });
  }

  function submitMember(
    user: SeededUser,
    viewId: Id<'viw'>,
    body: object,
  ): Promise<LightMyRequestResponse> {
    return call(user, 'POST', `/views/${viewId}/submit`, body);
  }

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: { path?: string; code: string },
  ): Record<string, unknown> {
    const problem = problemOf(response.body);
    expect({ status: response.statusCode, code: problem.code }, response.body).toEqual({
      status,
      code,
    });
    if (detail !== undefined) {
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: detail.code,
            ...(detail.path === undefined ? {} : { path: detail.path }),
          }),
        ]),
      );
    }
    return problem;
  }

  async function recordsTitled(
    title: string,
  ): Promise<{ id: Id<'rec'>; fields: Record<string, unknown> }[]> {
    const response = await call(
      owner,
      'POST',
      `/tables/${orders.id}/records/query?field_key_type=id`,
      {
        filter: { op: 'and', items: [{ field: primary.id, operator: 'eq', value: title }] },
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records;
  }

  async function onlyRecord(
    title: string,
  ): Promise<{ id: Id<'rec'>; fields: Record<string, unknown> }> {
    const found = await recordsTitled(title);
    expect(found).toHaveLength(1);
    return found[0] as { id: Id<'rec'>; fields: Record<string, unknown> };
  }

  // --- tests ------------------------------------------------------------------------

  describe('through a public link', () => {
    it('creates the record as the link, with history, form.submitted and audit', async () => {
      const response = await submitLink(link.token, {
        fields: { [primary.id]: 'public-1', [f.amount.id]: '1.500', [f.note.id]: 'hi' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(formSubmitResponseSchema.strict().parse(response.json())).toEqual({
        success_message: 'Thanks!',
        redirect_url: 'https://example.com/done',
      });
      const record = await onlyRecord('public-1');
      // Typecast with the base locale (`vi`): "1.500" is 1500.
      expect(record.fields[f.amount.id]).toBe(1500);

      const history = recordHistoryResponseSchema.parse(
        (await call(owner, 'GET', `/tables/${orders.id}/records/${record.id}/history`)).json(),
      );
      expect(history.items[0]).toMatchObject({
        action: 'record.created',
        actor: { type: 'share_link', id: link.id, name: 'Order form' },
        via: { share_link_id: link.id },
      });

      const events = await sql<{
        actor_type: string;
        actor_id: string;
        payload: Record<string, unknown>;
      }>`
        SELECT actor_type, actor_id, payload FROM meta.events
        WHERE type = 'form.submitted' AND entity_id = ${form.id}
      `.execute(db.kysely);
      expect(events.rows).toContainEqual(
        expect.objectContaining({
          actor_type: 'share_link',
          actor_id: link.id,
          payload: expect.objectContaining({
            data: expect.objectContaining({
              record_id: record.id,
              share_link_id: link.id,
              submitted_by: null,
            }) as unknown,
          }) as unknown,
        }),
      );
      const audit = await sql<{ action: string; via: unknown }>`
        SELECT action, via FROM meta.audit_logs
        WHERE entity_id IN (${record.id}, ${form.id})
          AND action IN ('form.submitted', 'record.created')
        ORDER BY action
      `.execute(db.kysely);
      expect(audit.rows).toEqual([
        { action: 'form.submitted', via: { share_link_id: link.id } },
        { action: 'record.created', via: { share_link_id: link.id } },
      ]);
      // Anonymous: no creator.
      const created = await sql<{ n: string }>`
        SELECT count(*) AS n FROM meta.form_submissions WHERE record_id = ${record.id}
      `.execute(db.kysely);
      expect(Number(created.rows[0]?.n)).toBe(0);
    });

    it('rejects fields outside the form, missing required fields and wrong values (422)', async () => {
      expectProblem(
        await submitLink(link.token, { fields: { [primary.id]: 'x', [f.cost.id]: 3 } }),
        422,
        'VALIDATION_FAILED',
        { path: `fields.${f.cost.id}`, code: 'UNKNOWN_FIELD' },
      );
      expectProblem(
        await submitLink(link.token, { fields: { [f.note.id]: 'no title' } }),
        422,
        'REQUIRED_FIELD_MISSING',
        { path: `fields.${primary.id}`, code: 'REQUIRED_FIELD_MISSING' },
      );
      expectProblem(
        await submitLink(link.token, { fields: { [primary.id]: 'bad', [f.amount.id]: 'abc' } }),
        422,
        'INVALID_CELL_VALUE',
        { path: `fields.${f.amount.id}`, code: 'EXPECTED_NUMBER' },
      );
      // Options are never created through a form.
      expectProblem(
        await submitLink(link.token, {
          fields: { [primary.id]: 'opt', [f.status.id]: 'Brand new' },
        }),
        422,
        'INVALID_SELECT_OPTION',
        { path: `fields.${f.status.id}`, code: 'INVALID_SELECT_OPTION' },
      );
      expect(await recordsTitled('bad')).toEqual([]);
    });

    it('writes prefilled values (strings, typecast) including hidden fields', async () => {
      // `?prefill_<id>=…&hide_<id>=1`: the page sends them with the other values.
      const response = await submitLink(link.token, {
        fields: {
          [primary.id]: 'prefilled',
          [f.status.id]: 'Done',
          [f.note.id]: 'campaign-7',
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const record = await onlyRecord('prefilled');
      expect(record.fields).toMatchObject({
        [f.status.id]: 'Done',
        [f.note.id]: 'campaign-7',
      });
    });

    it('answers 429 to the 11th submission in a minute from one IP', async () => {
      guard.perMinute = { limit: 10, windowSeconds: 60 };
      try {
        const ip = uniqueIp();
        for (let index = 0; index < 10; index += 1) {
          const browser = anonymous(ip);
          const response = await submitLink(
            link.token,
            { fields: { [primary.id]: `burst-${String(index)}` } },
            browser,
          );
          expect(response.statusCode, response.body).toBe(200);
        }
        const response = await submitLink(
          link.token,
          { fields: { [primary.id]: 'burst-11' } },
          anonymous(ip),
        );
        expectProblem(response, 429, 'RATE_LIMITED');
        expect(response.headers['retry-after']).toBeDefined();
        // Another IP is not affected.
        expect(
          (await submitLink(link.token, { fields: { [primary.id]: 'burst-other' } })).statusCode,
        ).toBe(200);
      } finally {
        guard.perMinute = { limit: 100_000, windowSeconds: 60 };
      }
    });

    it('needs a fresh, single-use submit token of the same link', async () => {
      expectProblem(
        await submitLink(link.token, { fields: { [primary.id]: 'tok' }, submit_token: undefined }),
        422,
        'VALIDATION_FAILED',
        { path: 'submit_token', code: 'SUBMIT_TOKEN_INVALID' },
      );
      const token = await submitToken(link.token);
      expect(
        (await submitLink(link.token, { fields: { [primary.id]: 'tok-1' }, submit_token: token }))
          .statusCode,
      ).toBe(200);
      expectProblem(
        await submitLink(link.token, { fields: { [primary.id]: 'tok-2' }, submit_token: token }),
        422,
        'VALIDATION_FAILED',
        { code: 'SUBMIT_TOKEN_INVALID' },
      );
      // A failed submission gives the token back.
      const retry = await submitToken(link.token);
      expect(
        (await submitLink(link.token, { fields: { [f.note.id]: 'x' }, submit_token: retry }))
          .statusCode,
      ).toBe(422);
      expect(
        (await submitLink(link.token, { fields: { [primary.id]: 'tok-3' }, submit_token: retry }))
          .statusCode,
      ).toBe(200);
      // Forged / tampered.
      expectProblem(
        await submitLink(link.token, {
          fields: { [primary.id]: 'tok-4' },
          submit_token: `${retry.slice(0, -2)}${retry.endsWith('AA') ? 'BB' : 'AA'}`,
        }),
        422,
        'VALIDATION_FAILED',
        { code: 'SUBMIT_TOKEN_INVALID' },
      );
      // Too fast.
      guard.minFillMs = 60_000;
      try {
        const problem = expectProblem(
          await submitLink(link.token, { fields: { [primary.id]: 'tok-5' } }),
          422,
          'VALIDATION_FAILED',
          { path: 'submit_token', code: 'SUBMITTED_TOO_FAST' },
        );
        expect(JSON.stringify(problem)).toContain('retry_after_ms');
      } finally {
        guard.minFillMs = 0;
      }
      expect(await recordsTitled('tok-2')).toEqual([]);
      expect(await recordsTitled('tok-5')).toEqual([]);
    });

    it('drops honeypot submissions silently and refuses oversized bodies', async () => {
      const response = await submitLink(link.token, {
        fields: { [primary.id]: 'honey' },
        honeypot: 'https://spam.example',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success_message: 'Thanks!',
        redirect_url: 'https://example.com/done',
      });
      expect(await recordsTitled('honey')).toEqual([]);

      expectProblem(
        await submitLink(link.token, {
          fields: { [primary.id]: 'big', [f.note.id]: 'x'.repeat(300 * 1024) },
        }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
    });

    it('answers 404 for unknown tokens and view links, 410 for gone links', async () => {
      expectProblem(
        await anonymous().request({
          method: 'POST',
          url: `/api/v1/shares/${'A'.repeat(43)}/submit`,
          payload: { fields: {} },
        }),
        404,
        'NOT_FOUND',
      );
      const viewLink = await createLink(owner, grid.id, { audience: 'public' });
      expectProblem(
        await anonymous().request({
          method: 'GET',
          url: `/api/v1/shares/${viewLink.token}/submit-token`,
        }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await anonymous().request({
          method: 'POST',
          url: `/api/v1/shares/${viewLink.token}/submit`,
          payload: { fields: {} },
        }),
        404,
        'NOT_FOUND',
      );

      // The creator loses the right to share: the link is gone.
      const editorForm = await createView({ name: 'Editor form', type: 'form' });
      const editorLink = await createLink(editor, editorForm.id, { audience: 'public' });
      expect(
        (await submitLink(editorLink.token, { fields: { [primary.id]: 'editor-ok' } })).statusCode,
      ).toBe(200);
      const token = await submitToken(editorLink.token);
      const roles = roleListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/roles`)).json(),
      );
      await assign(
        editor,
        (roles.items.find((item) => item.kind === 'system_reader') as RoleDto).id,
      );
      try {
        expectProblem(
          await submitLink(editorLink.token, {
            fields: { [primary.id]: 'editor-gone' },
            submit_token: token,
          }),
          410,
          'SHARE_LINK_GONE',
        );
      } finally {
        await assign(
          editor,
          (roles.items.find((item) => item.kind === 'system_editor') as RoleDto).id,
        );
      }
      expect(await recordsTitled('editor-gone')).toEqual([]);
    });

    it('sends record.created to table subscribers', async () => {
      const url = await listen(t.app);
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: (await as(owner)).cookieHeader(),
      });
      try {
        expect(await socket.subscribe(`table:${orders.id}`)).toMatchObject({ type: 'subscribed' });
        expect(
          (await submitLink(link.token, { fields: { [primary.id]: 'live' } })).statusCode,
        ).toBe(200);
        const message = await socket.next((item) => item.type === 'record.created');
        expect(message).toMatchObject({
          type: 'record.created',
          channel: `table:${orders.id}`,
          actor_id: null,
          fields: expect.objectContaining({ [primary.id]: 'live' }) as unknown,
        });
      } finally {
        socket.close();
      }
    });
  });

  describe('sign-in: org links and require_login', () => {
    it('org links need a member of the organization; they are the actor', async () => {
      const orgForm = await createView({ name: 'Org form', type: 'form' });
      const orgLink = await createLink(owner, orgForm.id, { audience: 'org' });
      // The submit token is checked like the other share reads (T319): no token for
      // people who could not submit anyway.
      const tokenOf = async (browser: Browser) =>
        browser.request({ method: 'GET', url: `/api/v1/shares/${orgLink.token}/submit-token` });
      expectProblem(await tokenOf(anonymous()), 401, 'UNAUTHENTICATED');
      expectProblem(await tokenOf(await as(stranger)), 404, 'NOT_FOUND');
      const memberToken = await submitToken(orgLink.token, await as(outsider));
      expectProblem(
        await submitLink(orgLink.token, {
          fields: { [primary.id]: 'org-anon' },
          submit_token: memberToken,
        }),
        401,
        'UNAUTHENTICATED',
      );
      expectProblem(
        await submitLink(
          orgLink.token,
          { fields: { [primary.id]: 'org-stranger' }, submit_token: memberToken },
          await as(stranger),
        ),
        404,
        'NOT_FOUND',
      );
      // `outsider` has no access to the base: the link's access is used.
      const response = await submitLink(
        orgLink.token,
        { fields: { [primary.id]: 'org-member' } },
        await as(outsider),
      );
      expect(response.statusCode, response.body).toBe(200);
      const record = await onlyRecord('org-member');
      const history = recordHistoryResponseSchema.parse(
        (await call(owner, 'GET', `/tables/${orders.id}/records/${record.id}/history`)).json(),
      );
      expect(history.items[0]).toMatchObject({
        actor: { type: 'user', id: outsider.id },
        via: { share_link_id: orgLink.id },
      });
      const creator = await sql<{ created_by: string | null }>`
        SELECT actor_id AS created_by FROM meta.events
        WHERE type = 'record.created' AND entity_id = ${record.id}
      `.execute(db.kysely);
      expect(creator.rows[0]?.created_by).toBe(outsider.id);
    });

    it('require_login refuses anonymous people and records who submitted', async () => {
      const loginForm = await createView({ name: 'Login form', type: 'form' });
      await patchForm(loginForm, { require_login: true });
      const loginLink = await createLink(owner, loginForm.id, { audience: 'public' });
      expectProblem(
        await submitLink(loginLink.token, { fields: { [primary.id]: 'login-anon' } }),
        401,
        'UNAUTHENTICATED',
      );
      // Any signed-in user of the instance may submit a public form.
      const response = await submitLink(
        loginLink.token,
        { fields: { [primary.id]: 'login-stranger' } },
        await as(stranger),
      );
      expect(response.statusCode, response.body).toBe(200);
      const record = await onlyRecord('login-stranger');
      const tracked = await sql<{ user_id: string; share_link_id: string }>`
        SELECT user_id, share_link_id FROM meta.form_submissions WHERE record_id = ${record.id}
      `.execute(db.kysely);
      expect(tracked.rows).toEqual([{ user_id: stranger.id, share_link_id: loginLink.id }]);
    });

    it('refuses a limit without require_login (422 REQUIRES_LOGIN)', async () => {
      expectProblem(
        await call(owner, 'PATCH', `/views/${hiddenForm.id}`, {
          config: { form: { submission_limit: 'daily' } },
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'config.form.submission_limit', code: 'REQUIRES_LOGIN' },
      );
    });
  });

  describe('per-person limits (base time zone Asia/Ho_Chi_Minh)', () => {
    it('daily: one submission per local day, the day turns at 17:00 UTC', async () => {
      const daily = await createView({ name: 'Daily form', type: 'form' });
      await patchForm(daily, { require_login: true, submission_limit: 'daily' });
      const at = (iso: string) => {
        guard.now = () => new Date(iso);
      };
      try {
        at('2026-09-24T16:30:00.000Z'); // 23:30 local, 24 Sep
        expect(
          (await submitMember(editor, daily.id, { fields: { [primary.id]: 'd-1' } })).statusCode,
        ).toBe(200);
        at('2026-09-24T16:59:00.000Z'); // 23:59 local, same day
        // The form can say so as soon as it opens (T320).
        const status = await call(editor, 'GET', `/views/${daily.id}/submission-status`);
        expect(status.statusCode, status.body).toBe(200);
        expect(formSubmissionStatusSchema.parse(status.json())).toEqual({
          limit: 'daily',
          reached: true,
          next_allowed_at: '2026-09-24T17:00:00.000Z',
        });
        expect(
          formSubmissionStatusSchema.parse(
            (await call(owner, 'GET', `/views/${daily.id}/submission-status`)).json(),
          ),
        ).toEqual({ limit: 'daily', reached: false, next_allowed_at: null });
        const problem = expectProblem(
          await submitMember(editor, daily.id, { fields: { [primary.id]: 'd-2' } }),
          409,
          'SUBMISSION_LIMIT_REACHED',
          { code: 'SUBMISSION_LIMIT_REACHED' },
        );
        expect(problem.errors).toEqual([
          expect.objectContaining({
            params: { limit: 'daily', next_allowed_at: '2026-09-24T17:00:00.000Z' },
          }),
        ]);
        at('2026-09-24T17:30:00.000Z'); // 00:30 local, 25 Sep (still 24 Sep in UTC)
        expect(
          (await submitMember(editor, daily.id, { fields: { [primary.id]: 'd-3' } })).statusCode,
        ).toBe(200);
        // Another person is not limited by editor's submissions.
        expect(
          (await submitMember(owner, daily.id, { fields: { [primary.id]: 'd-4' } })).statusCode,
        ).toBe(200);
        expect(await recordsTitled('d-2')).toEqual([]);
      } finally {
        guard.now = () => new Date();
      }
    });

    it('once: a second submission is refused, also through a link', async () => {
      const once = await createView({ name: 'Once form', type: 'form' });
      await patchForm(once, { require_login: true, allow_multiple_submissions: false });
      const onceLink = await createLink(owner, once.id, { audience: 'org' });
      expect(
        (await submitMember(editor, once.id, { fields: { [primary.id]: 'o-1' } })).statusCode,
      ).toBe(200);
      expectProblem(
        await submitLink(onceLink.token, { fields: { [primary.id]: 'o-2' } }, await as(editor)),
        409,
        'SUBMISSION_LIMIT_REACHED',
      );
      expectProblem(
        await submitMember(editor, once.id, { fields: { [primary.id]: 'o-3' } }),
        409,
        'SUBMISSION_LIMIT_REACHED',
        { code: 'SUBMISSION_LIMIT_REACHED' },
      );
      expect(await recordsTitled('o-2')).toEqual([]);
    });
  });

  describe('submission status (GET /views/:id/submission-status, T320)', () => {
    it('is never reached without a limit; once: reached after the first submission', async () => {
      expect(
        formSubmissionStatusSchema.parse(
          (await call(editor, 'GET', `/views/${form.id}/submission-status`)).json(),
        ),
      ).toEqual({ limit: 'none', reached: false, next_allowed_at: null });
      const once = await createView({ name: 'Once status form', type: 'form' });
      await patchForm(once, { require_login: true, submission_limit: 'once' });
      const status = async (user: SeededUser) =>
        formSubmissionStatusSchema.parse(
          (await call(user, 'GET', `/views/${once.id}/submission-status`)).json(),
        );
      expect(await status(editor)).toEqual({
        limit: 'once',
        reached: false,
        next_allowed_at: null,
      });
      expect(
        (await submitMember(editor, once.id, { fields: { [primary.id]: 'status-1' } })).statusCode,
      ).toBe(200);
      expect(await status(editor)).toEqual({ limit: 'once', reached: true, next_allowed_at: null });
      // Counted per person.
      expect((await status(reader)).reached).toBe(false);
    });

    it('answers 404 like submitting: hidden forms, other views, people outside the base', async () => {
      const get = (user: SeededUser, viewId: string) =>
        call(user, 'GET', `/views/${viewId}/submission-status`);
      expectProblem(await get(sales1, hiddenForm.id), 404, 'NOT_FOUND');
      expectProblem(await get(outsider, form.id), 404, 'NOT_FOUND');
      expectProblem(await get(stranger, form.id), 404, 'NOT_FOUND');
      expectProblem(await get(owner, grid.id), 404, 'NOT_FOUND');
      expectProblem(await get(owner, 'viw_bad'), 422, 'VALIDATION_FAILED');
    });
  });

  describe('user questions through links (T321)', () => {
    const metaOf = async (token: string, browser: Browser = anonymous()) => {
      const response = await browser.request({
        method: 'GET',
        url: `/api/v1/shares/${token}/meta`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return shareMetaSchema.parse(response.json());
    };
    const membersOf = (token: string, browser: Browser = anonymous()) =>
      browser.request({ method: 'GET', url: `/api/v1/shares/${token}/members` });

    it('public links hide user questions: not in meta, not listed, refused like unknown fields', async () => {
      const loginForm = await createView({
        name: 'Public login form',
        type: 'form',
        config: { form: { fields: [{ field: primary.id }, { field: f.owner.id }] } },
      });
      await patchForm(loginForm, { require_login: true });
      const loginLink = await createLink(owner, loginForm.id, { audience: 'public' });
      for (const [token, browser] of [
        [link.token, anonymous()],
        [link.token, await as(editor)],
        [loginLink.token, await as(stranger)],
      ] as const) {
        const meta = await metaOf(token, browser);
        expect(meta.fields.map((item) => item.id)).not.toContain(f.owner.id);
        expect(meta.fields.every((item) => item.type !== 'user')).toBe(true);
        expect(meta.view.config.form?.fields.map((item) => item.field)).not.toContain(f.owner.id);
        // No member list for people outside the organization, even when signed in.
        expectProblem(await membersOf(token, browser), 404, 'NOT_FOUND');
      }
      // Any answer is refused the same way (a member id, a member email, anything):
      // it tells nothing about who is in the organization.
      for (const answer of [[{ id: sales2.id }], sales2.email, 'nobody@example.test', 'x']) {
        expectProblem(
          await submitLink(link.token, {
            fields: { [primary.id]: 'pub-user', [f.owner.id]: answer },
          }),
          422,
          'VALIDATION_FAILED',
          { path: `fields.${f.owner.id}`, code: 'UNKNOWN_FIELD' },
        );
      }
      expectProblem(
        await submitLink(
          loginLink.token,
          { fields: { [primary.id]: 'pub-user', [f.owner.id]: [{ id: sales2.id }] } },
          await as(editor),
        ),
        422,
        'VALIDATION_FAILED',
        { path: `fields.${f.owner.id}`, code: 'UNKNOWN_FIELD' },
      );
      expect(await recordsTitled('pub-user')).toEqual([]);
    });

    it('org links list the people who can open the base ({ id, display_name }, never an email)', async () => {
      const orgForm = await createView({
        name: 'Org people form',
        type: 'form',
        config: { form: { fields: [{ field: primary.id }, { field: f.owner.id }] } },
      });
      const orgLink = await createLink(owner, orgForm.id, { audience: 'org' });
      const meta = await metaOf(orgLink.token, await as(outsider));
      expect(meta.fields.map((item) => item.id)).toContain(f.owner.id);
      expect(meta.view.config.form?.fields.map((item) => item.field)).toContain(f.owner.id);

      expectProblem(await membersOf(orgLink.token), 401, 'UNAUTHENTICATED');
      expectProblem(await membersOf(orgLink.token, await as(stranger)), 404, 'NOT_FOUND');
      // `outsider` is in the organization (may fill the form in) but cannot open the base.
      const response = await membersOf(orgLink.token, await as(outsider));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const list = shareFormMemberListSchema.strict().parse(response.json());
      expect(new Set(list.items.map((item) => item.id))).toEqual(
        new Set([owner.id, editor.id, reader.id, sales1.id, sales2.id]),
      );
      for (const item of list.items) {
        expect(Object.keys(item).sort()).toEqual(['display_name', 'id']);
      }
      for (const user of [owner, editor, reader, sales1, sales2, outsider, stranger]) {
        expect(response.body).not.toContain(user.email);
      }

      // Forms without a user question and view links list nobody.
      const plainForm = await createView({
        name: 'Org plain form',
        type: 'form',
        config: { form: { fields: [{ field: primary.id }, { field: f.note.id }] } },
      });
      const plainLink = await createLink(owner, plainForm.id, { audience: 'org' });
      expectProblem(await membersOf(plainLink.token, await as(editor)), 404, 'NOT_FOUND');
      const viewLink = await createLink(owner, grid.id, { audience: 'org' });
      expectProblem(await membersOf(viewLink.token, await as(editor)), 404, 'NOT_FOUND');
      expectProblem(await membersOf('A'.repeat(43), await as(editor)), 404, 'NOT_FOUND');
    });

    it('org links accept only people who can open the base, by id', async () => {
      const orgForm = await createView({
        name: 'Org owner form',
        type: 'form',
        config: { form: { fields: [{ field: primary.id }, { field: f.owner.id }] } },
      });
      const orgLink = await createLink(owner, orgForm.id, { audience: 'org' });
      const submitter = await as(outsider);
      const sent = await submitLink(
        orgLink.token,
        { fields: { [primary.id]: 'org-owner', [f.owner.id]: [{ id: sales1.id }] } },
        submitter,
      );
      expect(sent.statusCode, sent.body).toBe(200);
      expect((await onlyRecord('org-owner')).fields[f.owner.id]).toEqual([
        expect.objectContaining({ id: sales1.id }),
      ]);
      const byId = await submitLink(
        orgLink.token,
        { fields: { [primary.id]: 'org-owner-2', [f.owner.id]: sales2.id } },
        submitter,
      );
      expect(byId.statusCode, byId.body).toBe(200);
      // Someone of the organization outside the base, another organization, an email
      // (even of a member of the base): the same refusal.
      for (const answer of [
        [{ id: outsider.id }],
        [{ id: stranger.id }],
        sales1.email,
        [{ email: sales1.email }],
      ]) {
        expectProblem(
          await submitLink(
            orgLink.token,
            { fields: { [primary.id]: 'org-owner-bad', [f.owner.id]: answer } },
            submitter,
          ),
          422,
          'INVALID_CELL_VALUE',
          { path: `fields.${f.owner.id}`, code: 'USER_NOT_FOUND' },
        );
      }
      expect(await recordsTitled('org-owner-bad')).toEqual([]);
    });
  });

  describe('submission status through links (GET /shares/:token/submission-status, T321)', () => {
    const statusOf = (token: string, browser: Browser = anonymous()) =>
      browser.request({ method: 'GET', url: `/api/v1/shares/${token}/submission-status` });

    it('anonymous forms have no limit; 404 for unknown tokens and view links; 401/404 like submit', async () => {
      const response = await statusOf(link.token);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(formSubmissionStatusSchema.parse(response.json())).toEqual({
        limit: 'none',
        reached: false,
        next_allowed_at: null,
      });
      expectProblem(await statusOf('A'.repeat(43)), 404, 'NOT_FOUND');
      const viewLink = await createLink(owner, grid.id, { audience: 'public' });
      expectProblem(await statusOf(viewLink.token), 404, 'NOT_FOUND');

      const orgForm = await createView({ name: 'Org status form', type: 'form' });
      const orgLink = await createLink(owner, orgForm.id, { audience: 'org' });
      expectProblem(await statusOf(orgLink.token), 401, 'UNAUTHENTICATED');
      expectProblem(await statusOf(orgLink.token, await as(stranger)), 404, 'NOT_FOUND');
      expect(
        formSubmissionStatusSchema.parse(
          (await statusOf(orgLink.token, await as(outsider))).json(),
        ),
      ).toEqual({ limit: 'none', reached: false, next_allowed_at: null });
    });

    it('require_login: 401 without a session; counts the person like the member route', async () => {
      const once = await createView({ name: 'Once link status form', type: 'form' });
      await patchForm(once, { require_login: true, submission_limit: 'once' });
      const onceLink = await createLink(owner, once.id, {
        audience: 'public',
        password: 'secret-123',
      });
      expectProblem(await statusOf(onceLink.token), 401, 'UNAUTHENTICATED');
      // No password needed to know it (like the submit token).
      const status = async (user: SeededUser) => {
        const response = await statusOf(onceLink.token, await as(user));
        expect(response.statusCode, response.body).toBe(200);
        return formSubmissionStatusSchema.parse(response.json());
      };
      expect(await status(stranger)).toEqual({
        limit: 'once',
        reached: false,
        next_allowed_at: null,
      });
      // A submission on the member route counts too (one count for both routes).
      const sent = await submitMember(editor, once.id, {
        fields: { [primary.id]: 'link-status-1' },
      });
      expect(sent.statusCode, sent.body).toBe(200);
      expect(await status(editor)).toEqual({ limit: 'once', reached: true, next_allowed_at: null });
      expect((await status(stranger)).reached).toBe(false);
      expect((await status(reader)).reached).toBe(false);
    });

    it('daily through an org link: next_allowed_at is the next local day', async () => {
      const daily = await createView({ name: 'Daily link status form', type: 'form' });
      await patchForm(daily, { require_login: true, submission_limit: 'daily' });
      const dailyLink = await createLink(owner, daily.id, { audience: 'org' });
      guard.now = () => new Date('2026-09-24T16:30:00.000Z'); // 23:30 local
      try {
        const submitter = await as(outsider);
        const sent = await submitLink(
          dailyLink.token,
          { fields: { [primary.id]: 'daily-link-1' } },
          submitter,
        );
        expect(sent.statusCode, sent.body).toBe(200);
        expect(
          formSubmissionStatusSchema.parse((await statusOf(dailyLink.token, submitter)).json()),
        ).toEqual({ limit: 'daily', reached: true, next_allowed_at: '2026-09-24T17:00:00.000Z' });
      } finally {
        guard.now = () => new Date();
      }
    });
  });

  describe('people who can open the base (GET /bases/:id/members, T320)', () => {
    it('lists members with access to the base, never other members of the organization', async () => {
      const response = await call(reader, 'GET', `/bases/${baseId}/members`);
      expect(response.statusCode, response.body).toBe(200);
      const ids = baseMemberListSchema.parse(response.json()).items.map((item) => item.id);
      expect(new Set(ids)).toEqual(new Set([owner.id, editor.id, reader.id, sales1.id, sales2.id]));
      expect(ids).not.toContain(outsider.id);
      const item = baseMemberListSchema
        .parse(response.json())
        .items.find((entry) => entry.id === editor.id);
      expect(item?.email).toBe(editor.email);
      expect(typeof item?.display_name).toBe('string');
    });

    it('answers 404 to people who cannot open the base', async () => {
      expectProblem(await call(outsider, 'GET', `/bases/${baseId}/members`), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', `/bases/${baseId}/members`), 404, 'NOT_FOUND');
    });
  });

  describe('members (POST /views/:id/submit)', () => {
    it('creates the record as the member', async () => {
      const response = await submitMember(editor, form.id, {
        fields: { [primary.id]: 'member-1', [f.amount.id]: 7 },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        success_message: 'Thanks!',
        redirect_url: 'https://example.com/done',
      });
      const record = await onlyRecord('member-1');
      const full = recordSchema.parse(
        (
          await call(owner, 'GET', `/tables/${orders.id}/records/${record.id}?field_key_type=id`)
        ).json(),
      );
      expect(full.id).toBe(record.id);
      const history = recordHistoryResponseSchema.parse(
        (await call(owner, 'GET', `/tables/${orders.id}/records/${record.id}/history`)).json(),
      );
      expect(history.items[0]).toMatchObject({ actor: { type: 'user', id: editor.id }, via: null });
    });

    it('P13/P14: Sales may only submit records they own', async () => {
      expectProblem(
        await submitMember(sales1, form.id, {
          fields: { [primary.id]: 'sales-other', [f.owner.id]: [{ id: sales2.id }] },
        }),
        403,
        'RECORD_RULE_VIOLATION',
      );
      expect(
        (
          await submitMember(sales1, form.id, {
            fields: { [primary.id]: 'sales-own', [f.owner.id]: [{ id: sales1.id }] },
          })
        ).statusCode,
      ).toBe(200);
      // `status` is read-only for Sales.
      expectProblem(
        await submitMember(sales1, form.id, {
          fields: {
            [primary.id]: 'sales-status',
            [f.status.id]: 'New',
            [f.owner.id]: [{ id: sales1.id }],
          },
        }),
        403,
        'FIELD_READ_ONLY',
      );
    });

    it('readers get 403; invisible forms and other views 404', async () => {
      expectProblem(
        await submitMember(reader, form.id, { fields: { [primary.id]: 'reader' } }),
        403,
        'PERMISSION_DENIED',
      );
      // Outside Sales' visible_views.
      expectProblem(
        await submitMember(sales1, hiddenForm.id, { fields: { [primary.id]: 'hidden' } }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await submitMember(outsider, form.id, { fields: { [primary.id]: 'outsider' } }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await submitMember(stranger, form.id, { fields: { [primary.id]: 'stranger' } }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await submitMember(owner, grid.id, { fields: { [primary.id]: 'grid' } }),
        404,
        'NOT_FOUND',
      );
      expect(await recordsTitled('reader')).toEqual([]);
    });
  });
});
