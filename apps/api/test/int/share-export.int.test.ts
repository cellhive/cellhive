import {
  createdShareLinkSchema,
  shareLinkSchema,
  shareMetaSchema,
  type CreatedShareLinkDto,
  type Id,
} from '@cellhive/contracts';
import { type Db, type JsonObject } from '@cellhive/server-core';
import { streamXlsxRows } from 'hucre/xlsx';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';
import { ExportLeases } from '../../src/modules/export/export-leases.js';

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

/** RFC 4180 parser for the tests (quoted cells, `""`, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) rows.push([...row, cell]);
  return rows;
}

function csvOf(response: LightMyRequestResponse): string[][] {
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  const text = response.rawPayload.toString('utf8');
  expect(text.startsWith('﻿')).toBe(true);
  return parseCsv(text.slice(1));
}

/**
 * T810 (P73): export of a shared view through `GET /shares/:token/export` —
 * `allow_export`, the creator's current `download`, the link's scope
 * (view filter, hidden fields, creator's read rule and field rule), the
 * share route checks (404/410/401/password/rate limit), one export per
 * link and per IP, CSV injection, the audit entry, form links and tenant
 * isolation.
 */
describe('export through a share link (T810)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let salesRole: { id: Id<'rol'>; config: JsonObject };
  let salesView: Id<'viw'>;
  let formView: Id<'viw'>;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    t.app.get(ShareRateLimits).read = { limit: 100_000, windowSeconds: 1 };
    fx = await buildRecordFixture(t, db);
    const create = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: '=HYPERLINK("http://evil")',
            amount: 25,
            cost: 10,
            status: 'Mới',
            owner: [{ id: fx.users.u_sales1.id }],
          },
        },
        { fields: { title: 'r2', amount: 20, cost: 20, owner: [{ id: fx.users.u_sales2.id }] } },
        { fields: { title: 'r3', amount: 5, cost: 30, owner: [{ id: fx.users.u_sales1.id }] } },
      ],
    });
    expect(create.statusCode, create.body).toBe(201);

    const viewOf = async (body: object) => {
      const response = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, body);
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ id: Id<'viw'> }>().id;
    };
    // viw_sales: amount >= 20, `cost` hidden.
    salesView = await viewOf({
      name: 'Sales view',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: fx.fld.amount?.id, operator: 'gte', value: 20 }] },
        hidden_fields: [fx.fld.cost?.id],
      },
    });
    formView = await viewOf({ name: 'Order form', type: 'form' });
    const roles = await fx.call('owner', 'GET', `/bases/${fx.baseId}/roles`);
    const sales = roles
      .json<{ items: { id: Id<'rol'>; name: string; config: JsonObject }[] }>()
      .items.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    salesRole = sales;
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function createLink(
    user: FixtureUser,
    viewId: Id<'viw'>,
    body: object = {},
    on: RecordFixture = fx,
  ): Promise<CreatedShareLinkDto> {
    const response = await on.call(user, 'POST', `/views/${viewId}/share-links`, {
      audience: 'public',
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return createdShareLinkSchema.parse(response.json());
  }

  const exportOf = (
    token: string,
    query = '',
    browser: Browser = new Browser(t.app),
    headers: Record<string, string> = {},
  ) => browser.request({ method: 'GET', url: `/api/v1/shares/${token}/export${query}`, headers });

  /** Sales with `share_link` (and `download` unless told otherwise). */
  async function setSales(baseRule: { download: boolean; share_link: boolean }): Promise<void> {
    const config = salesRole.config as { base_rule: JsonObject };
    const url = `/bases/${fx.baseId}/roles/${salesRole.id}`;
    const response = await fx.call('owner', 'PATCH', url, {
      config: { ...config, base_rule: { ...config.base_rule, ...baseRule } },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function resetSales(): Promise<void> {
    const url = `/bases/${fx.baseId}/roles/${salesRole.id}`;
    const response = await fx.call('owner', 'PATCH', url, { config: salesRole.config });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function exportAudits(linkId: Id<'shl'>) {
    const { rows } = await sql<{
      actor_type: string;
      actor_id: string;
      entity_type: string;
      entity_id: string;
      base_id: string;
      table_id: string;
      via: unknown;
      after: unknown;
    }>`
      SELECT actor_type, actor_id, entity_type, entity_id, base_id, table_id, via, after
        FROM meta.audit_logs
       WHERE action = 'export.created' AND after->>'share_link_id' = ${linkId}
    `.execute(db.kysely);
    return rows;
  }

  describe('settings', () => {
    it('allow_export defaults to false and is returned; a form link refuses it (422)', async () => {
      const link = await createLink('u_editor', salesView);
      expect(link.settings.allow_export).toBe(false);
      const patched = await fx.call('u_editor', 'PATCH', `/share-links/${link.id}`, {
        settings: { allow_export: true },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(shareLinkSchema.parse(patched.json()).settings.allow_export).toBe(true);

      const created = await fx.call('owner', 'POST', `/views/${formView}/share-links`, {
        audience: 'public',
        settings: { allow_export: true },
      });
      expectProblem(created, 422, 'VALIDATION_FAILED');
      expect(problemOf(created.body)['errors']).toEqual([
        expect.objectContaining({ path: 'settings.allow_export', code: 'NOT_ALLOWED' }),
      ]);
      const form = await createLink('owner', formView);
      const patchedForm = await fx.call('owner', 'PATCH', `/share-links/${form.id}`, {
        settings: { allow_export: true },
      });
      expectProblem(patchedForm, 422, 'VALIDATION_FAILED');
      // A form link has no records to export, whatever its settings.
      expectProblem(await exportOf(form.token), 404, 'NOT_FOUND');
    });

    it('allow_export = false → 403 PERMISSION_DENIED / NOT_ALLOWED; meta says so', async () => {
      const link = await createLink('u_editor', salesView);
      const response = await exportOf(link.token);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ code: 'NOT_ALLOWED' }),
      ]);
      const meta = await new Browser(t.app).request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/meta`,
      });
      expect(shareMetaSchema.parse(meta.json()).settings.allow_export).toBe(false);
      expect(await exportAudits(link.id)).toEqual([]);
    });
  });

  describe('scope of the link', () => {
    it('u_editor link of viw_sales: only rows of the view filter, never the hidden cost', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      const meta = await new Browser(t.app).request({
        method: 'GET',
        url: `/api/v1/shares/${link.token}/meta`,
      });
      expect(shareMetaSchema.parse(meta.json()).settings.allow_export).toBe(true);

      const response = await exportOf(link.token);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="Orders - Sales view.csv"; filename*=UTF-8''Orders%20-%20Sales%20view.csv`,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      const [header, ...rows] = csvOf(response);
      expect(header).toEqual(['title', 'amount', 'status', 'owner']);
      expect(header).not.toContain('cost');
      expect(rows.map((row) => row[0])).toEqual([`'=HYPERLINK("http://evil")`, 'r2']);
      // CSV injection guard on the formula-like title (C§18).
      expect(response.rawPayload.toString('utf8')).toContain(`"'=HYPERLINK(""http://evil"")"`);
      // No value of the hidden field anywhere (cost 10 and 20 are unique in the file).
      for (const row of rows) expect(row).not.toContain('10');

      // The viewer's filter, sort or search are not taken.
      const filtered = await exportOf(
        link.token,
        `?filter=${encodeURIComponent('{}')}&search=r2&view_id=${formView}`,
      );
      expect(csvOf(filtered)).toHaveLength(3);
    });

    it('XLSX has the same columns, the hidden field never in it', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      const response = await exportOf(link.token, '?format=xlsx');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const cells: unknown[][] = [];
      for await (const row of streamXlsxRows(new Uint8Array(response.rawPayload))) {
        cells.push(row.values);
      }
      expect(cells[0]).toEqual(['title', 'amount', 'status', 'owner']);
      expect(cells).toHaveLength(3);
      expect(cells[1]?.[0]).toBe('=HYPERLINK("http://evil")');
    });

    it("the creator's current rights: Sales reads r1 only, without cost; losing download → 403, sharing → 410", async () => {
      await setSales({ download: true, share_link: true });
      try {
        const link = await createLink('u_sales1', salesView, {
          settings: { allow_export: true },
        });
        const [header, ...rows] = csvOf(await exportOf(link.token));
        expect(header).not.toContain('cost');
        expect(rows.map((row) => row[0])).toEqual([`'=HYPERLINK("http://evil")`]);

        // P73: a creator without download → 403 even with allow_export.
        await setSales({ download: false, share_link: true });
        expectProblem(await exportOf(link.token), 403, 'PERMISSION_DENIED');
        const meta = await new Browser(t.app).request({
          method: 'GET',
          url: `/api/v1/shares/${link.token}/meta`,
        });
        expect(shareMetaSchema.parse(meta.json()).settings.allow_export).toBe(false);

        // Losing the right to share ends the link.
        await setSales({ download: true, share_link: false });
        expectProblem(await exportOf(link.token), 410, 'SHARE_LINK_GONE');
      } finally {
        await resetSales();
      }
    });
  });

  describe('share route checks', () => {
    it('404 for unknown tokens; 410 for revoked, disabled and expired links', async () => {
      for (const token of ['x'.repeat(43), 'short']) {
        expectProblem(await exportOf(token), 404, 'NOT_FOUND');
      }
      const settings = { allow_export: true };
      const revoked = await createLink('u_editor', salesView, { settings });
      expect((await fx.call('u_editor', 'DELETE', `/share-links/${revoked.id}`)).statusCode).toBe(
        204,
      );
      expectProblem(await exportOf(revoked.token), 410, 'SHARE_LINK_GONE');

      const disabled = await createLink('u_editor', salesView, { settings, enabled: false });
      expectProblem(await exportOf(disabled.token), 410, 'SHARE_LINK_GONE');

      const expired = await createLink('u_editor', salesView, { settings });
      await db.kysely
        .updateTable('meta.share_links')
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where('id', '=', expired.id)
        .execute();
      expectProblem(await exportOf(expired.token), 410, 'SHARE_LINK_GONE');
      expect(await exportAudits(expired.id)).toEqual([]);
    });

    it('a password link needs its unlock cookie first', async () => {
      const link = await createLink('u_editor', salesView, {
        password: 'open-sesame-42',
        settings: { allow_export: true },
      });
      const visitor = new Browser(t.app);
      expectProblem(await exportOf(link.token, '', visitor), 403, 'SHARE_PASSWORD_REQUIRED');
      const unlocked = await visitor.request({
        method: 'POST',
        url: `/api/v1/shares/${link.token}/unlock`,
        payload: { password: 'open-sesame-42' },
      });
      expect(unlocked.statusCode, unlocked.body).toBe(200);
      expect(csvOf(await exportOf(link.token, '', visitor))).toHaveLength(3);
    });

    it('audience org: sign-in required, members of the organization only (tenant isolation)', async () => {
      const link = await createLink('u_editor', salesView, {
        audience: 'org',
        settings: { allow_export: true },
      });
      expectProblem(await exportOf(link.token), 401, 'UNAUTHENTICATED');
      const stranger = await fx.call('stranger', 'GET', `/shares/${link.token}/export`);
      expectProblem(stranger, 404, 'NOT_FOUND');
      // A member without any role in the base gets the link's scope.
      expect(csvOf(await fx.call('u_out', 'GET', `/shares/${link.token}/export`))).toHaveLength(3);
    });

    it("a link of another organization only ever exports that organization's rows", async () => {
      const other = await buildRecordFixture(t, db);
      expect(
        (
          await other.call('owner', 'POST', `/tables/${other.orders.id}/records`, {
            records: [{ fields: { title: 'elsewhere', amount: 1 } }],
          })
        ).statusCode,
      ).toBe(201);
      const view = await other.call('owner', 'POST', `/tables/${other.orders.id}/views`, {
        name: 'All',
        type: 'grid',
      });
      const link = await createLink(
        'u_editor',
        view.json<{ id: Id<'viw'> }>().id,
        { settings: { allow_export: true } },
        other,
      );
      const rows = csvOf(await exportOf(link.token));
      expect(rows.slice(1).map((row) => row[0])).toEqual(['elsewhere']);
      const [audit] = await exportAudits(link.id);
      expect(audit?.base_id).toBe(other.baseId);
      // The token of this organization does not open the other one's view.
      const mine = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      expect(csvOf(await exportOf(mine.token)).flat()).not.toContain('elsewhere');
    });

    it('per-IP read rate limit applies', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      const limits = t.app.get(ShareRateLimits);
      const relaxed = limits.read;
      limits.read = { limit: 1, windowSeconds: 60 };
      try {
        const browser = new Browser(t.app);
        expect((await exportOf(link.token, '', browser)).statusCode).toBe(200);
        const limited = await exportOf(link.token, '', browser);
        expectProblem(limited, 429, 'RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        limits.read = relaxed;
      }
    });

    it('rejects a bad format or zone with 422', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      expectProblem(await exportOf(link.token, '?format=pdf'), 422, 'VALIDATION_FAILED');
      expectProblem(await exportOf(link.token, '?tz=Mars/Base'), 422, 'VALIDATION_FAILED');
      expect(csvOf(await exportOf(link.token, '?tz=Asia/Ho_Chi_Minh'))).toHaveLength(3);
      // The viewer's locale formats values; the rows stay the link's.
      const vi = csvOf(await exportOf(link.token, '', undefined, { 'accept-language': 'vi-VN' }));
      const en = csvOf(
        await exportOf(link.token, '', undefined, { 'accept-language': 'en-US,en;q=0.9' }),
      );
      expect(vi.map((row) => row[0])).toEqual(en.map((row) => row[0]));
    });
  });

  describe('slots and audit', () => {
    it('one running export per link and per IP: 429 with Retry-After', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      const leases = t.app.get(ExportLeases);
      const held = await leases.acquire(link.id);
      try {
        const busy = await exportOf(link.token);
        expectProblem(busy, 429, 'RATE_LIMITED');
        expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        await held.release();
      }
      const browser = new Browser(t.app);
      const ip = await leases.acquire(`ip:${browser.ip}`);
      try {
        expectProblem(await exportOf(link.token, '', browser), 429, 'RATE_LIMITED');
        // Another IP is not held up, and the link slot was freed after the refusal.
        expect((await exportOf(link.token)).statusCode).toBe(200);
      } finally {
        await ip.release();
      }
      // Slots are freed after each export.
      expect((await exportOf(link.token, '', browser)).statusCode).toBe(200);
      expect((await exportOf(link.token, '', browser)).statusCode).toBe(200);
    });

    it('audits export.created as the link, without token or values', async () => {
      const link = await createLink('u_editor', salesView, { settings: { allow_export: true } });
      expect((await exportOf(link.token, '?format=xlsx')).statusCode).toBe(200);
      const audits = await exportAudits(link.id);
      expect(audits).toEqual([
        {
          actor_type: 'share_link',
          actor_id: link.id,
          entity_type: 'table',
          entity_id: fx.orders.id,
          base_id: fx.baseId,
          table_id: fx.orders.id,
          via: { share_link_id: link.id },
          after: { view_id: salesView, format: 'xlsx', row_count: 2, share_link_id: link.id },
        },
      ]);
      const { rows } = await sql<{ row: unknown }>`
        SELECT to_jsonb(a) AS row FROM meta.audit_logs a
         WHERE action = 'export.created' AND after->>'share_link_id' = ${link.id}
      `.execute(db.kysely);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(link.token);
      expect(text).not.toContain('HYPERLINK');
    });
  });
});
