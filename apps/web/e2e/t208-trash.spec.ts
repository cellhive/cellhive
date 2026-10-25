import { type Locator, type Page, type Response } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  retryDelayMs,
  signInFirstAdmin,
} from './support';

/**
 * The first administrator of the E2E stack: created by `t011.spec.ts` when it
 * runs first, else here (same values, so the specs work alone or together).
 * `signInFirstAdmin` also covers a stack that only `seed:demo` seeded
 * (no `/setup`, the demo admin invites this one — H6, T470).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
/**
 * A run-scoped email (as t313-view-realtime.spec.ts does), computed fresh
 * for each test run rather than once at module load: the admin and the
 * base/table/records are all created fresh per run, but an org invitation
 * email must be unique org-wide, so a fixed (or module-level, load-once)
 * one collides across repeated runs against the same stack (`--repeat-each`,
 * or the spec run twice without a fresh `pnpm test:e2e`).
 */
function reader() {
  return {
    name: 'Lê Thị Đọc',
    email: `reader-t208-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}@cellhive.test`,
    password: 'E2E-Reader-Password-2026',
  };
}
const TABLE_NAME = 'Đơn hàng';
const RECORD_NAMES = ['Đơn số 1', 'Đơn số 2', 'Đơn số 3'];

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

/**
 * Clicks `button` and waits for the response `match`-ing, retrying the click
 * while the server answers `429` (SPEC §13.1 write limits: `--repeat-each`
 * and the full suite can burst past them). The mutation itself never
 * retries (`mutations: { retry: false }`, `lib/query/client.ts`, since most
 * writes are not safe to repeat blindly on the client's own initiative), so
 * this waits like `support.ts`'s `retryWhileRateLimited` does for a direct
 * API call, then does what a person facing a failed click would: try again.
 * The deterministic HTTP answer (not the toast it triggers) is the signal:
 * a slow answer under load fails with a clear status instead of an
 * ambiguous "toast text never showed up" timeout.
 */
async function clickUntilAccepted(
  page: Page,
  button: Locator,
  match: (response: Response) => boolean,
): Promise<Response> {
  const deadline = Date.now() + 70_000;
  for (;;) {
    const waiting = page.waitForResponse(match);
    await button.click();
    const response = await waiting;
    if (response.status() !== 429 || Date.now() >= deadline) return response;
    await new Promise((resolve) => {
      setTimeout(resolve, retryDelayMs(response.headers()['retry-after'] ?? null, deadline));
    });
  }
}

interface Ids {
  baseId: string;
  tableId: string;
  recordIds: string[];
}

test('T208: trash lists who deleted what, restores, and hides restore from readers', async ({
  page,
  browser,
}) => {
  const cspViolations = collectCspViolations(page);
  const ids: Ids = { baseId: '', tableId: '', recordIds: [] };
  const READER = reader();

  await test.step('set up: base, table, 3 records deleted through the API', async () => {
    await page.goto('/login');
    // The worker's administrator (T800): invited into the worker's organization if new.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Thùng rác E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=name`,
      { records: RECORD_NAMES.map((name) => ({ fields: { Name: name } })) },
    );
    ids.recordIds = created.records.map((record) => record.id);
    expect(ids.recordIds).toHaveLength(3);
    await ok(page, 'DELETE', `/tables/${table.id}/records`, { ids: ids.recordIds });

    // A reader of the base: invited, account created, `system_reader` role.
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${orgId}/invitations`,
      { email: READER.email, role: 'member' },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: READER.name, password: READER.password },
    );
    await guest.close();
    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const readerRole = roles.items.find((role) => role.kind === 'system_reader');
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: accepted.user.id,
      role_id: readerRole?.id,
    });
  });

  const trashPath = () => `/b/${ids.baseId}/t/${ids.tableId}/trash`;

  await test.step('the grid of the table links to its trash', async () => {
    // `/b/:baseId` opens the first table of the base (T202).
    await page.goto(`/b/${ids.baseId}`);
    // … and its first view (T310).
    await expect(page).toHaveURL(
      new RegExp(`/b/${ids.baseId}/t/${ids.tableId}/v/viw_[0-9A-Za-z]{16}$`, 'u'),
    );
    await page.getByRole('link', { name: `Trash of ${TABLE_NAME}` }).click();
    await expect(page).toHaveURL(new RegExp(`${trashPath()}$`, 'u'));
    await expect(
      page.getByRole('heading', { level: 1, name: `Trash of ${TABLE_NAME}` }),
    ).toBeVisible();
  });

  await test.step('the 3 deleted records show who deleted them', async () => {
    const table = page.getByRole('table', { name: `Deleted records of ${TABLE_NAME}` });
    const rows = table.getByRole('row').filter({ has: page.getByRole('checkbox') });
    // Header row has the "select all" checkbox too.
    await expect(rows).toHaveCount(4);
    for (const name of RECORD_NAMES) {
      const row = table.getByRole('row').filter({ hasText: name });
      await expect(row).toContainText(ADMIN.name);
      await expect(row).toContainText('30 days left');
    }
    await expectNoSeriousA11yViolations(page, 'trash (records)');
  });

  const isRecordRestore = (response: Response) =>
    response.url().includes(`/api/v1/tables/${ids.tableId}/records/restore`) &&
    response.request().method() === 'POST';

  await test.step('restore one from its row, then the others together', async () => {
    const one = await clickUntilAccepted(
      page,
      page.getByRole('button', { name: `Restore ${RECORD_NAMES[0] ?? ''}` }),
      isRecordRestore,
    );
    expect(one.status(), 'restore one record').toBeLessThan(300);
    await expect(page.getByText('1 record restored.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: RECORD_NAMES[0] ?? '' })).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select all loaded records' }).check();
    await expect(page.getByRole('region', { name: '2 records selected' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'trash (selection)');
    const rest = await clickUntilAccepted(
      page,
      page.getByRole('button', { name: 'Restore selected records' }),
      isRecordRestore,
    );
    expect(rest.status(), 'restore selected records').toBeLessThan(300);
    await expect(page.getByText('2 records restored.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The trash is empty' })).toBeVisible();
  });

  await test.step('restored records are back in the table and gone from the trash', async () => {
    const trash = await ok<{ records: unknown[] }>(
      page,
      'GET',
      `/tables/${ids.tableId}/records/trash`,
    );
    expect(trash.records).toEqual([]);
    const list = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=name`,
      {},
    );
    expect(list.records.map((record) => record.fields['Name']).sort()).toEqual(RECORD_NAMES);
  });

  await test.step('a deleted field can be restored from the Fields tab', async () => {
    const field = await ok<{ id: string }>(page, 'POST', `/tables/${ids.tableId}/fields`, {
      name: 'Ghi chú',
      type: 'text',
    });
    await ok(page, 'DELETE', `/fields/${field.id}`);
    await page.getByRole('tab', { name: 'Fields' }).click();
    await expect(page).toHaveURL(/\?tab=fields$/u);
    const response = await clickUntilAccepted(
      page,
      page.getByRole('button', { name: 'Restore field Ghi chú' }),
      (candidate) =>
        candidate.url().includes(`/api/v1/fields/${field.id}/restore`) &&
        candidate.request().method() === 'POST',
    );
    expect(response.status(), 'POST /fields/:id/restore').toBeLessThan(300);
    // Now that the server side is confirmed done, the toast and the empty
    // list are just the (already triggered) UI catching up.
    await expect(page.getByRole('heading', { name: 'No deleted fields' })).toBeVisible();
    await expect(page.getByText('Field Ghi chú restored with its data.')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'trash (fields)');
  });

  await test.step('a reader sees neither the trash link nor restore buttons', async () => {
    await ok(page, 'DELETE', `/tables/${ids.tableId}/records`, {
      ids: [ids.recordIds[0]],
    });
    const context = await browser.newContext();
    const reader = await context.newPage();
    await signIn(reader, READER.email, READER.password);
    await reader.goto(`/b/${ids.baseId}`);
    await expect(reader.getByRole('heading', { level: 1, name: TABLE_NAME })).toBeVisible();
    await expect(reader.getByRole('link', { name: `Trash of ${TABLE_NAME}` })).toHaveCount(0);

    await reader.goto(trashPath());
    await expect(
      reader.getByRole('heading', { name: 'No access to deleted records' }),
    ).toBeVisible();
    await expect(reader.getByRole('button', { name: /Restore/u })).toHaveCount(0);
    await expect(reader.getByRole('checkbox')).toHaveCount(0);
    await expect(reader.getByRole('tab', { name: 'Fields' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(reader, 'trash (reader)');
    await context.close();
  });

  expect(cspViolations, 'Content-Security-Policy violations').toEqual([]);
});
