import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { ok, signInFirstAdmin } from './support';

/**
 * T321 — S3 follow-ups on form links: people questions are hidden on public
 * links and offered from the base members (`{ id, display_name }`) on
 * organization links (a note in the builder says so), and a form that
 * requires sign-in opens on its limit screen once the person reached it
 * (`GET /shares/:token/submission-status`). Self-contained like t317.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const OWNER_FIELD = 'Người phụ trách';
const FORM_TITLE = 'Yêu cầu hỗ trợ T321';

async function english(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
}

async function anonymous(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await english(context);
  return context.newPage();
}

test.describe('T321 form link follow-ups', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1280, height: 900 } });

  const ids = {
    baseId: '',
    tableId: '',
    publicFormId: '',
    adminId: '',
    adminName: '',
    publicToken: '',
    orgToken: '',
    onceToken: '',
  };
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
    const me = await ok<{ user: { id: string; display_name: string }; orgs: { id: string }[] }>(
      page,
      'GET',
      '/me',
    );
    ids.adminId = me.user.id;
    ids.adminName = me.user.display_name;
    const orgId = me.orgs[0]?.id ?? '';
    await ok(page, 'PATCH', `/orgs/${orgId}`, { settings: { public_sharing: 'allowed' } });
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `Form links ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hỗ trợ',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Yêu cầu',
    });
    ids.tableId = table.id;
    const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${table.id}/fields`,
    );
    const nameId = fields.items.find((item) => item.is_primary)?.id ?? '';
    const ownerId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: OWNER_FIELD,
        type: 'user',
        options: { multiple: false },
      })
    ).id;
    const formConfig = (extra: object = {}) => ({
      form: {
        title: FORM_TITLE,
        fields: [{ field: nameId, required: true }, { field: ownerId }],
        ...extra,
      },
    });
    const view = (name: string, config: object) =>
      ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
        name,
        type: 'form',
        config,
      });
    const link = async (viewId: string, audience: 'public' | 'org') =>
      (
        await ok<{ token: string }>(page, 'POST', `/views/${viewId}/share-links`, {
          audience,
        })
      ).token;
    ids.publicFormId = (await view('Form công khai', formConfig())).id;
    ids.publicToken = await link(ids.publicFormId, 'public');
    ids.orgToken = await link((await view('Form nội bộ', formConfig())).id, 'org');
    const once = await view(
      'Form một lần',
      formConfig({ require_login: true, submission_limit: 'once' }),
    );
    ids.onceToken = await link(once.id, 'public');
    await page.close();
  });

  test('the builder says people questions are hidden from people outside the organization', async ({
    page,
  }) => {
    await asAdmin(page);
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/v/${ids.publicFormId}`);
    const question = page.getByTestId('form-builder-question').filter({ hasText: OWNER_FIELD });
    await expect(question.getByTestId('form-builder-user-note')).toHaveText(
      'Hidden from people outside the organization',
    );
  });

  test('a public form link leaves the people question out and never lists members', async ({
    browser,
  }) => {
    const visitor = await anonymous(browser);
    const memberCalls: string[] = [];
    visitor.on('request', (request) => {
      if (request.url().includes('/members')) memberCalls.push(request.url());
    });
    await visitor.goto(`/s/${ids.publicToken}`);
    await expect(visitor.getByRole('heading', { level: 1, name: FORM_TITLE })).toBeVisible();
    await expect(visitor.getByTestId('form-question')).toHaveCount(1);
    await expect(visitor.getByText(OWNER_FIELD)).toHaveCount(0);
    await visitor.getByTestId('form-question').getByRole('textbox').fill('Khách ngoài hỏi');
    await visitor.getByRole('button', { name: 'Submit' }).click();
    await expect(visitor.getByRole('heading', { name: 'Response sent' })).toBeVisible({
      timeout: 15_000,
    });
    expect(memberCalls).toEqual([]);
    await visitor.context().close();
  });

  test('an organization form link offers the base members by name, without emails', async ({
    page,
  }) => {
    await asAdmin(page);
    const members = page.waitForResponse((response) =>
      response.url().endsWith(`/shares/${ids.orgToken}/members`),
    );
    await page.goto(`/s/${ids.orgToken}`);
    const listed = await members;
    expect(listed.status()).toBe(200);
    expect(await listed.text()).not.toContain('@');
    await expect(page.getByRole('heading', { level: 1, name: FORM_TITLE })).toBeVisible();
    await page
      .getByTestId('form-question')
      .filter({ hasText: 'Name' })
      .getByRole('textbox')
      .fill('Việc của quản trị');
    await page
      .getByTestId('form-question')
      .filter({ hasText: OWNER_FIELD })
      .getByRole('combobox')
      .selectOption({ label: ids.adminName });
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Response sent' })).toBeVisible({
      timeout: 15_000,
    });
    const list = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=name`,
      { limit: 200 },
    );
    const record = list.records.find((item) => item.fields['Name'] === 'Việc của quản trị');
    expect(record?.fields[OWNER_FIELD]).toEqual([expect.objectContaining({ id: ids.adminId })]);
  });

  test('a sign-in form opens on its limit screen once the person reached it', async ({
    browser,
    page,
  }) => {
    await test.step('without a session: sign in first', async () => {
      const visitor = await anonymous(browser);
      await visitor.goto(`/s/${ids.onceToken}`);
      await expect(visitor).toHaveURL(/\/login\?next=/u);
      await visitor.context().close();
    });

    await asAdmin(page);
    await test.step('the first visit fills the form in', async () => {
      await page.goto(`/s/${ids.onceToken}`);
      await page
        .getByTestId('form-question')
        .filter({ hasText: 'Name' })
        .getByRole('textbox')
        .fill('Lần đầu');
      await page.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByRole('heading', { name: 'Response sent' })).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step('opening it again shows the limit at once', async () => {
      const status = page.waitForResponse((response) =>
        response.url().endsWith(`/shares/${ids.onceToken}/submission-status`),
      );
      await page.goto(`/s/${ids.onceToken}`);
      expect(await (await status).json()).toEqual({
        limit: 'once',
        reached: true,
        next_allowed_at: null,
      });
      await expect(page.getByTestId('form-limit')).toBeVisible();
      await expect(page.getByText('You have already filled in this form')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
    });
  });
});
