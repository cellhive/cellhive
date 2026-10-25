import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T465: the History tab of the record panel shows link changes (CONTRACTS
 * §11.1) on the demo base: records linked (+) and unlinked (−) as chips,
 * "Deleted record" for a customer deleted since, a lock chip for
 * u_sales1 who cannot read Customers (P20), the entry on the other side of
 * a two-way link, and "Restore previous value" of a link change that
 * reports the deleted customer as skipped.
 */

const SALES1 = WORKER_ORG.email('sales1');
const ADMIN_NAME = 'Nguyễn Minh Anh';
const RUN = String(Date.now()).slice(-6);
const names = {
  link: `Khách T465 ${RUN}`,
  reverse: `Đơn T465 ${RUN}`,
  kept: `Công ty Sông Hồng ${RUN}`,
  gone: `Cửa hàng Ban Mai ${RUN}`,
};
const ids = {
  baseId: '',
  orders: '',
  customers: '',
  link: '',
  reverse: '',
  kept: '',
  gone: '',
  order: '',
  orderTitle: '',
};

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1920, height: 1000 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

async function findDemo(page: Page) {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  for (const org of me.orgs) {
    const workspaces = await ok<{ items: { id: string }[] }>(
      page,
      'GET',
      `/orgs/${org.id}/workspaces`,
    );
    for (const workspace of workspaces.items) {
      const bases = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/workspaces/${workspace.id}/bases`,
      );
      const base = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { baseId: base.id, orders: id('Orders'), customers: id('Customers') };
    }
  }
  throw new Error('demo base not found');
}

/** Top-level items of the history timeline of the panel. */
function historyItems(page: Page) {
  return page.getByRole('dialog').getByRole('list', { name: 'Changes' }).locator(':scope > li');
}

test.describe.serial('T465 record history of links', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const sales = await openAs(browser, SALES1);
    const mine = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      sales.page,
      'POST',
      `/tables/${(await findDemo(sales.page)).orders}/records/query?field_key_type=name`,
      { offset: 0, limit: 1, include_total: false },
    );
    ids.order = mine.records[0]?.id ?? '';
    const title = mine.records[0]?.fields[DEMO_ORDER_TITLE];
    ids.orderTitle = typeof title === 'string' ? title : '';
    await sales.context.close();

    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const link = await ok<{ id: string; options: { symmetric_field_id: string } }>(
      page,
      'POST',
      `/tables/${ids.orders}/fields`,
      {
        name: names.link,
        type: 'link',
        options: {
          link_table: ids.customers,
          bidirectional: true,
          bidirectional_link_field_name: names.reverse,
        },
      },
    );
    ids.link = link.id;
    ids.reverse = link.options.symmetric_field_id;
    const customers = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      { records: [{ fields: { Tên: names.kept } }, { fields: { Tên: names.gone } }] },
    );
    ids.kept = customers.records[0]?.id ?? '';
    ids.gone = customers.records[1]?.id ?? '';
    // Linked to both, then the second one unlinked, then deleted.
    const path = `/tables/${ids.orders}/records/${ids.order}?field_key_type=id`;
    await ok(page, 'PATCH', path, { fields: { [ids.link]: [ids.kept, ids.gone] } });
    await ok(page, 'PATCH', path, { fields: { [ids.link]: [ids.kept] } });
    await ok(page, 'DELETE', `/tables/${ids.customers}/records`, { ids: [ids.gone] });
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    // The demo base goes back to its fields (the next specs count on them).
    await api(page, 'DELETE', `/fields/${ids.reverse}`);
    await api(page, 'DELETE', `/fields/${ids.link}`);
    await context.close();
  });

  test('link changes as chips, the deleted customer, the other side; revert skips it', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}?record=${ids.order}`);
    const items = historyItems(page);
    const unlinked = items.first();
    await expect(unlinked).toContainText(`${ADMIN_NAME} changed ${names.link}`);
    const chips = unlinked.getByTestId('history-links');
    await expect(chips).toContainText('unlinkedDeleted record');
    const linked = items.nth(1).getByTestId('history-links');
    await expect(linked).toContainText(`linked${names.kept}`);
    await expect(linked).toContainText('linkedDeleted record');
    await expectNoSeriousA11yViolations(page, 'history with link changes');
    await page.screenshot({ path: test.info().outputPath('link-history.png') });

    // Restoring the unlink would link the deleted customer again: skipped.
    await unlinked.getByRole('button', { name: 'Restore previous value' }).click();
    await page
      .getByRole('dialog', { name: 'Restore the previous value?' })
      .getByRole('button', { name: 'Restore' })
      .click();
    await expect(
      page.getByText(
        'Previous value restored. 1 linked record was deleted and was not linked again.',
      ),
    ).toBeVisible();

    // The other side of the two-way link has its own entry.
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}?record=${ids.kept}`);
    const side = historyItems(page).first();
    await expect(side).toContainText(`${ADMIN_NAME} changed ${names.reverse}`);
    await expect(side.getByTestId('history-links')).toContainText(`linked${ids.orderTitle}`);
    await context.close();
  });

  test('u_sales1 sees locked chips (P20), also on a phone', async ({ browser }) => {
    const { context, page } = await openAs(browser, SALES1, { width: 375, height: 812 });
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}?record=${ids.order}`);
    const panel = page.getByRole('dialog');
    await panel.getByRole('tab', { name: 'History' }).click();
    const chips = historyItems(page)
      .filter({ hasText: `changed ${names.link}` })
      .last()
      .getByTestId('history-links');
    await expect(chips).toContainText('linkedNo access');
    await expect(chips).not.toContainText(names.kept);
    await expect(chips).not.toContainText('Deleted record');
    await expectNoSeriousA11yViolations(page, 'history with locked link chips (mobile)');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
    await page.screenshot({ path: test.info().outputPath('link-history-sales1-mobile.png') });
    await context.close();
  });
});
