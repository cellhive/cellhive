import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T315: form views. Self-contained like t314: the first administrator
 * (created by t011 when it runs first, else here), a "Phiếu yêu cầu" table,
 * an "Agent" member whose role adds records, and a "Viewer" member whose
 * role only reads. The admin builds the form in the UI; the agent submits
 * it and the record appears in the admin's grid (realtime).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const AGENT = {
  name: 'Trần Thị Gửi',
  email: `agent-t315-${RUN}@cellhive.test`,
  password: 'E2E-Agent-Password-2026',
};
const VIEWER = {
  name: 'Lê Văn Xem',
  email: `viewer-t315-${RUN}@cellhive.test`,
  password: 'E2E-Viewer-Password-2026',
};
const TABLE_NAME = 'Phiếu yêu cầu';

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

async function openAs(
  browser: Browser,
  email: string,
  password: string,
  viewport = { width: 1400, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

interface ViewDto {
  id: string;
  name: string;
  type: string;
  config: { form?: { fields: { field: string; required: boolean }[] } };
}

interface RecordDto {
  id: string;
  fields: Record<string, unknown>;
}

const ids = {
  orgId: '',
  baseId: '',
  tableId: '',
  gridViewId: '',
  formViewId: '',
  onceViewId: '',
  agentId: '',
  fields: {} as Record<string, string>,
};
const tablePath = () => `/b/${ids.baseId}/t/${ids.tableId}`;
const viewPath = (viewId: string) => `${tablePath()}/v/${viewId}`;

async function invite(browser: Browser, page: Page, person: typeof AGENT): Promise<string> {
  const invitation = await ok<{ invite_url: string }>(
    page,
    'POST',
    `/orgs/${ids.orgId}/invitations`,
    { email: person.email, role: 'member' },
  );
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  const guest = await browser.newContext();
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

async function records(page: Page): Promise<RecordDto[]> {
  const answer = await ok<{ records: RecordDto[] }>(
    page,
    'POST',
    `/tables/${ids.tableId}/records/query?field_key_type=name`,
    { limit: 200 },
  );
  return answer.records;
}

function question(page: Page, name: string | RegExp) {
  return page.getByTestId('form-question').filter({ hasText: name });
}

test.describe('T315 forms', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1400, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: 'Form E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Tiếp nhận',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${table.id}/fields`,
    );
    for (const field of fields.items) ids.fields[field.name] = field.id;
    for (const body of [
      {
        name: 'Mức độ',
        type: 'select',
        options: { options: [{ name: 'Cao' }, { name: 'Thấp' }] },
      },
      { name: 'Số tiền', type: 'number' },
      { name: 'Nguồn', type: 'text' },
    ]) {
      const field = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, body);
      ids.fields[body.name] = field.id;
    }
    const views = await ok<{ items: ViewDto[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.gridViewId = views.items[0]?.id ?? '';
    // A second form, limited to one response per person (sign-in required).
    const once = await ok<ViewDto>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Đăng ký một lần',
      type: 'form',
      config: {
        form: { title: 'Đăng ký', require_login: true, submission_limit: 'once' },
      },
    });
    ids.onceViewId = once.id;

    const role = (name: string, perm: string, operations: string[]) =>
      ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
        name: `${name} ${RUN}`,
        config: {
          tables: {
            [table.id]: {
              perm,
              view_rule: { allow_edit: false, visible_views: null },
              record_rule: { operations },
            },
          },
        },
      });
    // The agent adds records (operation `add`); the viewer only reads.
    const agentRole = await role('Agent', 'edit', ['add']);
    const viewerRole = await role('Viewer', 'read_only', []);
    ids.agentId = await invite(browser, page, AGENT);
    const viewerId = await invite(browser, page, VIEWER);
    for (const [userId, roleId] of [
      [ids.agentId, agentRole.id],
      [viewerId, viewerRole.id],
    ] as const) {
      await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
        principal_type: 'user',
        principal_id: userId,
        role_id: roleId,
      });
    }
    await page.close();
  });

  test('the admin builds a form: new form view, reorder, required; axe', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(viewPath(ids.gridViewId));
    const viewBar = page.getByRole('navigation', { name: `Views of ${TABLE_NAME}` });
    await viewBar.getByRole('button', { name: 'New view' }).click();
    await page.getByTestId('create-view-shared-form').click();
    await expect(viewBar.getByRole('link', { name: 'Form view' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    ids.formViewId = new URL(page.url()).pathname.split('/').pop() ?? '';
    await expect(page.getByRole('button', { name: 'Build', pressed: true })).toBeVisible();
    const builderQuestions = page.getByTestId('form-builder-question');
    // The default form asks every writable field in table order.
    await expect(builderQuestions).toHaveCount(4);

    await page.getByLabel('Title', { exact: true }).fill('Báo sự cố');
    await page.getByRole('button', { name: 'Move Số tiền up' }).click();
    await builderQuestions
      .filter({ hasText: 'Mức độ' })
      .getByRole('checkbox', { name: 'Required' })
      .check();
    await expect(builderQuestions.first()).toContainText('Name');
    await expect(builderQuestions.nth(1)).toContainText('Số tiền');
    await expectNoSeriousA11yViolations(page, 'form builder');

    // Saved into the view (debounced PATCH) without pressing anything.
    await expect
      .poll(
        async () => {
          const view = await ok<ViewDto>(page, 'GET', `/views/${ids.formViewId}`);
          return view.config.form?.fields.map((item) => [item.field, item.required]);
        },
        { timeout: 10_000 },
      )
      .toEqual([
        [ids.fields['Name'], false],
        [ids.fields['Số tiền'], false],
        [ids.fields['Mức độ'], true],
        [ids.fields['Nguồn'], false],
      ]);

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Báo sự cố' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'form preview');
    expect(cspViolations).toEqual([]);
  });

  test('a member submits; the record appears in the admin grid (realtime) with the submitter', async ({
    browser,
  }) => {
    const admin = await openAs(browser, ADMIN.email, ADMIN.password);
    await admin.goto(viewPath(ids.gridViewId));
    await expect(admin.locator('table[role="grid"]')).toBeAttached();
    await admin.waitForTimeout(500);

    const agent = await openAs(browser, AGENT.email, AGENT.password);
    await agent.goto(viewPath(ids.formViewId));
    await expect(agent.getByRole('heading', { level: 2, name: 'Báo sự cố' })).toBeVisible();
    // Members fill in: no builder.
    await expect(agent.getByRole('button', { name: 'Build' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(agent, 'form fill');

    await question(agent, 'Name').getByRole('textbox').fill('Máy in kẹt giấy');
    await question(agent, 'Mức độ').getByRole('radio', { name: 'Cao' }).check();
    await question(agent, 'Số tiền').getByRole('textbox').fill('1500');
    await agent.getByRole('button', { name: 'Submit' }).click();
    await expect(agent.getByRole('heading', { name: 'Response sent' })).toBeVisible();

    // Realtime: the grid announces the new row at once (T313), and shows it on request.
    const newRows = admin.getByRole('button', { name: '1 new row' });
    await expect(newRows).toBeVisible({ timeout: 5000 });
    await newRows.click();
    await expect(
      admin
        .locator('table[role="grid"] td[role="gridcell"]')
        .filter({ hasText: 'Máy in kẹt giấy' }),
    ).toHaveCount(1);
    const record = (await records(admin)).find((item) => item.fields['Name'] === 'Máy in kẹt giấy');
    expect(record?.fields['Mức độ']).toBe('Cao');
    expect(record?.fields['Số tiền']).toBe(1500);
    const history = await ok<{ items: { actor: { id: string | null } }[] }>(
      admin,
      'GET',
      `/tables/${ids.tableId}/records/${record?.id ?? ''}/history`,
    );
    expect(history.items.at(-1)?.actor.id).toBe(ids.agentId);
    await admin.context().close();
    await agent.context().close();
  });

  test('a required question left empty shows its error and nothing is sent', async ({
    browser,
  }) => {
    const agent = await openAs(browser, AGENT.email, AGENT.password);
    const submits: string[] = [];
    agent.on('request', (request) => {
      if (request.url().includes('/submit')) submits.push(request.url());
    });
    await agent.goto(viewPath(ids.formViewId));
    await question(agent, 'Name').getByRole('textbox').fill('Thiếu mức độ');
    await agent.getByRole('button', { name: 'Submit' }).click();
    const priority = question(agent, 'Mức độ');
    await expect(priority).toContainText('This field is required.');
    await expect(priority.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');
    expect(submits).toEqual([]);
    await agent.context().close();
  });

  test('a limit of one response: the second submission shows the limit', async ({ browser }) => {
    const agent = await openAs(browser, AGENT.email, AGENT.password);
    await agent.goto(viewPath(ids.onceViewId));
    await question(agent, 'Name').getByRole('textbox').fill('Đăng ký lần một');
    await agent.getByRole('button', { name: 'Submit' }).click();
    await expect(agent.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    // No "submit another" on a form limited to once.
    await expect(agent.getByRole('button', { name: 'Submit another response' })).toHaveCount(0);

    // Opened again: the limit shows at once (T320c, `GET …/submission-status`).
    await agent.reload();
    const limit = agent.getByTestId('form-limit');
    await expect(limit).toContainText('You have already filled in this form');
    await expect(limit).toContainText('This form accepts one response per person.');
    await expectNoSeriousA11yViolations(agent, 'form limit');
    await agent.context().close();
  });

  test('prefill + hide in the URL write the hidden value', async ({ browser }) => {
    const agent = await openAs(browser, AGENT.email, AGENT.password);
    const source = ids.fields['Nguồn'] ?? '';
    const name = ids.fields['Name'] ?? '';
    await agent.goto(
      `${viewPath(ids.formViewId)}?prefill_${source}=Zalo&hide_${source}=1&prefill_${name}=${encodeURIComponent('Điền sẵn')}`,
    );
    await expect(question(agent, 'Name').getByRole('textbox')).toHaveValue('Điền sẵn');
    await expect(question(agent, 'Nguồn')).toHaveCount(0);
    await question(agent, 'Mức độ').getByRole('radio', { name: 'Thấp' }).check();
    await agent.getByRole('button', { name: 'Submit' }).click();
    await expect(agent.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await records(agent)).find((item) => item.fields['Name'] === 'Điền sẵn')?.fields[
            'Nguồn'
          ],
      )
      .toBe('Zalo');
    await agent.context().close();
  });

  test('a reader sees that they cannot submit; the form works at 375 px', async ({ browser }) => {
    const viewer = await openAs(browser, VIEWER.email, VIEWER.password, {
      width: 375,
      height: 800,
    });
    await viewer.goto(viewPath(ids.formViewId));
    await expect(viewer.getByText(/your role does not let you add records/u)).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Submit' })).toHaveCount(0);
    await viewer.context().close();

    const agent = await openAs(browser, AGENT.email, AGENT.password, { width: 375, height: 800 });
    await agent.goto(viewPath(ids.formViewId));
    const submit = agent.getByRole('button', { name: 'Submit' });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeVisible();
    // Touch targets and no sideways scrolling.
    expect((await submit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    const radio = question(agent, 'Mức độ').locator('label').first();
    expect((await radio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    const overflow = await agent.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoSeriousA11yViolations(agent, 'form at 375 px');
    await agent.context().close();
  });
});
