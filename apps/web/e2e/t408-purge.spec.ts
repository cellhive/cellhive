import { expect, test, WORKER_ORG } from './fixtures';
import {
  api,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * The first administrator of the E2E stack: created by `t011.spec.ts` when it
 * runs first, else here (same values, so the specs work alone or together).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const TABLE_NAME = 'Phiếu xoá';
const RECORD_NAMES = ['Phiếu 1', 'Phiếu 2', 'Phiếu 3', 'Phiếu 4'];

test('T408: delete 3 records permanently from the trash; another tab sees them go', async ({
  page,
  context,
}) => {
  const cspViolations = collectCspViolations(page);
  const ids = { baseId: '', tableId: '', recordIds: [] as string[] };

  await test.step('set up: base, table, 4 records moved to the trash', async () => {
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    // Signed in as them: no second sign-in. It would rotate the session while the
    // login page still boots with the first one, and the `401` of such a request
    // clears the new session cookie (the next call answers `401`).
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Xoá vĩnh viễn E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Kho',
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
    await ok(page, 'DELETE', `/tables/${table.id}/records`, { ids: ids.recordIds });
  });

  const trashPath = () => `/b/${ids.baseId}/t/${ids.tableId}/trash`;
  const other = await context.newPage();

  await test.step('two tabs show the trash', async () => {
    await page.goto(trashPath());
    await other.goto(trashPath());
    for (const tab of [page, other]) {
      const table = tab.getByRole('table', { name: `Deleted records of ${TABLE_NAME}` });
      for (const name of RECORD_NAMES) await expect(table.getByText(name)).toBeVisible();
    }
  });

  await test.step('select 3 records, confirm "Delete permanently"', async () => {
    for (const name of RECORD_NAMES.slice(0, 3)) {
      await page.getByRole('checkbox', { name: `Select ${name}` }).check();
    }
    const purge = page.getByRole('button', { name: 'Delete selected records permanently' });
    // T421b (board "Thùng rác"): outlined on the dark bar, not a filled red button.
    expect(
      await purge.evaluate((button) => {
        const style = getComputedStyle(button);
        return [style.backgroundColor, style.borderTopStyle, style.borderTopColor];
      }),
    ).toEqual(['rgba(0, 0, 0, 0)', 'solid', 'rgb(249, 112, 102)']);
    await purge.click();
    const dialog = page.getByRole('dialog', { name: 'Delete 3 records permanently?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/This cannot be undone/u)).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'purge dialog');
    await dialog.getByRole('button', { name: 'Delete 3 records permanently' }).click();
    await expect(page.getByText('3 records deleted permanently.')).toBeVisible();
    await expect(dialog).toBeHidden();
    const table = page.getByRole('table', { name: `Deleted records of ${TABLE_NAME}` });
    for (const name of RECORD_NAMES.slice(0, 3)) await expect(table.getByText(name)).toBeHidden();
    await expect(table.getByText(RECORD_NAMES[3] ?? '')).toBeVisible();
  });

  await test.step('the other tab drops them in real time', async () => {
    const table = other.getByRole('table', { name: `Deleted records of ${TABLE_NAME}` });
    for (const name of RECORD_NAMES.slice(0, 3)) await expect(table.getByText(name)).toBeHidden();
    await expect(table.getByText(RECORD_NAMES[3] ?? '')).toBeVisible();
  });

  await test.step('gone for good: the record and its restore answer 404', async () => {
    const [first] = ids.recordIds;
    const got = await api(page, 'GET', `/tables/${ids.tableId}/records/${first ?? ''}`);
    expect(got.status).toBe(404);
    const restore = await api(page, 'POST', `/tables/${ids.tableId}/records/restore`, {
      ids: [first],
    });
    expect(restore.status).toBe(404);
  });

  expect(cspViolations).toEqual([]);
});
