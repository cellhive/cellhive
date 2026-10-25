import {
  createdShareLinkSchema,
  fieldSchema,
  recordListResponseSchema,
  recordSchema,
  recordsResponseSchema,
  shareMetaSchema,
  viewSchema,
  type CreatedShareLinkDto,
  type FieldDto,
  type Id,
  type RecordDto,
  type ShareMeta,
  type ViewDto,
} from '@cellhive/contracts';
import {
  BaseRolesRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { FormSpamGuard } from '../../src/modules/form/form-spam-guard.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T462: formula/lookup fields through share links and forms (CONTRACTS
 * §16A, §17) — `meta` gives only `{ style }`, `result_type`, `locked` and
 * the error code (never an expression, a source table/field id or the
 * `refs` of an error); values follow the **link creator's current**
 * access ∩ the link (`locked` → `null`, record results locked like link
 * cells, users without email, attachments never); viewer filters/sorts
 * only on computed fields of the link that are not locked; the P30 sweep
 * extended to formula/lookup fields; forms never ask computed fields and
 * their answers never carry computed values.
 */
describe('share links and forms with computed fields (T462)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let anonymous: Browser;
  let customer: FieldDto;
  let phone: FieldDto;
  let customerPhone: FieldDto;
  let customerRef: FieldDto;
  let amountVnd: FieldDto;
  let margin: FieldDto;
  let ownerOf: FieldDto;
  let broken: FieldDto;
  let scratch: FieldDto;
  let ordersTotal: FieldDto;
  let viewSales: ViewDto;
  let viewAdmin: ViewDto;
  let sales: CreatedShareLinkDto;
  let admin: CreatedShareLinkDto;
  const r = {} as Record<'r1' | 'r2' | 'r3', Id<'rec'>>;
  const c = {} as Record<'c1' | 'c2', Id<'rec'>>;
  const PHONES = { c1: '0901-111-222', c2: '0907-333-444' };

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function field(body: object, table = fx.orders.id): Promise<FieldDto> {
    const response = await fx.call('u_admin', 'POST', `/tables/${table}/fields`, body);
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  /** What the `computed.backfill` job does for one stored field. */
  async function backfill(fieldId: Id<'fld'>): Promise<void> {
    const scope = orgScope(fx.orgId);
    let cursor = 0n;
    for (;;) {
      const result = await t.app.get(RecordMutationService).backfillComputedBatch(scope, {
        fieldId,
        afterAuto: cursor,
        limit: 1000,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more') break;
      cursor = result.cursor;
    }
    await t.app.get(SchemaService).finishComputedBackfill(scope, fieldId, { status: 'ready' });
  }

  async function createView(body: object): Promise<ViewDto> {
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, body);
    expect(response.statusCode, response.body).toBe(201);
    return viewSchema.parse(response.json());
  }

  async function createLink(
    user: FixtureUser,
    viewId: Id<'viw'>,
    body: object = { audience: 'public' },
  ): Promise<CreatedShareLinkDto> {
    const response = await fx.call(user, 'POST', `/views/${viewId}/share-links`, body);
    expect(response.statusCode, response.body).toBe(201);
    return createdShareLinkSchema.parse(response.json());
  }

  function share(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return anonymous.request({
      method,
      url: `/api/v1/shares/${token}${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  const query = (token: string, body: object = {}, params = '?field_key_type=id') =>
    share(token, 'POST', `/records/query${params}`, body);

  function page(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records;
  }

  async function meta(token: string): Promise<{ meta: ShareMeta; body: string }> {
    const response = await share(token, 'GET', '/meta');
    expect(response.statusCode, response.body).toBe(200);
    return { meta: shareMetaSchema.parse(response.json()), body: response.body };
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    const limits = t.app.get(ShareRateLimits);
    limits.read = { limit: 100_000, windowSeconds: 1 };
    const guard = t.app.get(FormSpamGuard);
    guard.minFillMs = 0;
    guard.perMinute = { limit: 100_000, windowSeconds: 60 };
    fx = await buildRecordFixture(t, db);
    anonymous = new Browser(t.app);

    // Sales of C§5 may share (S3 decision 1; the P30 variant).
    const scope = orgScope(fx.orgId);
    const roles = new BaseRolesRepository(db);
    const salesRole = (await roles.listByBase(scope, fx.baseId)).find(
      (role) => role.name === 'Sales',
    );
    const config = structuredClone(salesRole?.config) as { base_rule: Record<string, boolean> };
    config.base_rule['share_link'] = true;
    config.base_rule['download'] = true;
    await roles.update(scope, fx.baseId, salesRole?.id ?? 'rol_missing', { config });

    phone = await field({ name: 'phone', type: 'text' }, fx.customers.id);
    customer = await field({
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    [c.c1, c.c2] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [
          { fields: { [fx.fld.customerName?.id ?? '']: 'An Phát', [phone.id]: PHONES.c1 } },
          { fields: { [fx.fld.customerName?.id ?? '']: 'Bình Minh', [phone.id]: PHONES.c2 } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    const order = (
      title: string,
      amount: number,
      cost: number,
      owner: Id<'usr'>,
      to: Id<'rec'>,
    ) => ({
      fields: {
        [fx.fld.title?.id ?? '']: title,
        [fx.fld.amount?.id ?? '']: amount,
        [fx.fld.cost?.id ?? '']: cost,
        [fx.fld.owner?.id ?? '']: [{ id: owner }],
        [customer.id]: [to],
      },
    });
    [r.r1, r.r2, r.r3] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [
          order('r1', 10, 1, fx.users.u_sales1.id, c.c1),
          order('r2', 20, 2, fx.users.u_sales2.id, c.c2),
          order('r3', 30, 3, fx.users.u_sales1.id, c.c2),
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    customerPhone = await field({
      name: 'customer_phone',
      type: 'lookup',
      options: {
        from: fx.customers.id,
        select: phone.id,
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: customer.id } },
      },
    });
    customerRef = await field({
      name: 'customer_ref',
      type: 'formula',
      options: { expression: '[customer]' },
    });
    amountVnd = await field({
      name: 'amount_vnd',
      type: 'formula',
      options: {
        expression: '[amount] * 1000',
        style: { type: 'currency', currency_code: 'VND', precision: 0 },
      },
    });
    margin = await field({
      name: 'margin',
      type: 'formula',
      options: { expression: '[amount] - [cost]' },
    });
    ownerOf = await field({
      name: 'owner_of',
      type: 'formula',
      options: { expression: '[owner]' },
    });
    scratch = await field({ name: 'scratch', type: 'number' });
    broken = await field({
      name: 'broken',
      type: 'formula',
      options: { expression: '[scratch] * 2' },
    });
    ordersTotal = await field(
      {
        name: 'orders_total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: fx.fld.amount?.id,
          where: { field: customer.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      },
      fx.customers.id,
    );
    for (const item of [
      customerPhone,
      customerRef,
      amountVnd,
      margin,
      ownerOf,
      broken,
      ordersTotal,
    ]) {
      await backfill(item.id);
    }
    // `scratch` goes to the trash: `broken` is in error (`REF`, T460).
    const deleted = await fx.call('u_admin', 'DELETE', `/fields/${scratch.id}`);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);

    const viewConfig = {
      filter: { op: 'and', items: [{ field: fx.fld.amount?.id, operator: 'gt', value: 0 }] },
      sort: [{ field: fx.fld.amount?.id, direction: 'asc' }],
      hidden_fields: [fx.fld.status?.id],
    };
    viewSales = await createView({ name: 'Sales', type: 'grid', config: viewConfig });
    viewAdmin = await createView({ name: 'Sales (admin)', type: 'grid', config: viewConfig });
    sales = await createLink('u_sales1', viewSales.id);
    admin = await createLink('u_admin', viewAdmin.id);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('meta', () => {
    it('gives style, result type, locked and the error code — never the definition', async () => {
      for (const [token, lockedPhone] of [
        [sales.token, true],
        [admin.token, false],
      ] as const) {
        const { meta: shared, body } = await meta(token);
        const byId = new Map(shared.fields.map((item) => [item.id, item]));
        expect(byId.get(customerPhone.id)).toMatchObject({
          type: 'lookup',
          options: {},
          result_type: { kind: 'text', list: true },
          compute_error: null,
          locked: lockedPhone,
        });
        expect(byId.get(amountVnd.id)).toMatchObject({
          options: { style: { type: 'currency', currency_code: 'VND' } },
          result_type: { kind: 'number', list: false },
          locked: false,
        });
        // Same record, `cost` no_perm for u_sales1: shown like Lark (not strict).
        expect(byId.get(margin.id)).toMatchObject({ locked: false });
        expect(byId.get(broken.id)).toMatchObject({ compute_error: { code: 'REF' } });
        expect(Object.keys(byId.get(broken.id)?.compute_error ?? {})).toEqual(['code']);
        // Plain fields carry none of the computed keys.
        expect(byId.get(fx.fld.amount?.id as Id<'fld'>)).not.toHaveProperty('result_type');
        for (const leak of [
          'expression',
          '"from"',
          '"select"',
          '"where"',
          'field_ref',
          'refs',
          '[amount]',
          fx.customers.id,
          phone.id,
          scratch.id,
          'scratch',
        ]) {
          expect(body, `meta leaks ${leak}`).not.toContain(leak);
        }
      }
    });
  });

  describe('values', () => {
    it("follow the link creator's current access: locked → null", async () => {
      const bySales = page(await query(sales.token));
      // u_sales1's record rule: r1 and r3 only.
      expect(bySales.map((record) => record.id)).toEqual([r.r1, r.r3]);
      const r1 = bySales[0];
      expect(r1?.fields[customerPhone.id]).toBeNull();
      // `[customer]` gives records of Customers, which u_sales1 cannot read: locked too.
      expect(r1?.fields[customerRef.id]).toBeNull();
      expect(r1?.fields[amountVnd.id]).toBe(10_000);
      expect(r1?.fields[margin.id]).toBe(9);
      // A user result: `{ id, name }`, never an email (C§16A).
      expect(r1?.fields[ownerOf.id]).toEqual([
        { id: fx.users.u_sales1.id, name: expect.any(String) as string },
      ]);
      expect(r1?.fields[broken.id]).toBeNull();

      const byAdmin = page(await query(admin.token));
      expect(byAdmin.map((record) => record.id)).toEqual([r.r1, r.r2, r.r3]);
      expect(byAdmin[0]?.fields[customerPhone.id]).toEqual([PHONES.c1]);
      expect(byAdmin[0]?.fields[customerRef.id]).toEqual([{ id: c.c1, title: 'An Phát' }]);

      // As text: the style of the field; locked → empty.
      const text = page(await query(sales.token, {}, '?field_key_type=id&cell_format=text'));
      expect(text[0]?.fields[amountVnd.id]).toMatch(/10[.,\s]?000/);
      expect(text[0]?.fields[customerPhone.id]).toBe('');
      const detail = await share(sales.token, 'GET', `/records/${r.r1}?field_key_type=id`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(recordSchema.parse(detail.json()).fields[customerPhone.id]).toBeNull();
    });

    it("follow the creator's access of now: granting and revoking Customers", async () => {
      const scope = orgScope(fx.orgId);
      const roles = new BaseRolesRepository(db);
      const role = (await roles.listByBase(scope, fx.baseId)).find((item) => item.name === 'Sales');
      const original = structuredClone(role?.config) as { tables: Record<string, unknown> };
      const granted = structuredClone(original);
      granted.tables[fx.customers.id] = {
        perm: 'read_only',
        view_rule: { allow_edit: false, visible_views: null },
        record_rule: { operations: [], edit_filter: null, read_scope: 'all', read_filter: null },
        field_rule: {
          mode: 'all_read',
          fields: {},
          option_edit_fields: [],
          file_download_fields: [],
        },
      };
      await roles.update(scope, fx.baseId, role?.id ?? 'rol_missing', {
        config: granted as unknown as JsonObject,
      });
      try {
        const [r1] = page(await query(sales.token));
        expect(r1?.fields[customerPhone.id]).toEqual([PHONES.c1]);
        expect(r1?.fields[customerRef.id]).toEqual([{ id: c.c1, title: 'An Phát' }]);
        const { meta: shared } = await meta(sales.token);
        expect(shared.fields.find((item) => item.id === customerPhone.id)?.locked).toBe(false);
      } finally {
        await roles.update(scope, fx.baseId, role?.id ?? 'rol_missing', {
          config: original as unknown as JsonObject,
        });
      }
      const [again] = page(await query(sales.token));
      expect(again?.fields[customerPhone.id]).toBeNull();
    });
  });

  describe('viewer filters and sorts', () => {
    it('work on computed fields of the link, answer like unknown fields when locked', async () => {
      const filtered = page(
        await query(sales.token, {
          filter: { op: 'and', items: [{ field: amountVnd.id, operator: 'gt', value: 15_000 }] },
          sort: [{ field: amountVnd.id, direction: 'desc' }],
        }),
      );
      expect(filtered.map((record) => record.id)).toEqual([r.r3]);
      expectProblem(
        await query(sales.token, {
          filter: { op: 'and', items: [{ field: customerPhone.id, operator: 'is_not_empty' }] },
        }),
        422,
        'INVALID_FILTER',
      );
      expectProblem(
        await query(sales.token, { sort: [{ field: customerPhone.id, direction: 'asc' }] }),
        422,
        'INVALID_SORT',
      );
      // A computed field hidden in the view is outside the link.
      const hiding = await fx.call('u_admin', 'PATCH', `/views/${viewAdmin.id}`, {
        config: { hidden_fields: [fx.fld.status?.id, amountVnd.id] },
      });
      expect(hiding.statusCode, hiding.body).toBe(200);
      expectProblem(
        await query(admin.token, {
          filter: { op: 'and', items: [{ field: amountVnd.id, operator: 'gt', value: 0 }] },
        }),
        422,
        'INVALID_FILTER',
      );
      const { meta: shared } = await meta(admin.token);
      expect(shared.fields.map((item) => item.id)).not.toContain(amountVnd.id);
      expect(page(await query(admin.token))[0]?.fields).not.toHaveProperty(amountVnd.id);
      await fx.call('u_admin', 'PATCH', `/views/${viewAdmin.id}`, {
        config: { hidden_fields: [fx.fld.status?.id] },
      });
    });

    it('summaries on a locked field: 422 UNKNOWN_FIELD in the request, skipped when saved', async () => {
      const path = '/records/summaries?field_key_type=id';
      for (const id of [customerPhone.id, customerRef.id]) {
        const response = await share(sales.token, 'POST', path, {
          summaries: { [amountVnd.id]: 'sum', [id]: 'filled' },
        });
        expectProblem(response, 422, 'VALIDATION_FAILED');
        expect(problemOf(response.body).errors).toEqual([
          expect.objectContaining({ path: `summaries.${id}`, code: 'UNKNOWN_FIELD' }),
        ]);
        expect(response.body).not.toContain(PHONES.c1);
      }
      // Not locked through the admin's link: summarised.
      const byAdmin = await share(admin.token, 'POST', path, {
        summaries: { [customerPhone.id]: 'filled' },
      });
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);

      // The view's saved entries on a field locked for the link are skipped.
      const saving = await fx.call('u_admin', 'PATCH', `/views/${viewSales.id}`, {
        config: { summaries: { [customerPhone.id]: 'filled', [amountVnd.id]: 'sum' } },
      });
      expect(saving.statusCode, saving.body).toBe(200);
      try {
        const saved = await share(sales.token, 'POST', path, {});
        expect(saved.statusCode, saved.body).toBe(200);
        const body = saved.json<{ summaries: Record<string, unknown> }>();
        expect(Object.keys(body.summaries)).toEqual([amountVnd.id]);
      } finally {
        await fx.call('u_admin', 'PATCH', `/views/${viewSales.id}`, {
          config: { summaries: {} },
        });
      }
    });
  });

  /**
   * The P30 sweep (T319, T409) with formula/lookup fields: through the link
   * of u_sales1 no answer carries `cost`, a record outside the link, a
   * Customers record, table or field (id, title, phone), the definition of
   * a computed field, an email or the organization. The same sweep through
   * the admin's link must find Customers values — the sweep can fail.
   */
  describe('P30 sweep with formula and lookup fields (T462)', () => {
    const requests = (): [string, 'GET' | 'POST', string, object?][] => [
      ['meta', 'GET', '/meta'],
      ['query', 'POST', '/records/query', {}],
      ['query by id', 'POST', '/records/query?field_key_type=id', {}],
      ['query as text', 'POST', '/records/query?cell_format=text', {}],
      ['query ids', 'POST', '/records/query', { ids: [r.r1, r.r2, r.r3] }],
      [
        'query computed fields',
        'POST',
        '/records/query?field_key_type=id',
        { fields: [customerPhone.id, customerRef.id, amountVnd.id, margin.id, ownerOf.id] },
      ],
      [
        'query computed filter',
        'POST',
        '/records/query?field_key_type=id',
        {
          filter: { op: 'and', items: [{ field: margin.id, operator: 'gte', value: 0 }] },
          sort: [{ field: margin.id, direction: 'desc' }],
        },
      ],
      ['query search', 'POST', '/records/query', { search: '0901' }],
      ['counts', 'POST', '/records/group-counts', { group: [{ field: 'amount_vnd' }] }],
      // T471: the summary bar through a link (T472, T470 H5) is a read route too.
      // Fields locked for the link are `422 UNKNOWN_FIELD` there (T501, tested
      // in "viewer filters and sorts"); the saved entries on them are skipped.
      [
        'summaries',
        'POST',
        '/records/summaries?field_key_type=id',
        { summaries: { [amountVnd.id]: 'sum', [margin.id]: 'sum', [ownerOf.id]: 'filled' } },
      ],
      ['saved summaries', 'POST', '/records/summaries?field_key_type=id', {}],
      ['detail', 'GET', `/records/${r.r1}`],
      ['detail by id', 'GET', `/records/${r.r1}?field_key_type=id`],
      ['detail as text', 'GET', `/records/${r.r1}?cell_format=text`],
    ];
    const outside = () => [
      fx.fld.cost?.id ?? '',
      '"cost"',
      r.r2,
      c.c1,
      c.c2,
      'An Phát',
      'Bình Minh',
      PHONES.c1,
      PHONES.c2,
      fx.customers.id,
      fx.fld.customerName?.id ?? '',
      phone.id,
      ordersTotal.id,
      'orders_total',
      'expression',
      'field_ref',
      '[amount]',
      '"refs"',
      fx.users.u_sales1.email,
      fx.users.u_sales2.email,
      fx.orgId,
      fx.baseId,
    ];

    it('keeps every read route inside the link', async () => {
      for (const [label, method, path, payload] of requests()) {
        const response = await share(sales.token, method, path, payload);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
        for (const leak of outside()) {
          expect(response.body, `${label} leaks ${leak}`).not.toContain(leak);
        }
      }
    });

    it('would catch a leak: the admin link reads Customers values', async () => {
      const found = new Set<string>();
      for (const [, method, path, payload] of requests()) {
        const response = await share(admin.token, method, path, payload);
        expect(response.statusCode, response.body).toBe(200);
        for (const leak of outside()) if (response.body.includes(leak)) found.add(leak);
      }
      expect([...found]).toEqual(expect.arrayContaining([PHONES.c1, 'An Phát', c.c1, r.r2]));
    });
  });

  describe('forms', () => {
    it('never ask a computed field; answers carry no computed value', async () => {
      // The default form lists writable fields only.
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'Order form',
        type: 'form',
      });
      expect(created.statusCode, created.body).toBe(201);
      const form = viewSchema.parse(created.json());
      const asked = (form.config.form?.fields ?? []).map((item) => item.field);
      for (const computed of [customerPhone, amountVnd, margin, ownerOf, broken]) {
        expect(asked).not.toContain(computed.id);
      }
      expectProblem(
        await fx.call('u_admin', 'PATCH', `/views/${form.id}`, {
          config: {
            form: { fields: [{ field: fx.fld.title?.id }, { field: amountVnd.id }] },
          },
        }),
        422,
        'VALIDATION_FAILED',
      );
      const saved = await fx.call('u_admin', 'PATCH', `/views/${form.id}`, {
        config: {
          form: {
            fields: [{ field: fx.fld.title?.id }, { field: fx.fld.amount?.id }],
            success_message: 'Cảm ơn!',
          },
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);

      // Through a link: meta lists no computed field.
      const link = await createLink('u_admin', form.id);
      const { meta: shared } = await meta(link.token);
      expect(shared.fields.map((item) => item.type)).not.toContain('formula');
      expect(shared.fields.map((item) => item.type)).not.toContain('lookup');

      const token = await anonymous.request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/submit-token`,
      });
      expect(token.statusCode, token.body).toBe(200);
      const submitToken = token.json<{ submit_token: string }>().submit_token;
      // A computed answer is refused like a field outside the form.
      const refused = await anonymous.request({
        method: 'POST',
        url: `/api/v1/shares/${link.token}/submit`,
        payload: {
          fields: { [fx.fld.title?.id ?? '']: 'form order', [amountVnd.id]: 5 },
          submit_token: submitToken,
        },
      });
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(refused.body).toContain('UNKNOWN_FIELD');
      const accepted = await anonymous.request({
        method: 'POST',
        url: `/api/v1/shares/${link.token}/submit`,
        payload: {
          fields: { [fx.fld.title?.id ?? '']: 'form order', [fx.fld.amount?.id ?? '']: 7 },
          submit_token: submitToken,
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toEqual({ success_message: 'Cảm ơn!', redirect_url: null });

      // Members: the same answer shape, no computed value.
      const member = await fx.call('u_admin', 'POST', `/views/${form.id}/submit`, {
        fields: { [fx.fld.title?.id ?? '']: 'member order', [fx.fld.amount?.id ?? '']: 8 },
      });
      expect(member.statusCode, member.body).toBe(200);
      expect(member.json()).toEqual({ success_message: 'Cảm ơn!', redirect_url: null });
      expectProblem(
        await fx.call('u_admin', 'POST', `/views/${form.id}/submit`, {
          fields: { [fx.fld.title?.id ?? '']: 'x', [margin.id]: 1 },
        }),
        422,
        'VALIDATION_FAILED',
      );

      // The computed values of the new record are there for readers (recomputed on write).
      const listed = await fx.call(
        'u_admin',
        'POST',
        `/tables/${fx.orders.id}/records/query?field_key_type=id`,
        {
          filter: {
            op: 'and',
            items: [{ field: fx.fld.title?.id, operator: 'contains', value: 'form order' }],
          },
        },
      );
      expect(listed.statusCode, listed.body).toBe(200);
      expect(recordListResponseSchema.parse(listed.json()).records[0]?.fields[amountVnd.id]).toBe(
        7000,
      );
    });
  });
});
