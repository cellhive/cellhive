import {
  auditLogListSchema,
  baseDetailSchema,
  createdShareLinkSchema,
  fieldListSchema,
  fieldSchema,
  recordHistoryResponseSchema,
  recordsResponseSchema,
  revokeShareLinksResponseSchema,
  roleListSchema,
  roleSchema,
  shareLinkListSchema,
  shareLinkPreviewSchema,
  shareLinkSchema,
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
import { RecordMutationService, RecordQueryService, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareLinkResolver } from '../../src/modules/share-link/share-link-resolver.service.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * T304: share links — management API, permissions (403/404), organization
 * public policy, the effective access of a link (creator ∩ target, P30),
 * `410` resolution, admin lists and bulk revoke, events + audit, tokens
 * never stored/logged/audited, `actor.name` of share link actors.
 */
describe('share links (T304)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let resolver: ShareLinkResolver;
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
  const f = {} as Record<'amount' | 'cost' | 'status' | 'owner', FieldDto>;
  let sales: RoleDto;
  let salesShare: RoleDto;
  let viewAll: ViewDto;
  let viewSales: ViewDto;
  let formView: ViewDto;
  const r = {} as Record<'r1' | 'r2' | 'r3', Id<'rec'>>;
  /** Every token handed out, to prove none is ever logged, audited or stored. */
  const tokens: string[] = [];
  const browsers = new Map<string, Browser>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    resolver = t.app.get(ShareLinkResolver);
    org = await seedOrg(db, 'Sharing');
    const otherOrg = await seedOrg(db, 'Elsewhere');
    const member = (role: 'owner' | 'member') => ({ memberships: [{ orgId: org, role }] });
    owner = await seedUser(db, member('owner'));
    editor = await seedUser(db, member('member'));
    reader = await seedUser(db, member('member'));
    sales1 = await seedUser(db, { ...member('member'), displayName: 'Sales One' });
    sales2 = await seedUser(db, member('member'));
    outsider = await seedUser(db, member('member'));
    stranger = await seedUser(db, { memberships: [{ orgId: otherOrg, role: 'owner' }] });

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
    primary = fieldListSchema
      .parse((await call(owner, 'GET', `/tables/${orders.id}/fields`)).json())
      .items.find((item) => item.is_primary) as FieldDto;

    const created = recordsResponseSchema.parse(
      (
        await call(owner, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
          records: [
            {
              fields: {
                [primary.id]: 'r1',
                [f.amount.id]: 10,
                [f.cost.id]: 1,
                [f.owner.id]: [{ id: sales1.id }],
              },
            },
            {
              fields: {
                [primary.id]: 'r2',
                [f.amount.id]: 20,
                [f.cost.id]: 2,
                [f.owner.id]: [{ id: sales2.id }],
              },
            },
            { fields: { [primary.id]: 'r3', [f.amount.id]: 0, [f.cost.id]: 3 } },
          ],
        })
      ).json(),
    ).records;
    [r.r1, r.r2, r.r3] = created.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    const roles = roleListSchema.parse((await call(owner, 'GET', `/bases/${baseId}/roles`)).json());
    const roleOf = (kind: string) => roles.items.find((item) => item.kind === kind) as RoleDto;
    await assign(editor, roleOf('system_editor').id);
    await assign(reader, roleOf('system_reader').id);

    viewAll = viewListSchema.parse((await call(owner, 'GET', `/tables/${orders.id}/views`)).json())
      .items[0] as ViewDto;
    viewSales = await createView(owner, {
      name: 'Sales',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: f.amount.id, operator: 'gt', value: 0 }] },
        hidden_fields: [f.status.id],
      },
    });
    formView = await createView(owner, { name: 'Order form', type: 'form' });
    sales = await createRole('Sales', false);
    salesShare = await createRole('Sales sharing', true);
    await assign(sales1, sales.id);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

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

  async function createView(user: SeededUser, body: Record<string, unknown>): Promise<ViewDto> {
    const response = await call(user, 'POST', `/tables/${orders.id}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  /** Sales of CONTRACTS §5; `shareLink` gives the S3 decision 1 variant. */
  async function createRole(name: string, shareLink: boolean): Promise<RoleDto> {
    const response = await call(owner, 'POST', `/bases/${baseId}/roles`, {
      name,
      config: {
        base_rule: { copy: false, download: false, share_link: shareLink },
        tables: {
          [orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: [viewSales.id] },
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
    body: object = {},
  ): Promise<CreatedShareLinkDto> {
    const response = await call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    const link = createdShareLinkSchema.parse(response.json());
    tokens.push(link.token);
    return link;
  }

  function expectProblem(
    response: LightMyRequestResponse,
    status: number,
    code: string,
    detail?: { path?: string; code: string },
  ): void {
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
  }

  async function goneReason(token: string): Promise<string> {
    const outcome = await resolver.inspect(token);
    if (outcome === 'not_found') return 'not_found';
    return 'gone' in outcome ? outcome.gone : 'active';
  }

  async function expectGone(token: string): Promise<void> {
    await expect(resolver.resolve(token)).rejects.toMatchObject({
      code: 'SHARE_LINK_GONE',
      status: 410,
    });
  }

  describe('who may create links', () => {
    it('refuses Sales (share_link = false) and readers with 403', async () => {
      expectProblem(
        await call(sales1, 'POST', `/views/${viewSales.id}/share-links`, {}),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(reader, 'POST', `/views/${viewAll.id}/share-links`, {}),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call(reader, 'GET', `/views/${viewAll.id}/share-links/preview`),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('answers 404 for a view the caller cannot see', async () => {
      // `viw_all` is outside Sales' visible_views.
      expectProblem(
        await call(sales1, 'POST', `/views/${viewAll.id}/share-links`, {}),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(outsider, 'POST', `/views/${viewAll.id}/share-links`, {}),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await call(stranger, 'GET', `/views/${viewAll.id}/share-links`),
        404,
        'NOT_FOUND',
      );
    });

    it('rejects personal views and embedding an org link (422)', async () => {
      const personal = await createView(owner, { name: 'Mine', type: 'grid', is_personal: true });
      expectProblem(
        await call(owner, 'POST', `/views/${personal.id}/share-links`, {}),
        422,
        'VALIDATION_FAILED',
        { code: 'PERSONAL_VIEW' },
      );
      expectProblem(
        await call(owner, 'POST', `/views/${viewAll.id}/share-links`, {
          settings: { embed: { enabled: true } },
        }),
        422,
        'VALIDATION_FAILED',
        // T809: only a public link without password can be embedded.
        { path: 'settings.embed.enabled', code: 'EMBED_NOT_SUPPORTED' },
      );
      expectProblem(
        await call(owner, 'POST', `/views/${viewAll.id}/share-links`, {
          expires_at: '2020-01-01T00:00:00.000Z',
        }),
        422,
        'VALIDATION_FAILED',
        { path: 'expires_at', code: 'OUT_OF_RANGE' },
      );
      expect(await sql`SELECT 1 FROM meta.share_links`.execute(db.kysely)).toMatchObject({
        rows: [],
      });
    });
  });

  describe('create, regenerate, revoke', () => {
    it('admin creates a link for viw_all; the token is returned once; regenerating makes the old link 410', async () => {
      const link = await createLink(owner, viewAll.id, { audience: 'public' });
      expect(link).toMatchObject({
        base_id: baseId,
        table_id: orders.id,
        target_type: 'view',
        target_id: viewAll.id,
        target_name: viewAll.name,
        audience: 'public',
        status: 'active',
        has_password: false,
        enabled: true,
        created_by: { id: owner.id },
        access_count: 0,
        settings: { allow_download: false, allow_search: true, embed: { enabled: false } },
      });
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(link.token_prefix).toBe(link.token.slice(0, 6));
      expect(link.url).toBe(`${TEST_PUBLIC_URL}/s/${link.token}`);

      const got = await call(owner, 'GET', `/share-links/${link.id}`);
      expect(got.statusCode).toBe(200);
      expect(got.body).not.toContain(link.token);
      expect(shareLinkSchema.parse(got.json())).not.toHaveProperty('token');
      const listed = await call(owner, 'GET', `/views/${viewAll.id}/share-links`);
      expect(shareLinkListSchema.parse(listed.json()).items.map((item) => item.id)).toEqual([
        link.id,
      ]);
      expect(listed.body).not.toContain(link.token);

      const resolved = await resolver.resolve(link.token);
      expect(resolved.link.id).toBe(link.id);
      expect(Object.keys(resolved.access.access.tables)).toEqual([orders.id]);

      const again = await call(owner, 'POST', `/share-links/${link.id}/regenerate`);
      expect(again.statusCode, again.body).toBe(201);
      const regenerated = createdShareLinkSchema.parse(again.json());
      tokens.push(regenerated.token);
      expect(regenerated.id).not.toBe(link.id);
      expect(regenerated.token).not.toBe(link.token);
      expect(regenerated).toMatchObject({ audience: 'public', target_id: viewAll.id });
      await expectGone(link.token);
      expect(await goneReason(link.token)).toBe('revoked');
      expect((await resolver.resolve(regenerated.token)).link.id).toBe(regenerated.id);
      expectProblem(await call(owner, 'GET', `/share-links/${link.id}`), 404, 'NOT_FOUND');

      // Creating a link again replaces the one of the target.
      const replacement = await createLink(owner, viewAll.id);
      expect(await goneReason(regenerated.token)).toBe('revoked');
      const events = await sql<{ type: string; entity_id: string; payload: { data?: object } }>`
        SELECT type, entity_id, payload FROM meta.events
         WHERE entity_type = 'share_link' ORDER BY created_at, id
      `.execute(db.kysely);
      // Events of one transaction share `created_at`: compare without order.
      expect(events.rows.map((row) => `${row.type} ${row.entity_id}`).sort()).toEqual(
        [
          `share_link.created ${link.id}`,
          `share_link.revoked ${link.id}`,
          `share_link.created ${regenerated.id}`,
          `share_link.revoked ${regenerated.id}`,
          `share_link.created ${replacement.id}`,
        ].sort(),
      );

      const deleted = await call(owner, 'DELETE', `/share-links/${replacement.id}`);
      expect(deleted.statusCode).toBe(204);
      await expectGone(replacement.token);
      expectProblem(
        await call(owner, 'DELETE', `/share-links/${replacement.id}`),
        404,
        'NOT_FOUND',
      );
      expect(await goneReason('x'.repeat(43))).toBe('not_found');
      await expect(resolver.resolve('not-a-token')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('changes settings, audience, password and expiry; turned off or expired links are 410', async () => {
      const link = await createLink(editor, viewAll.id);
      const patched = await call(editor, 'PATCH', `/share-links/${link.id}`, {
        audience: 'public',
        password: 'secret-123',
        settings: { allow_search: false, dashboard: { refresh_seconds: 120 } },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(shareLinkSchema.parse(patched.json())).toMatchObject({
        audience: 'public',
        has_password: true,
        settings: {
          allow_search: false,
          allow_copy: false,
          dashboard: { refresh_seconds: 120, tv_mode: false },
        },
      });
      const stored = await sql<{ password_hash: string }>`
        SELECT password_hash FROM meta.share_links WHERE id = ${link.id}
      `.execute(db.kysely);
      expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
      const audit = await sql<{ before: object; after: object }>`
        SELECT before, after FROM meta.audit_logs
         WHERE action = 'share_link.updated' AND entity_id = ${link.id}
      `.execute(db.kysely);
      expect(audit.rows[0]?.before).toMatchObject({ audience: 'org', has_password: false });
      expect(audit.rows[0]?.after).toMatchObject({ audience: 'public', has_password: true });
      expect(JSON.stringify(audit.rows)).not.toContain('secret-123');
      expect(JSON.stringify(audit.rows)).not.toContain('argon2');

      expect(
        (await call(editor, 'PATCH', `/share-links/${link.id}`, { enabled: false })).statusCode,
      ).toBe(200);
      expect(await goneReason(link.token)).toBe('disabled');
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const later = await call(editor, 'PATCH', `/share-links/${link.id}`, {
        enabled: true,
        expires_at: future,
      });
      expect(shareLinkSchema.parse(later.json())).toMatchObject({
        status: 'active',
        expires_at: future,
      });
      expect(await goneReason(link.token)).toBe('active');
      const outcome = await resolver.inspect(link.token, new Date(Date.now() + 7_200_000));
      expect(outcome).toEqual({ gone: 'expired' });
      expectProblem(
        await call(reader, 'PATCH', `/share-links/${link.id}`, { enabled: false }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await call(sales2, 'GET', `/share-links/${link.id}`), 404, 'NOT_FOUND');
      await call(editor, 'DELETE', `/share-links/${link.id}`);
    });
  });

  describe('deleted targets', () => {
    it('make the link 410; base admins can still read and revoke it', async () => {
      const temp = await createView(owner, { name: 'Temp', type: 'grid' });
      const link = await createLink(editor, temp.id);
      expect((await call(owner, 'DELETE', `/views/${temp.id}`)).statusCode).toBe(204);
      await expectGone(link.token);
      expect(await goneReason(link.token)).toBe('target_deleted');
      expectProblem(await call(editor, 'GET', `/share-links/${link.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await call(owner, 'PATCH', `/share-links/${link.id}`, { enabled: false }),
        404,
        'NOT_FOUND',
      );
      const got = shareLinkSchema.parse(
        (await call(owner, 'GET', `/share-links/${link.id}`)).json(),
      );
      expect(got.target_name).toBeNull();
      expect((await call(owner, 'DELETE', `/share-links/${link.id}`)).statusCode).toBe(204);
    });
  });

  describe('effective access (P30)', () => {
    it('a Sales link (share_link variant) shows only r1, without cost or fields hidden in the view', async () => {
      await assign(sales1, salesShare.id);
      const preview = await call(sales1, 'GET', `/views/${viewSales.id}/share-links/preview`);
      expect(preview.statusCode, preview.body).toBe(200);
      const scope = shareLinkPreviewSchema.parse(preview.json());
      expect(scope).toMatchObject({
        target_type: 'view',
        record_count: 1,
        record_count_estimated: false,
      });
      const previewFields = scope.fields.map((item) => item.id);
      expect(previewFields).toContain(f.amount.id);
      expect(previewFields).not.toContain(f.cost.id);
      expect(previewFields).not.toContain(f.status.id);
      expect(scope.fields.every((item) => item.access === 'read')).toBe(true);
      const ownerPreview = shareLinkPreviewSchema.parse(
        (await call(owner, 'GET', `/views/${viewSales.id}/share-links/preview`)).json(),
      );
      // The view filter (amount > 0) always applies: r3 is out.
      expect(ownerPreview.record_count).toBe(2);

      const link = await createLink(sales1, viewSales.id, { audience: 'public' });
      const resolved = await resolver.resolve(link.token);
      const page = await t.app
        .get(RecordQueryService)
        .query(resolved.scope, orders.id, resolved.recordAccess, { field_key_type: 'id' });
      expect(page.records.map((record) => record.id)).toEqual([r.r1]);
      const keys = Object.keys(page.records[0]?.fields ?? {});
      expect(keys).toContain(f.amount.id);
      expect(keys).not.toContain(f.cost.id);
      expect(keys).not.toContain(f.status.id);
      expect(resolved.access.access.tables[orders.id]?.perm).toBe('read_only');

      // The creator loses the role: every access through the link is 410.
      const removed = await call(owner, 'DELETE', `/bases/${baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: sales1.id,
      });
      expect(removed.statusCode).toBe(204);
      await expectGone(link.token);
      expect(await goneReason(link.token)).toBe('creator_lost_access');
      await assign(sales1, salesShare.id);
      expect(await goneReason(link.token)).toBe('active');
      // Losing the right to share also stops the link.
      await assign(sales1, sales.id);
      expect(await goneReason(link.token)).toBe('creator_lost_access');
      await call(owner, 'DELETE', `/share-links/${link.id}`);
    });

    it('a form link creates only, on the form fields; its records carry the link as actor', async () => {
      const link = await createLink(editor, formView.id, { audience: 'public' });
      expect(link.target_type).toBe('form');
      const preview = shareLinkPreviewSchema.parse(
        (await call(editor, 'GET', `/views/${formView.id}/share-links/preview`)).json(),
      );
      expect(preview.record_count).toBeNull();
      expect(preview.fields.every((item) => item.access === 'create')).toBe(true);
      expect(preview.fields.map((item) => item.id)).toContain(primary.id);

      const resolved = await resolver.resolve(link.token);
      const table = resolved.access.access.tables[orders.id];
      expect(table).toMatchObject({ perm: 'edit', operations: ['add'] });
      const created = await t.app.get(RecordMutationService).create(
        resolved.scope,
        orders.id,
        resolved.recordAccess,
        { field_key_type: 'id', records: [{ fields: { [primary.id]: 'From the form' } }] },
        {
          actor: { type: 'share_link', id: link.id },
          via: { share_link_id: link.id },
          batch_id: null,
          request_id: null,
          ip: null,
          user_agent: null,
        },
      );
      const recordId = (created as { records: { id: Id<'rec'> }[] }).records[0]?.id as Id<'rec'>;
      const history = recordHistoryResponseSchema.parse(
        (await call(owner, 'GET', `/tables/${orders.id}/records/${recordId}/history`)).json(),
      );
      expect(history.items[0]).toMatchObject({
        action: 'record.created',
        actor: { type: 'share_link', id: link.id, name: formView.name },
        via: { share_link_id: link.id },
      });
      // A reader who cannot see the form (visible_views) gets no name.
      const viewer = await call(owner, 'POST', `/bases/${baseId}/roles`, {
        name: 'Viewer',
        config: {
          tables: {
            [orders.id]: {
              perm: 'read_only',
              view_rule: { allow_edit: false, visible_views: [viewSales.id] },
            },
          },
        },
      });
      expect(viewer.statusCode, viewer.body).toBe(201);
      await assign(sales2, roleSchema.parse(viewer.json()).id);
      const hidden = recordHistoryResponseSchema.parse(
        (await call(sales2, 'GET', `/tables/${orders.id}/records/${recordId}/history`)).json(),
      );
      expect(hidden.items[0]?.actor).toEqual({ type: 'share_link', id: link.id, name: null });

      const auditPage = auditLogListSchema.parse(
        (await call(owner, 'GET', `/orgs/${org}/audit-logs?actor_id=${link.id}`)).json(),
      );
      expect(auditPage.items[0]?.actor).toEqual({
        type: 'share_link',
        id: link.id,
        name: formView.name,
      });
    });
  });

  describe('organization policy', () => {
    it('forbids public links when the organization disables them (403), and stops existing ones (410)', async () => {
      const publicLink = await createLink(owner, viewAll.id, { audience: 'public' });
      const patched = await call(owner, 'PATCH', `/orgs/${org}`, {
        settings: { public_sharing: 'disabled' },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({ settings: { public_sharing: 'disabled' } });

      expectProblem(
        await call(owner, 'POST', `/views/${viewSales.id}/share-links`, { audience: 'public' }),
        403,
        'PUBLIC_SHARING_DISABLED',
      );
      expect(await goneReason(publicLink.token)).toBe('public_sharing_disabled');
      const blocked = shareLinkSchema.parse(
        (await call(owner, 'GET', `/share-links/${publicLink.id}`)).json(),
      );
      expect(blocked.status).toBe('blocked');
      expectProblem(
        await call(owner, 'PATCH', `/share-links/${publicLink.id}`, { enabled: true }),
        403,
        'PUBLIC_SHARING_DISABLED',
      );
      // Turning it into an organization link works again.
      const toOrg = await call(owner, 'PATCH', `/share-links/${publicLink.id}`, {
        audience: 'org',
      });
      expect(shareLinkSchema.parse(toOrg.json()).status).toBe('active');
      expect(await goneReason(publicLink.token)).toBe('active');

      await call(owner, 'PATCH', `/orgs/${org}`, { settings: { public_sharing: 'forms_only' } });
      expectProblem(
        await call(owner, 'POST', `/views/${viewSales.id}/share-links`, { audience: 'public' }),
        403,
        'PUBLIC_SHARING_DISABLED',
      );
      const form = await createLink(owner, formView.id, { audience: 'public' });
      expect(form.status).toBe('active');
      await call(owner, 'PATCH', `/orgs/${org}`, { settings: { public_sharing: 'allowed' } });
    });
  });

  describe('administration', () => {
    it('lists the links of the organization for owners/admins only (members: 404)', async () => {
      expectProblem(await call(editor, 'GET', `/orgs/${org}/share-links`), 404, 'NOT_FOUND');
      expectProblem(await call(stranger, 'GET', `/orgs/${org}/share-links`), 404, 'NOT_FOUND');
      expectProblem(
        await call(editor, 'POST', `/orgs/${org}/share-links/revoke`, {
          ids: ['shl_0000000000000000'],
        }),
        404,
        'NOT_FOUND',
      );
      const response = await call(owner, 'GET', `/orgs/${org}/share-links?audience=public`);
      expect(response.statusCode, response.body).toBe(200);
      const list = shareLinkListSchema.parse(response.json());
      expect(list.total).toBeGreaterThan(0);
      for (const item of list.items) {
        expect(item.audience).toBe('public');
        expect(item).toHaveProperty('last_accessed_at');
        expect(item.created_by.name).not.toBeUndefined();
        expect(item.target_name).not.toBeNull();
      }
      for (const token of tokens) expect(response.body).not.toContain(token);
    });

    it('lists and revokes the links of a base for base admins (others: 403/404)', async () => {
      expectProblem(
        await call(editor, 'GET', `/bases/${baseId}/share-links`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await call(outsider, 'GET', `/bases/${baseId}/share-links`), 404, 'NOT_FOUND');
      const list = shareLinkListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/share-links`)).json(),
      );
      expect(list.total).toBeGreaterThan(0);
      const ids = list.items.map((item) => item.id);
      const liveTokens: string[] = [];
      for (const token of tokens) {
        if ((await goneReason(token)) === 'active') liveTokens.push(token);
      }
      expect(liveTokens.length).toBeGreaterThan(0);

      const revoked = await call(owner, 'POST', `/orgs/${org}/share-links/revoke`, {
        ids: [...ids, 'shl_0000000000000000'],
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revokeShareLinksResponseSchema.parse(revoked.json()).revoked.sort()).toEqual(
        [...ids].sort(),
      );
      for (const token of liveTokens) await expectGone(token);
      const after = shareLinkListSchema.parse(
        (await call(owner, 'GET', `/bases/${baseId}/share-links`)).json(),
      );
      expect(after.total).toBe(0);
      const audit = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.audit_logs
         WHERE action = 'share_link.revoked' AND after IS NULL AND entity_id = ANY(${ids}::text[])
      `.execute(db.kysely);
      expect(audit.rows[0]?.n).toBe(ids.length);
    });
  });

  describe('secrecy', () => {
    it('never stores, logs or audits a token', async () => {
      expect(tokens.length).toBeGreaterThan(3);
      const logs = t.logs.raw();
      const stored = await sql<{ doc: string }>`
        SELECT concat_ws(' ', (SELECT string_agg(to_jsonb(a)::text, ' ') FROM meta.audit_logs a),
                              (SELECT string_agg(to_jsonb(e)::text, ' ') FROM meta.events e),
                              (SELECT string_agg(to_jsonb(s)::text, ' ') FROM meta.share_links s)) AS doc
      `.execute(db.kysely);
      const doc = stored.rows[0]?.doc ?? '';
      for (const token of tokens) {
        expect(logs).not.toContain(token);
        expect(doc).not.toContain(token);
      }
      const hashes = await sql<{ token_hash: string; token_prefix: string }>`
        SELECT token_hash, token_prefix FROM meta.share_links
      `.execute(db.kysely);
      const audits = await sql<{ doc: string }>`
        SELECT string_agg(to_jsonb(a)::text, ' ') AS doc FROM meta.audit_logs a
         WHERE action LIKE 'share_link.%'
      `.execute(db.kysely);
      for (const row of hashes.rows) {
        expect(audits.rows[0]?.doc ?? '').not.toContain(row.token_hash);
        expect(logs).not.toContain(row.token_hash);
      }
    });
  });
});
