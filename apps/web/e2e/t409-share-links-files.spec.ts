import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { pdfBytes, pngBytes, uploadFile } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T409 — link and attachment fields on the public share page `/s/:token`:
 * a link made by a member who cannot read the linked table shows locked
 * chips (no title, no id), a link made by the administrator shows the
 * titles; files show as thumbnails / badges, open in the viewer, and are
 * downloadable only when the link allows it (`allow_download`, the
 * creator's `file_download_fields`). Nothing reaches `/api/v1/files/*`.
 * Self-contained: the first administrator, a base of its own, a member
 * invited here.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const SALES = {
  name: 'Đỗ Thị Chia',
  email: `sales-t409-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const CUSTOMER = 'Công ty An Phát';
const ORDER = 'Đơn có hồ sơ';
const PDF_NAME = 'Hợp đồng T409.pdf';
const PNG_NAME = 'Ảnh T409.png';

interface CreatedLink {
  id: string;
  token: string;
}

async function english(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
}

/** Someone the link was sent to: no session. */
async function anonymous(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  await english(context);
  return context.newPage();
}

async function invite(page: Page, orgId: string, person: typeof SALES): Promise<string> {
  const invitation = await ok<{ invite_url: string }>(page, 'POST', `/orgs/${orgId}/invitations`, {
    email: person.email,
    role: 'member',
  });
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  const guest = await page.context().browser()?.newContext();
  if (guest === undefined) throw new Error('No browser');
  const guestPage = await guest.newPage();
  await guestPage.goto('/login');
  const accepted = await ok<{ user: { id: string } }>(
    guestPage,
    'POST',
    `/invitations/${token}/accept`,
    { display_name: person.name, password: person.password },
  );
  await guest.close();
  return accepted.user.id;
}

/** Every request the page sends to the API, by path. */
function apiPaths(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) paths.push(url.pathname);
  });
  return paths;
}

test.describe('T409 share links: links and attachments', () => {
  test.describe.configure({ mode: 'serial' });

  const ids = { orgId: '', customersId: '', salesToken: '', adminToken: '' };

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    await ok(page, 'PATCH', `/orgs/${ids.orgId}`, { settings: { public_sharing: 'allowed' } });
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `Share files ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hồ sơ bán hàng',
    });
    const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng T409',
    });
    const customers = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Khách hàng T409',
    });
    ids.customersId = customers.id;
    const field = (body: object) =>
      ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, body);
    const customer = await field({
      name: 'Khách hàng',
      type: 'link',
      options: { link_table: customers.id },
    });
    const docs = await field({ name: 'Hồ sơ', type: 'attachment' });
    const images = await field({ name: 'Ảnh', type: 'attachment' });
    const [linked] = (
      await ok<{ records: { id: string }[] }>(
        page,
        'POST',
        `/tables/${customers.id}/records?field_key_type=name`,
        { records: [{ fields: { Name: CUSTOMER } }] },
      )
    ).records;
    const pdf = await uploadFile(
      page,
      { tableId: orders.id, fieldId: docs.id },
      { name: PDF_NAME, mime: 'application/pdf', bytes: pdfBytes('T409') },
    );
    const png = await uploadFile(
      page,
      { tableId: orders.id, fieldId: images.id },
      { name: PNG_NAME, mime: 'image/png', bytes: pngBytes([20, 120, 200], 320, 200) },
    );
    await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
      records: [
        {
          fields: {
            [customer.id]: [linked?.id],
            [docs.id]: [{ id: pdf.id }],
            [images.id]: [{ id: png.id }],
          },
        },
      ],
    });
    const primary = (
      await ok<{ items: { id: string; is_primary: boolean }[] }>(
        page,
        'GET',
        `/tables/${orders.id}/fields`,
      )
    ).items.find((item) => item.is_primary);
    const [record] = (
      await ok<{ records: { id: string }[] }>(page, 'POST', `/tables/${orders.id}/records/query`, {
        limit: 1,
      })
    ).records;
    await ok(page, 'PATCH', `/tables/${orders.id}/records?field_key_type=id`, {
      records: [{ id: record?.id, fields: { [primary?.id ?? '']: ORDER } }],
    });

    const view = (name: string) =>
      ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, { name, type: 'grid' });
    const salesView = await view('Sales T409');
    const adminView = await view('Nội bộ T409');

    // A member who reads the orders (not the customers), may share and download `Hồ sơ`.
    const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Share files ${RUN}`,
      config: {
        base_rule: { copy: false, download: false, share_link: true },
        tables: {
          [orders.id]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: [salesView.id] },
            field_rule: {
              mode: 'specify',
              fields: {
                [primary?.id ?? '']: 'read',
                [customer.id]: 'read',
                [docs.id]: 'read',
                [images.id]: 'read',
              },
              file_download_fields: [docs.id],
            },
          },
        },
      },
    });
    const salesId = await invite(page, ids.orgId, SALES);
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: salesId,
      role_id: role.id,
    });
    const salesContext = await browser.newContext();
    const salesPage = await salesContext.newPage();
    await salesPage.goto('/login');
    await apiSignIn(salesPage, SALES.email, SALES.password);
    ids.salesToken = (
      await ok<CreatedLink>(salesPage, 'POST', `/views/${salesView.id}/share-links`, {
        audience: 'public',
        settings: { allow_download: true },
      })
    ).token;
    await salesContext.close();
    ids.adminToken = (
      await ok<CreatedLink>(page, 'POST', `/views/${adminView.id}/share-links`, {
        audience: 'public',
      })
    ).token;
    await page.close();
  });

  test("a member's link: locked customer, files viewable and downloadable", async ({ browser }) => {
    const visitor = await anonymous(browser, { width: 375, height: 800 });
    const csp = collectCspViolations(visitor);
    const paths = apiPaths(visitor);
    const meta = visitor.waitForResponse((response) => response.url().endsWith('/meta'));
    await visitor.goto(`/s/${ids.salesToken}`);
    expect(await (await meta).text()).not.toContain(ids.customersId);

    const card = visitor.getByRole('button', { name: new RegExp(ORDER, 'u') }).first();
    await expect(card).toBeVisible();
    // The member cannot read the customers: a locked chip, never the title.
    await expect(card).toContainText('No access');
    await expect(visitor.getByText(CUSTOMER)).toHaveCount(0);
    await card.click();

    const dialog = visitor.getByRole('dialog');
    const files = dialog.getByRole('list', { name: 'Files of Hồ sơ' });
    await expect(files).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Files of Ảnh' })).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'shared record with files');

    await files.getByRole('button', { name: `View ${PDF_NAME}` }).click();
    const viewer = visitor.getByTestId('attachment-lightbox');
    await expect(viewer).toBeVisible();
    const download = visitor.getByTestId('attachment-lightbox-download');
    const href = (await download.getAttribute('href')) ?? '';
    expect(href.startsWith(`/api/v1/shares/${ids.salesToken}/files/att_`)).toBe(true);
    // The route answers with a redirect to storage (the browser follows it).
    const fetched = await visitor.request.get(href, { maxRedirects: 0 });
    expect(fetched.status()).toBe(302);
    expect(fetched.headers()['referrer-policy']).toBe('no-referrer');
    expect(fetched.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await visitor.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);

    // `Ảnh` is not among the member's file_download_fields: viewing only.
    await dialog
      .getByRole('list', { name: 'Files of Ảnh' })
      .getByRole('button', { name: `View ${PNG_NAME}` })
      .click();
    await expect(visitor.getByTestId('attachment-lightbox')).toBeVisible();
    await expect(visitor.getByTestId('attachment-lightbox-download')).toHaveCount(0);
    await visitor.keyboard.press('Escape');

    expect(paths.filter((path) => path.startsWith('/api/v1/files/'))).toEqual([]);
    expect(csp).toEqual([]);
    await visitor.context().close();
  });

  test("the administrator's link: customer titles, no download without allow_download", async ({
    browser,
  }) => {
    const visitor = await anonymous(browser, { width: 1400, height: 900 });
    await visitor.goto(`/s/${ids.adminToken}`);
    await expect(
      visitor.locator('table[role="grid"] td[role="gridcell"]').filter({ hasText: CUSTOMER }),
    ).toHaveCount(1);
    await expectNoSeriousA11yViolations(visitor, 'shared grid with links and files');
    await visitor.setViewportSize({ width: 375, height: 800 });
    const card = visitor.getByRole('button', { name: new RegExp(ORDER, 'u') }).first();
    await expect(card).toContainText(CUSTOMER);
    await card.click();
    await visitor
      .getByRole('dialog')
      .getByRole('button', { name: `View ${PDF_NAME}` })
      .click();
    await expect(visitor.getByTestId('attachment-lightbox')).toBeVisible();
    await expect(visitor.getByTestId('attachment-lightbox-download')).toHaveCount(0);
    await visitor.context().close();
  });
});
