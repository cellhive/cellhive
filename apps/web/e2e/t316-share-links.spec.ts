import { type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T316: share link management in the web client. Self-contained like t310:
 * the first administrator (created by t011 when it runs first, else here),
 * its own workspace/base/table and a "Sales" member whose role has no
 * `base_rule.share_link`. The `/s/:token` page is T317: the link is checked
 * through `GET /api/v1/shares/:token/meta`.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const SALES = {
  name: 'Trần Thị Bán',
  email: `sales-t316-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const TABLE_NAME = 'Đơn chia sẻ';
const TOKEN_URL = /\/s\/([A-Za-z0-9_-]{43})$/u;

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

/** Status of the public share API for a token, without any session. */
async function shareStatus(page: Page, token: string): Promise<number> {
  const context = await page.context().browser()?.newContext();
  if (context === undefined) throw new Error('No browser');
  const response = await context.request.get(`/api/v1/shares/${token}/meta`);
  const status = response.status();
  await context.close();
  return status;
}

function tokenOf(url: string): string {
  const match = TOKEN_URL.exec(url);
  if (match === null) throw new Error(`Not a share URL: ${url}`);
  return match[1] ?? '';
}

test.describe('T316 share link management', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1440, height: 900 } });

  const ids = {
    orgId: '',
    orgSlug: '',
    baseId: '',
    tableId: '',
    viewId: '',
    token: '',
  };
  /**
   * The administrator's session cookies, signed in once in `beforeAll`: the
   * login endpoint allows 20 attempts per minute and IP for the whole suite.
   */
  let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
  async function asAdmin(page: Page): Promise<void> {
    await page.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    await page.context().addCookies(adminCookies);
    await page.goto('/login');
  }
  const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;

  function shareButton(page: Page) {
    return page.getByRole('button', { name: 'Share view Grid view' });
  }

  async function openShareDialog(page: Page) {
    await shareButton(page).click();
    const dialog = page.getByRole('dialog', { name: 'Share “Grid view”' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    adminCookies = await page.context().cookies();
    const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    ids.orgSlug = me.orgs[0]?.slug ?? '';
    // Another spec may have left a stricter policy behind.
    await ok(page, 'PATCH', `/orgs/${ids.orgId}`, { settings: { public_sharing: 'allowed' } });
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `Share E2E ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Chia sẻ',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    for (const field of [
      { name: 'Ghi chú', type: 'text' },
      { name: 'Số tiền', type: 'number' },
    ]) {
      await ok(page, 'POST', `/tables/${table.id}/fields`, field);
    }
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ['Đơn 1', 'Đơn 2', 'Đơn 3'].map((name) => ({ fields: { Name: name } })),
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';

    // A "Sales" member: reads the table, no base_rule.share_link (the default).
    const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales ${RUN}`,
      config: {
        tables: {
          [table.id]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: [ids.viewId] },
          },
        },
      },
    });
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${ids.orgId}/invitations`,
      { email: SALES.email, role: 'member' },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: SALES.name, password: SALES.password },
    );
    await guest.close();
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: accepted.user.id,
      role_id: role.id,
    });
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    // Leave the organization as other specs expect it.
    const page = await browser.newPage();
    await asAdmin(page);
    await ok(page, 'PATCH', `/orgs/${ids.orgId}`, { settings: { public_sharing: 'allowed' } });
    // Playwright snapshots the page of a closing context for a failed test's error context:
    // closed while the app still loads, this page (not the failed one) showed "Loading…" (N14).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.close();
  });

  test('admin creates a public link: scope warning, copy once, the link works', async ({
    page,
    context,
  }) => {
    const cspViolations = collectCspViolations(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await asAdmin(page);
    await page.goto(viewPath());
    const dialog = await openShareDialog(page);

    await test.step('the scope warning lists the records and fields outsiders see', async () => {
      const warning = dialog.getByTestId('share-scope-warning');
      await expect(warning).toContainText('People with the link will see 3 records and 3 fields');
      await expect(warning.getByTestId('share-scope-fields').getByRole('listitem')).toHaveText([
        'Name',
        'Ghi chú',
        'Số tiền',
      ]);
      await expectNoSeriousA11yViolations(page, 'share dialog');
    });

    await test.step('creating needs the warning acknowledged', async () => {
      const create = dialog.getByRole('button', { name: 'Create link' });
      await expect(create).toBeDisabled();
      await dialog.getByRole('radio', { name: 'Anyone with the link' }).check();
      // Keyboard: the acknowledgement is a checkbox reachable with Space.
      await dialog
        .getByRole('checkbox', { name: 'I understand who will be able to see this data' })
        .focus();
      await page.keyboard.press('Space');
      await expect(create).toBeEnabled();
      await create.click();
    });

    await test.step('the full address is shown once and copied', async () => {
      await expect(dialog.getByTestId('share-link-once')).toContainText('Copy the link now');
      const address = dialog.getByRole('textbox', { name: 'Link address' });
      await expect(address).toHaveValue(TOKEN_URL);
      ids.token = tokenOf(await address.inputValue());
      // Not hovering a button: axe judges the resting colors.
      await page.mouse.move(0, 0);
      await expectNoSeriousA11yViolations(page, 'share dialog with a new link');
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      await expect(page.getByText('Link copied.')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(TOKEN_URL);
    });

    await test.step('the public API opens the link without a session', async () => {
      expect(await shareStatus(page, ids.token)).toBe(200);
    });

    await test.step('reopened, only the prefix is left', async () => {
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      const again = await openShareDialog(page);
      await expect(again.getByRole('textbox', { name: 'Link address' })).toHaveValue(
        new RegExp(`/s/${ids.token.slice(0, 6)}…$`, 'u'),
      );
      await expect(again.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
      await expect(again.getByText('Active', { exact: true })).toBeVisible();
    });

    await test.step('regenerating (confirmed) stops the old link', async () => {
      const again = page.getByRole('dialog', { name: 'Share “Grid view”' });
      await again.getByRole('button', { name: 'Create new link' }).click();
      const confirm = again.getByRole('alertdialog', { name: 'Create a new link?' });
      await expect(confirm).toContainText('The current link stops working at once.');
      await confirm.getByRole('button', { name: 'Create new link' }).click();
      const address = again.getByRole('textbox', { name: 'Link address' });
      await expect(address).toHaveValue(TOKEN_URL);
      const fresh = tokenOf(await address.inputValue());
      expect(fresh).not.toBe(ids.token);
      expect(await shareStatus(page, ids.token)).toBe(410);
      expect(await shareStatus(page, fresh)).toBe(200);
      ids.token = fresh;
    });
    expect(cspViolations).toEqual([]);
  });

  test('org policy "disabled": the public option is disabled and the link is blocked', async ({
    page,
  }) => {
    await asAdmin(page);
    await page.goto(`/o/${ids.orgSlug}`);
    await page.getByRole('link', { name: 'Share links' }).click();
    await expect(page.getByRole('heading', { name: 'Share links', level: 1 })).toBeVisible();

    await test.step('the impact is shown before saving', async () => {
      await page.getByRole('radio', { name: 'Not allowed' }).check();
      await expect(
        page.getByText(/public links? that (is|are) turned on will be blocked/u),
      ).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'organization share links');
      await page.getByRole('button', { name: 'Save policy' }).click();
      await expect(page.getByText('Public sharing policy saved.')).toBeVisible();
    });

    await test.step('the list shows the link as blocked; it stops working', async () => {
      // By id: every run of this spec (`--repeat-each`) adds a base named "Chia sẻ" to the
      // organization, and a label would pick the first, an earlier run's (T700, N14).
      await page.getByRole('combobox', { name: 'Base' }).selectOption(ids.baseId);
      const table = page.getByRole('table', { name: 'Share links' });
      await expect(table.getByRole('row')).toHaveCount(2);
      await expect(table.getByRole('row').nth(1)).toContainText('Blocked by policy');
      expect(await shareStatus(page, ids.token)).toBe(410);
    });

    await test.step('the share dialog disables the public option and explains', async () => {
      await page.goto(viewPath());
      const dialog = await openShareDialog(page);
      const publicOption = dialog.getByRole('radio', { name: 'Anyone with the link' });
      await expect(publicOption).toBeDisabled();
      await expect(
        dialog.getByText(/Your organization does not allow public links/u),
      ).toBeVisible();
      await expect(dialog.getByText(/This public link does not work/u)).toBeVisible();
    });

    await test.step('allowed again: the link works again', async () => {
      await ok(page, 'PATCH', `/orgs/${ids.orgId}`, { settings: { public_sharing: 'allowed' } });
      expect(await shareStatus(page, ids.token)).toBe(200);
    });
  });

  test('a Sales member without share_link sees no Share button', async ({ page }) => {
    await signIn(page, SALES.email, SALES.password);
    await page.goto(viewPath());
    await expect(page.getByRole('navigation', { name: `Views of ${TABLE_NAME}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Share view/u })).toHaveCount(0);
    // The base settings page does not exist for them either.
    await page.goto(`/b/${ids.baseId}/settings/share-links`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('base settings: list and bulk revoke', async ({ page }) => {
    await asAdmin(page);
    // A second link, to another view, for the organization.
    const second = await ok<{ id: string }>(page, 'POST', `/tables/${ids.tableId}/views`, {
      name: 'Theo tuần',
      type: 'grid',
    });
    const created = await ok<{ url: string }>(page, 'POST', `/views/${second.id}/share-links`, {
      audience: 'org',
    });
    const secondToken = tokenOf(created.url);

    await page.goto(viewPath());
    const dialog = await openShareDialog(page);
    await dialog.getByRole('link', { name: 'All share links of this base' }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${ids.baseId}/settings/share-links$`, 'u'));
    const table = page.getByRole('table', { name: 'Share links' });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table).toContainText('Theo tuần');
    await expect(table).toContainText('Organization');
    await expect(table).toContainText('Public');
    await expectNoSeriousA11yViolations(page, 'base share links');

    await table.getByRole('checkbox', { name: 'Select all links on this page' }).check();
    await expect(page.getByText('2 links selected')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke selected' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Revoke 2 links?' });
    await expect(confirm.getByRole('button', { name: 'Revoke' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('2 links revoked.')).toBeVisible();
    await expect(page.getByText('No share links.')).toBeVisible();
    expect(await shareStatus(page, ids.token)).toBe(410);
    expect(await shareStatus(page, secondToken)).toBe(410);
  });
});
