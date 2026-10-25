import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  animationsSettled,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  api,
  ok,
} from './support';

/**
 * T320b: the app shell, view bar, toolbar, empty state, footer and record
 * panel aligned with the design board "Grid - Tickets" (and Lark), plus the
 * S3 QA findings — view bar overflow, drag without switching, phones at
 * 390 px without horizontal scroll. Runs on the demo base (CONTRACTS §9).
 */

interface Ids {
  baseId: string;
  tableId: string;
  viewId: string;
  kanbanViewId: string | undefined;
  recordId: string;
}

let ids: Ids;
let cookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> = [];

/** A page of the signed-in demo admin (English on this device). */
async function openAdmin(browser: Browser, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await context.addCookies(cookies);
  return context.newPage();
}

const viewPath = (viewId = ids.viewId) => `/b/${ids.baseId}/t/${ids.tableId}/v/${viewId}`;

async function gridReady(page: Page) {
  await expect(page.locator('.ob-grid')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /records?/u })).toHaveText(
    /^[\d,]+ records$/u,
  );
}

test.describe('T320b shell, toolbar, view bar, panel', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    cookies = await context.cookies();
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    let baseId: string | undefined;
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
        baseId ??= bases.items.find((base) => base.name === 'Chăm sóc khách hàng')?.id;
      }
    }
    if (baseId === undefined) throw new Error('demo base not found');
    const tables = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/bases/${baseId}/tables`,
    );
    const tableId = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
    const views = await ok<{ items: { id: string; type: string; is_personal: boolean }[] }>(
      page,
      'GET',
      `/tables/${tableId}/views`,
    );
    const grid = views.items.find((view) => view.type === 'grid' && !view.is_personal);
    const records = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${tableId}/records/query`,
      { limit: 1 },
    );
    ids = {
      baseId,
      tableId,
      viewId: grid?.id ?? '',
      kanbanViewId: views.items.find((view) => view.type === 'kanban')?.id,
      recordId: records.records[0]?.id ?? '',
    };
    await context.close();
  });

  test('two bands under the top bar: the grid starts at 136 px, tables in the sidebar', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    const cspViolations = collectCspViolations(page);
    await page.goto(viewPath());
    await gridReady(page);
    // Top bar 52 + view tabs 40 + toolbar 44 (design "Grid - Tickets" at 1440×900).
    const grid = await page.locator('.ob-grid').boundingBox();
    expect(grid?.y).toBe(136);
    await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();
    // The tables moved from tabs into the sidebar, with their record counts.
    const tables = page.getByRole('complementary').getByRole('navigation', { name: 'Tables' });
    await expect(tables.getByRole('link', { name: 'Tickets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(tables.getByTestId(`table-count-${ids.tableId}`)).toHaveText(/^[\d,]+$/u);
    await expect(page.getByRole('main').getByRole('navigation', { name: 'Tables' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'grid page (T320b)');
    expect(cspViolations).toEqual([]);
    await page.context().close();
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    test(`the toolbar stays on one row at ${String(viewport.width)} px`, async ({ browser }) => {
      const page = await openAdmin(browser, viewport);
      await page.goto(viewPath());
      await gridReady(page);
      const toolbar = page.getByRole('toolbar', { name: 'View options' });
      const box = await toolbar.boundingBox();
      expect(box?.height).toBeLessThanOrEqual(45);
      // Buttons are 32 px, 13 px text (FRONTEND §9.3); "+ Record" is last, in the accent color.
      const filter = toolbar.getByTestId('filter-button');
      expect((await filter.boundingBox())?.height).toBe(32);
      expect(await filter.evaluate((node) => getComputedStyle(node).fontSize)).toBe('13px');
      const add = toolbar.getByRole('button', { name: 'Add record' });
      await expect(add).toBeVisible();
      const addBox = await add.boundingBox();
      const searchBox = await toolbar.getByRole('searchbox').boundingBox();
      expect((addBox?.x ?? 0) > (searchBox?.x ?? 0)).toBe(true);
      expect(Math.abs((addBox?.y ?? 0) - (searchBox?.y ?? 0))).toBeLessThanOrEqual(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await page.context().close();
    });
  }

  test('active filter and sort say what applies; the footer counts matches and selection', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath());
    await gridReady(page);
    const total = await page
      .getByRole('status')
      .filter({ hasText: /records/u })
      .textContent();
    const count = (total ?? '').replace(/ records$/u, '');
    // A search narrows to nothing: the design's empty box, then "Clear filter".
    await page.getByRole('searchbox', { name: 'Search records' }).fill('zzzz-no-such-ticket');
    const empty = page.getByTestId('grid-empty');
    await expect(empty.getByRole('heading', { name: 'No records match the search' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toHaveText(
      '0 records',
    );
    await expect(page.getByTestId('footer-of')).toHaveText(`of ${count} · match the search`);
    await expectNoSeriousA11yViolations(page, 'empty search (T320b)');
    await empty.getByRole('button', { name: 'Clear filter' }).click();
    await expect(empty).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Search records' })).toHaveValue('');
    await expect(page.getByRole('status').filter({ hasText: /records/u })).toHaveText(
      `${count} records`,
    );
    // Sort from the toolbar: the button names the field.
    await page.getByTestId('sort-button').click();
    await page
      .getByRole('dialog', { name: 'Sort' })
      .getByRole('combobox', { name: 'Add a sort field' })
      .selectOption({ label: 'Hạn' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Sort: Hạn/u })).toBeVisible();
    // The temporary change is a pill next to the tabs; discard it.
    const pill = page.getByRole('group', { name: 'Unsaved changes' });
    await expect(pill).toBeVisible();
    const tabs = await page.getByRole('navigation', { name: /^Views of/u }).boundingBox();
    const pillBox = await pill.boundingBox();
    expect(
      Math.abs((pillBox?.y ?? 0) + (pillBox?.height ?? 0) / 2 - ((tabs?.y ?? 0) + 20)),
    ).toBeLessThanOrEqual(4);
    await pill.getByRole('button', { name: 'Discard' }).click();
    await expect(pill).toHaveCount(0);
    // A selected cell: its row is counted in the footer.
    const grid = await page.locator('.ob-grid').boundingBox();
    await page.mouse.click((grid?.x ?? 0) + 400, (grid?.y ?? 0) + 60);
    await expect(page.getByTestId('footer-selected')).toHaveText('1 row selected');
    await page.context().close();
  });

  test('view bar: many views overflow into a menu; dragging a tab does not open it', async ({
    browser,
  }) => {
    const page = await openAdmin(browser, { width: 1280, height: 800 });
    await page.goto(viewPath());
    await gridReady(page);
    const created: string[] = [];
    try {
      for (let index = 0; index < 7; index += 1) {
        const view = await ok<{ id: string }>(page, 'POST', `/tables/${ids.tableId}/views`, {
          name: `T320b tab with a rather long name ${String(index)}`,
          type: 'grid',
          is_personal: false,
        });
        created.push(view.id);
      }
      await page.reload();
      await gridReady(page);
      const bar = page.getByRole('navigation', { name: /^Views of/u });
      const more = bar.getByTestId('view-overflow');
      await expect(more).toBeVisible();
      await expect(bar.getByRole('button', { name: 'New view' })).toBeVisible();
      await expect(bar.locator(`[data-testid="view-tab-${ids.viewId}"] a`)).toHaveAttribute(
        'aria-current',
        'page',
      );
      // Open a view from the menu: its tab takes a visible slot.
      await more.click();
      const last = created.at(-1) ?? '';
      await page.getByRole('menuitem', { name: 'T320b tab with a rather long name 6' }).click();
      await expect(page).toHaveURL(new RegExp(`/v/${last}$`, 'u'));
      const activeTab = bar.locator(`[data-testid="view-tab-${last}"] a`);
      await expect(activeTab).toBeVisible();
      await expect(activeTab).toHaveAttribute('title', 'T320b tab with a rather long name 6');
      await expectNoSeriousA11yViolations(page, 'view bar overflow (T320b)');

      // Drag the first tab onto another one: reordered, but the open view stays.
      const tabs = bar.locator('ul[aria-label="Shared views"] > li');
      const source = await tabs.nth(0).boundingBox();
      const target = await tabs.nth(1).boundingBox();
      if (source === null || target === null) throw new Error('no tabs');
      await page.mouse.move(source.x + 20, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 30, source.y + source.height / 2, { steps: 3 });
      await page.mouse.move(target.x + target.width - 10, target.y + target.height / 2, {
        steps: 12,
      });
      await page.mouse.up();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(new RegExp(`/v/${last}$`, 'u'));
      await expect(activeTab).toHaveAttribute('aria-current', 'page');

      // Deleting the open view gives the focus to the tab of the view that opens.
      await bar
        .getByRole('button', { name: 'Options of view T320b tab with a rather long name 6' })
        .click();
      await page.getByRole('menuitem', { name: 'Delete view' }).click();
      await page
        .getByRole('dialog', { name: /^Delete view/u })
        .getByRole('button', { name: 'Delete view' })
        .click();
      created.pop();
      await expect(page).not.toHaveURL(new RegExp(`/v/${last}$`, 'u'));
      await expect(bar.locator('a[aria-current="page"]')).toBeFocused();
    } finally {
      for (const viewId of created) await api(page, 'DELETE', `/views/${viewId}`);
      await page.context().close();
    }
  });

  test('record panel: full height over a dim backdrop, closes from the backdrop', async ({
    browser,
  }) => {
    // Below 1280 px (T322a: from 1280 px the panel sits beside the grid without a backdrop).
    const page = await openAdmin(browser, { width: 1200, height: 800 });
    await page.goto(`${viewPath()}?record=${ids.recordId}`);
    const panel = page.getByTestId('record-panel');
    await expect(panel).toBeVisible();
    expect((await panel.boundingBox())?.y).toBe(0);
    await expect(panel.getByRole('button', { name: /copy link/iu })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'record panel (T320b)');
    // The backdrop covers the sidebar too: a click there closes the panel.
    await page.mouse.click(60, 450);
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/record=/u);
    await page.context().close();
  });

  test('phones (390×844): one-row toolbar, bottom-sheet filter, no page-wide horizontal scroll', async ({
    browser,
  }) => {
    const page = await openAdmin(browser, { width: 390, height: 844 });
    const noHorizontalScroll = async (label: string) => {
      const [scroll, width, wide] = await page.evaluate(() => {
        // What sticks out, to say where the scroll comes from.
        const outside = [...document.querySelectorAll('body *')]
          .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
          .filter(
            (element) =>
              element.parentElement?.closest('.overflow-x-auto') == null ||
              ['fixed', 'absolute'].includes(getComputedStyle(element).position),
          )
          .slice(0, 8)
          .map(
            (element) =>
              `${element.tagName.toLowerCase()}.${(element.getAttribute('class') ?? '').slice(0, 50)} (${String(Math.round(element.getBoundingClientRect().width))})`,
          );
        return [
          document.documentElement.scrollWidth,
          window.innerWidth,
          outside.join(' | '),
        ] as const;
      });
      expect(scroll, `horizontal scroll on ${label}: ${wide}`).toBeLessThanOrEqual(width);
    };
    await page.goto(viewPath());
    await expect(page.getByRole('list', { name: /^Records of/u })).toBeVisible();
    await noHorizontalScroll('grid (cards)');
    // The open view's name is readable in the switcher.
    const switcher = page.getByTestId('view-switcher');
    await expect(switcher).toBeVisible();
    expect((await switcher.boundingBox())?.width).toBeGreaterThan(80);
    const toolbar = page.getByRole('toolbar', { name: 'View options' });
    expect((await toolbar.boundingBox())?.height).toBeLessThanOrEqual(46);
    await toolbar.getByTestId('filter-button').click();
    const sheet = page.getByRole('dialog', { name: 'Filter' });
    await expect(sheet).toBeVisible();
    // Measured once it has risen into place (T322b sheet motion).
    await animationsSettled(page);
    const box = await sheet.boundingBox();
    expect(box?.x).toBe(0);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
    expect(box?.width).toBe(390);
    await noHorizontalScroll('filter sheet');
    await expectNoSeriousA11yViolations(page, 'phone filter sheet (T320b)');
    await page.keyboard.press('Escape');
    await page.goto(`${viewPath()}?record=${ids.recordId}`);
    await expect(page.getByTestId('record-panel')).toBeVisible();
    await noHorizontalScroll('record panel');
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/trash`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noHorizontalScroll('trash');
    if (ids.kanbanViewId !== undefined) {
      await page.goto(viewPath(ids.kanbanViewId));
      await expect(page.getByRole('toolbar').first()).toBeVisible();
      await page.waitForTimeout(500);
      await noHorizontalScroll('kanban');
    }
    await page.context().close();
  });
});
