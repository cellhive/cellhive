import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  api,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T317 — the public share pages `/s/:token` and the S3 milestone (SPEC §22:
 * "Tạo form public, dữ liệu vào grid"). Self-contained like t316: the first
 * administrator (created by t011 when it runs first, else here), its own
 * workspace/base/table, a "Sales" member whose role reads no `cost` and may
 * share (the P30 variant, BACKLOG S3 decision 1) and an account outside the
 * organization (a removed member). Anonymous visitors are fresh browser contexts.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const SALES = {
  name: 'Trần Thị Bán',
  email: `sales-t317-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const OUTSIDER = {
  name: 'Phạm Văn Ngoài',
  email: `outsider-t317-${RUN}@cellhive.test`,
  password: 'E2E-Outsider-Password-2026',
};
const TABLE_NAME = 'Đơn hàng S3';
const FORM_TITLE = 'Gửi yêu cầu báo giá';
const LINK_PASSWORD = 'mat-khau-dung-42';
const TOKEN_URL = /\/s\/([A-Za-z0-9_-]{43})$/u;

async function english(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
}

/** A browser without any session (someone the link was sent to). */
async function anonymous(browser: Browser, viewport = { width: 1400, height: 900 }): Promise<Page> {
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

interface CreatedLink {
  id: string;
  token: string;
}

test.describe('T317 public share pages (S3 milestone)', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1400, height: 900 } });

  const ids = {
    orgId: '',
    baseId: '',
    tableId: '',
    gridViewId: '',
    salesViewId: '',
    lockedViewId: '',
    formViewId: '',
    formLinkId: '',
    formToken: '',
    salesToken: '',
    lockedToken: '',
    orgToken: '',
  };
  /** The administrator's session, signed in once (20 sign-ins a minute per IP). */
  let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

  async function asAdmin(page: Page): Promise<void> {
    await english(page.context());
    await page.context().addCookies(adminCookies);
    await page.goto('/login');
  }

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    adminCookies = await page.context().cookies();
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    await ok(page, 'PATCH', `/orgs/${ids.orgId}`, { settings: { public_sharing: 'allowed' } });
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `Share pages ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const fieldIds: Record<string, string> = {};
    const initial = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${table.id}/fields`,
    );
    for (const field of initial.items) fieldIds[field.name] = field.id;
    for (const body of [
      { name: 'Số tiền', type: 'number' },
      { name: 'Giá vốn', type: 'number' },
    ]) {
      fieldIds[body.name] = (
        await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, body)
      ).id;
    }
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: [
        { fields: { Name: 'Đơn A', 'Số tiền': 10, 'Giá vốn': 1 } },
        { fields: { Name: 'Đơn B', 'Số tiền': 20, 'Giá vốn': 2 } },
        { fields: { Name: 'Đơn nháp', 'Số tiền': 0, 'Giá vốn': 3 } },
      ],
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.gridViewId = views.items[0]?.id ?? '';
    const view = (body: object) =>
      ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, body);
    const salesFilter = {
      op: 'and',
      items: [{ field: fieldIds['Số tiền'], operator: 'gt', value: 0 }],
    };
    ids.salesViewId = (
      await view({ name: 'Sales', type: 'grid', config: { filter: salesFilter } })
    ).id;
    ids.lockedViewId = (
      await view({ name: 'Nội bộ', type: 'grid', config: { filter: salesFilter } })
    ).id;
    ids.formViewId = (
      await view({
        name: 'Form báo giá',
        type: 'form',
        config: {
          form: {
            title: FORM_TITLE,
            fields: [{ field: fieldIds['Name'], required: true }, { field: fieldIds['Số tiền'] }],
          },
        },
      })
    ).id;

    // Sales (P30 variant): reads the table except `Giá vốn`, may share, sees the Sales view.
    const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales sharing ${RUN}`,
      config: {
        base_rule: { copy: false, download: false, share_link: true },
        tables: {
          [table.id]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: [ids.salesViewId] },
            field_rule: { mode: 'specify', fields: { [fieldIds['Giá vốn'] ?? '']: 'no_perm' } },
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

    // Someone outside the organization: an account that left it (removed member).
    const outsiderId = await invite(page, ids.orgId, OUTSIDER);
    await ok(page, 'DELETE', `/orgs/${ids.orgId}/members/${outsiderId}`);

    // A password link and an organization-only link, made by the admin.
    const locked = await ok<CreatedLink>(page, 'POST', `/views/${ids.lockedViewId}/share-links`, {
      audience: 'public',
      password: LINK_PASSWORD,
    });
    ids.lockedToken = locked.token;
    const orgOnly = await ok<CreatedLink>(page, 'POST', `/views/${ids.gridViewId}/share-links`, {
      audience: 'org',
    });
    ids.orgToken = orgOnly.token;

    // The Sales member shares the Sales view publicly, without viewer filter/sort/search.
    const salesContext = await browser.newContext();
    const salesPage = await salesContext.newPage();
    await salesPage.goto('/login');
    await apiSignIn(salesPage, SALES.email, SALES.password);
    const salesLink = await ok<CreatedLink>(
      salesPage,
      'POST',
      `/views/${ids.salesViewId}/share-links`,
      {
        audience: 'public',
        settings: { allow_viewer_filter_sort: false, allow_search: false, allow_copy: false },
      },
    );
    ids.salesToken = salesLink.token;
    await salesContext.close();
    await page.close();
  });

  test('admin creates a public form link; an anonymous visitor submits; the record reaches the admin grid (realtime) with the link as actor', async ({
    browser,
    page,
  }) => {
    const cspViolations = collectCspViolations(page);
    await asAdmin(page);
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/v/${ids.formViewId}`);

    await test.step('the admin creates the public link in the share dialog', async () => {
      await page.getByRole('button', { name: 'Share view Form báo giá' }).click();
      const dialog = page.getByRole('dialog', { name: 'Share “Form báo giá”' });
      await dialog.getByRole('radio', { name: 'Anyone with the link' }).check();
      await dialog
        .getByRole('checkbox', { name: 'I understand who will be able to fill in this form' })
        .check();
      await dialog.getByRole('button', { name: 'Create link' }).click();
      const address = dialog.getByRole('textbox', { name: 'Link address' });
      await expect(address).toHaveValue(TOKEN_URL);
      ids.formToken = TOKEN_URL.exec(await address.inputValue())?.[1] ?? '';
      const links = await ok<{ items: { id: string }[] }>(
        page,
        'GET',
        `/views/${ids.formViewId}/share-links`,
      );
      ids.formLinkId = links.items[0]?.id ?? '';
      await page.keyboard.press('Escape');
    });

    // The admin watches the grid of the table.
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/v/${ids.gridViewId}`);
    await expect(page.locator('table[role="grid"]')).toBeAttached();
    await page.waitForTimeout(500);

    const visitor = await anonymous(browser);
    const visitorCsp = collectCspViolations(visitor);
    await test.step('the anonymous visitor fills in the public form', async () => {
      const response = await visitor.goto(`/s/${ids.formToken}`);
      expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
      expect(response?.headers()['referrer-policy']).toBe('no-referrer');
      await expect(visitor.getByRole('heading', { level: 1, name: FORM_TITLE })).toBeVisible();
      await expect(visitor.locator('meta[name="robots"]').first()).toHaveAttribute(
        'content',
        'noindex, nofollow',
      );
      // No app shell: no navigation, no account menu, nothing about the organization.
      await expect(visitor.getByRole('navigation')).toHaveCount(0);
      await expect(visitor.getByText(WORKER_ORG.ownerOrgName)).toHaveCount(0);
      await expectNoSeriousA11yViolations(visitor, 'public form');
      await visitor
        .getByTestId('form-question')
        .filter({ hasText: 'Name' })
        .getByRole('textbox')
        .fill('Khách vãng lai hỏi giá');
      await visitor
        .getByTestId('form-question')
        .filter({ hasText: 'Số tiền' })
        .getByRole('textbox')
        .fill('750');
      await visitor.getByRole('button', { name: 'Submit' }).click();
      // The minimum fill time (3 s) is waited for by the page.
      await expect(visitor.getByRole('heading', { name: 'Response sent' })).toBeVisible({
        timeout: 15_000,
      });
      await expectNoSeriousA11yViolations(visitor, 'public form sent');
    });

    await test.step('the record appears in the admin grid at once, made by the link', async () => {
      const newRows = page.getByRole('button', { name: '1 new row' });
      await expect(newRows).toBeVisible({ timeout: 5000 });
      await newRows.click();
      await expect(
        page
          .locator('table[role="grid"] td[role="gridcell"]')
          .filter({ hasText: 'Khách vãng lai hỏi giá' }),
      ).toHaveCount(1);
      const list = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
        page,
        'POST',
        `/tables/${ids.tableId}/records/query?field_key_type=name`,
        { limit: 200 },
      );
      const record = list.records.find((item) => item.fields['Name'] === 'Khách vãng lai hỏi giá');
      expect(record?.fields['Số tiền']).toBe(750);
      const history = await ok<{
        items: { actor: { type: string; id: string | null; name: string | null } }[];
      }>(page, 'GET', `/tables/${ids.tableId}/records/${record?.id ?? ''}/history`);
      expect(history.items.at(-1)?.actor).toMatchObject({
        type: 'share_link',
        id: ids.formLinkId,
      });
    });
    expect(cspViolations).toEqual([]);
    expect(visitorCsp).toEqual([]);
    await visitor.context().close();
  });

  test('the public form is usable at 375 px', async ({ browser }) => {
    const visitor = await anonymous(browser, { width: 375, height: 800 });
    await visitor.goto(`/s/${ids.formToken}`);
    await expect(visitor.getByRole('heading', { level: 1, name: FORM_TITLE })).toBeVisible();
    const scrollWidth = await visitor.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
    await expect(visitor.getByRole('button', { name: 'Submit' })).toBeVisible();
    await visitor.context().close();
  });

  test('a public view link shows only its scope (P30 variant); viewer tools off', async ({
    browser,
  }) => {
    const visitor = await anonymous(browser);
    await visitor.goto(`/s/${ids.salesToken}`);
    await expect(visitor.getByRole('heading', { level: 1, name: 'Sales' })).toBeVisible();
    // Đơn A, Đơn B and the record sent through the form (amount > 0); not the draft.
    await expect(visitor.getByTestId('share-count')).toHaveText('3 records');
    const grid = visitor.locator('table[role="grid"]');
    await expect(grid.locator('td[role="gridcell"]').filter({ hasText: 'Đơn B' })).toHaveCount(1);
    await expect(grid.locator('td[role="gridcell"]').filter({ hasText: 'Đơn A' })).toHaveCount(1);
    // Outside the view filter, and a field the creator cannot read.
    await expect(grid.getByText('Đơn nháp')).toHaveCount(0);
    await expect(grid.locator('th').filter({ hasText: 'Giá vốn' })).toHaveCount(0);
    await expect(grid.locator('th').filter({ hasText: 'Số tiền' })).toHaveCount(1);
    // The link does not allow viewer filter, sort or search.
    await expect(visitor.getByTestId('filter-button')).toHaveCount(0);
    await expect(visitor.getByTestId('sort-button')).toHaveCount(0);
    await expect(visitor.getByRole('searchbox')).toHaveCount(0);
    await expect(visitor.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'shared grid');

    // Below 768 px: a list of cards.
    await visitor.setViewportSize({ width: 375, height: 800 });
    const cards = visitor.getByTestId('share-card-list');
    await expect(cards).toBeVisible();
    await expect(cards.getByText('Đơn B')).toBeVisible();
    await expect(cards.getByText('Giá vốn')).toHaveCount(0);
    await expectNoSeriousA11yViolations(visitor, 'shared grid cards');
    await visitor.context().close();
  });

  test('a password link: unlock opens it; wrong passwords lock the visitor out', async ({
    browser,
  }) => {
    await test.step('the right password opens the view', async () => {
      const visitor = await anonymous(browser);
      await visitor.goto(`/s/${ids.lockedToken}`);
      await expect(visitor.getByRole('heading', { name: 'This link is protected' })).toBeVisible();
      await expectNoSeriousA11yViolations(visitor, 'share password');
      await visitor.getByLabel('Password').fill(LINK_PASSWORD);
      await visitor.getByRole('button', { name: 'Open' }).click();
      await expect(visitor.getByRole('heading', { level: 1, name: 'Nội bộ' })).toBeVisible();
      await expect(visitor.getByTestId('share-count')).toHaveText('3 records');
      // Records are read with the unlock cookie and its CSRF header (POST).
      await expect(
        visitor.locator('table[role="grid"] td[role="gridcell"]').filter({ hasText: 'Đơn A' }),
      ).toHaveCount(1);
      await visitor.context().close();
    });

    await test.step('five wrong passwords lock the IP out of the link', async () => {
      const visitor = await anonymous(browser);
      await visitor.goto(`/s/${ids.lockedToken}`);
      const input = visitor.getByLabel('Password');
      const message = visitor.getByTestId('share-password-message');
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await input.fill(`sai-${String(attempt)}`);
        await visitor.getByRole('button', { name: 'Open' }).click();
        await expect(message).toHaveText('Wrong password. Try again.');
        await expect(input).toHaveValue('');
      }
      await input.fill(LINK_PASSWORD);
      await visitor.getByRole('button', { name: 'Open' }).click();
      await expect(message).toHaveText(/^Too many wrong passwords\. Try again in 15 minutes\.$/u);
      await expect(input).toBeDisabled();
      await expectNoSeriousA11yViolations(visitor, 'share password locked');
      await visitor.context().close();
    });
  });

  test('an organization link: sign-in first; someone outside the organization gets 404', async ({
    browser,
  }) => {
    const visitor = await anonymous(browser);
    await visitor.goto(`/s/${ids.orgToken}`);
    await expect(visitor).toHaveURL(/\/login\?next=%2Fs%2F/u);
    const next = new URL(visitor.url()).searchParams.get('next') ?? '';
    expect(next).toBe(`/s/${ids.orgToken}`);
    await apiSignIn(visitor, OUTSIDER.email, OUTSIDER.password);
    await visitor.goto(next);
    await expect(visitor.getByRole('heading', { name: 'Link not found' })).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'share not found');
    await visitor.context().close();
  });

  test('a revoked link shows the "no longer available" page, in the chosen language', async ({
    browser,
    page,
  }) => {
    await asAdmin(page);
    const revoked = await api(page, 'DELETE', `/share-links/${ids.formLinkId}`);
    expect(revoked.status).toBe(204);
    // No forced language here: the choice made on the page must survive a reload.
    const visitor = await (await browser.newContext({ locale: 'en-US' })).newPage();
    await visitor.goto(`/s/${ids.formToken}`);
    await expect(
      visitor.getByRole('heading', { name: 'This link is no longer available' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'share gone');
    // Language picker without an account: remembered on the device.
    await visitor.getByLabel('Language').selectOption('vi');
    await expect(visitor.getByRole('heading', { name: 'Link không còn hiệu lực' })).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole('heading', { name: 'Link không còn hiệu lực' })).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'share gone (vi)');
    await visitor.context().close();
  });
});
