import { type Browser, type Locator, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T322a (UI audit): view tabs never overlap, touch targets and 16 px fields
 * on phones, the record panel (side panel from 1280 px, phone layout, "⋯"
 * menu), the cell editor under the panel and typing after Escape, share
 * links as cards on phones, the "+" column, row-only delete, the app shell
 * skeleton on a hard load, the breadcrumb. Runs on the demo base (CONTRACTS §9).
 */

interface Ids {
  baseId: string;
  tableId: string;
  viewId: string;
  /** A grid view of this spec (default layout: other specs change the demo views). */
  ownViewId: string;
  recordId: string;
}

let ids: Ids;
let cookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> = [];

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

/** Canvas point of a cell of the first rows: `x` from the grid's left edge, `row` from 0. */
async function cellPoint(page: Page, x: number, row: number) {
  const box = await page.locator('.ob-grid canvas').first().boundingBox();
  if (box === null) throw new Error('no grid canvas');
  // Header 36 px, compact rows 34 px.
  return { x: box.x + x, y: box.y + 36 + 17 + 34 * row };
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const eps = 0.5;
  return (
    a.x + a.width - eps > b.x &&
    b.x + b.width - eps > a.x &&
    a.y + a.height - eps > b.y &&
    b.y + b.height - eps > a.y
  );
}

/** Every visible button and link of `scope` is at least 44 × 44 px. */
async function expectTouchTargets(scope: Locator, label: string) {
  const small = await scope.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('button, a[href]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.getAttribute('aria-label') ?? element.textContent.trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44),
  );
  expect(small, `targets under 44 px in ${label}`).toEqual([]);
}

test.describe('T322a UI audit fixes', () => {
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
    const own = await ok<{ id: string }>(page, 'POST', `/tables/${tableId}/views`, {
      name: `T322a grid ${String(Date.now())}`,
      type: 'grid',
      is_personal: false,
      config: { row_height: 'short' },
    });
    ids = {
      baseId,
      tableId,
      viewId: grid?.id ?? '',
      ownViewId: own.id,
      recordId: records.records[0]?.id ?? '',
    };
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await openAdmin(browser);
    await page.goto('/login');
    await api(page, 'DELETE', `/views/${ids.ownViewId}`);
    await page.context().close();
  });

  test('view tabs never overlap and keep about 12 characters (1440, 1280, 1024)', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath());
    await gridReady(page);
    const created: string[] = [];
    try {
      for (let index = 0; index < 6; index += 1) {
        const view = await ok<{ id: string }>(page, 'POST', `/tables/${ids.tableId}/views`, {
          name: `T322a tickets by region, a long view name ${String(index)}`,
          type: 'grid',
          is_personal: false,
        });
        created.push(view.id);
      }
      for (const width of [1440, 1280, 1024]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(viewPath());
        await gridReady(page);
        const bar = page.getByRole('navigation', { name: /^Views of/u });
        await expect(bar.getByRole('button', { name: 'New view' })).toBeVisible();
        const boxes = await bar.evaluate((nav) =>
          [
            ...nav.querySelectorAll<HTMLElement>(
              'li[data-testid^="view-tab-"], [data-testid="view-overflow"]',
            ),
            ...[...nav.querySelectorAll<HTMLElement>('button')].filter(
              (button) => button.textContent.trim() === 'New view',
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            const link = element.querySelector('a');
            const name = link?.querySelector('span');
            return {
              id: element.dataset['testid'] ?? element.textContent.trim(),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              // A truncated name shows at least ~12 characters (TAB_MIN_WIDTH).
              truncatedTooShort:
                name !== null &&
                name !== undefined &&
                name.scrollWidth > name.clientWidth &&
                name.clientWidth < 80,
            };
          }),
        );
        expect(boxes.length, `tabs at ${String(width)}`).toBeGreaterThan(2);
        for (const [index, box] of boxes.entries()) {
          expect(box.truncatedTooShort, `${box.id} at ${String(width)}`).toBe(false);
          for (const other of boxes.slice(index + 1)) {
            expect(intersects(box, other), `${box.id} / ${other.id} at ${String(width)}`).toBe(
              false,
            );
          }
        }
        if (width === 1280) {
          await page.screenshot({ path: test.info().outputPath('tabs-1280.png') });
        }
      }
    } finally {
      for (const viewId of created) await api(page, 'DELETE', `/views/${viewId}`);
      await page.context().close();
    }
  });

  test('phones (390): 44 px targets, 16 px fields, record panel layout', async ({ browser }) => {
    const page = await openAdmin(browser, { width: 390, height: 844 });
    await page.goto(viewPath());
    await expect(page.getByRole('list', { name: /^Records of/u })).toBeVisible();
    await expectTouchTargets(page.getByRole('banner'), 'top bar');
    await expectTouchTargets(
      page.getByRole('navigation', { name: /^Views of/u }).locator('..'),
      'view bar',
    );
    await expectTouchTargets(page.getByRole('toolbar', { name: 'View options' }), 'toolbar');
    // iOS zooms into fields under 16 px.
    const search = page.getByRole('searchbox').or(page.getByRole('textbox')).first();
    expect(await search.evaluate((input) => getComputedStyle(input).fontSize)).toBe('16px');

    await page.goto(`${viewPath()}?record=${ids.recordId}`);
    const panel = page.getByTestId('record-panel');
    await expect(panel).toBeVisible();
    await expectTouchTargets(panel.locator('header'), 'record panel header');
    for (const tab of await panel.getByRole('tab').all()) {
      expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    // No table name or date next to the code on phones; the title stays readable.
    expect(await panel.getByTestId('record-panel-meta').innerText()).not.toContain('Tickets');
    const title = panel.getByRole('heading', { level: 2 });
    expect(await title.evaluate((heading) => getComputedStyle(heading).fontSize)).toBe('15px');
    // The field name sits right above its value; the next field is further away.
    const [first, second] = await panel.getByTestId('record-field').all();
    if (first === undefined || second === undefined) throw new Error('no fields');
    const gaps = await first.evaluate((row) => {
      const [label, value] = [...row.children] as HTMLElement[];
      const next = row.nextElementSibling as HTMLElement | null;
      if (label === undefined || value === undefined || next === null) return null;
      return {
        labelToValue: value.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
        valueToNext: next.getBoundingClientRect().top - row.getBoundingClientRect().bottom,
      };
    });
    expect(gaps).not.toBeNull();
    expect(gaps?.labelToValue ?? 99).toBeLessThanOrEqual(4);
    expect(gaps?.valueToNext ?? 0).toBeGreaterThan(gaps?.labelToValue ?? 99);
    // The history button is drawn small but takes a 44 px touch area.
    const history = first.getByTestId('field-history');
    const box = await history.boundingBox();
    if (box === null) throw new Error('no history button');
    expect(box.width).toBeLessThan(44);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="field-history"]'),
      { x: box.x - 6, y: box.y + box.height / 2 },
    );
    expect(hit).not.toBeNull();
    await expectNoSeriousA11yViolations(page, 'record panel (phone, T322a)');
    await page.screenshot({ path: test.info().outputPath('record-390.png') });
    await page.context().close();
  });

  test('share links on phones: one card per link, 16 px filters', async ({ browser }) => {
    const page = await openAdmin(browser, { width: 390, height: 844 });
    await page.goto(`/b/${ids.baseId}/settings/share-links`);
    const list = page.getByRole('list', { name: 'Share links' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(list.getByRole('listitem').first()).toBeVisible();
    const select = page.getByRole('combobox').first();
    expect(await select.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    const checkbox = list.getByRole('checkbox').first();
    await checkbox.locator('..').click();
    await expect(checkbox).toBeChecked();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(390);
    await expectNoSeriousA11yViolations(page, 'share links cards (T322a)');
    await page.screenshot({ path: test.info().outputPath('share-links-390.png'), fullPage: true });
    // Wider: the table.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('table', { name: 'Share links' })).toBeVisible();
    await page.context().close();
  });

  test('record panel from 1280 px: half the window beside the grid, "⋯" deletes to the trash', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records?field_key_type=name`,
      { records: [{ fields: { 'Tiêu đề': 'T322a record to delete' } }] },
    );
    const recordId = created.records[0]?.id ?? '';
    await page.goto(`${viewPath()}?record=${recordId}`);
    const panel = page.getByTestId('record-panel');
    await expect(panel.getByRole('heading', { name: 'T322a record to delete' })).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.width).toBe(720);
    await expect(page.getByTestId('record-panel-backdrop')).toBeHidden();
    await expect(page.locator('.ob-grid')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Location' })).toContainText(
      'Chăm sóc khách hàng',
    );
    await panel.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Delete record' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this record?' });
    await expect(dialog).toContainText('T322a record to delete');
    await expectNoSeriousA11yViolations(page, 'delete record from the panel (T322a)');
    await dialog.getByRole('button', { name: 'Delete record' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page).not.toHaveURL(/record=/u);
    const gone = await api(page, 'GET', `/tables/${ids.tableId}/records/${recordId}`);
    expect(gone.status).toBe(404);
    await page.context().close();
  });

  test('cell editor: closed under the panel; typing works after Escape on another editor', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.ownViewId));
    await gridReady(page);
    // QA: double-click a status cell, Escape, double-click the title, type.
    const status = await cellPoint(page, 330, 3);
    const title = await cellPoint(page, 120, 3);
    await page.mouse.dblclick(status.x, status.y);
    await expect(page.locator('#portal')).not.toBeEmpty();
    await page.keyboard.press('Escape');
    await expect(page.locator('#portal')).toBeEmpty();
    await page.mouse.dblclick(title.x, title.y);
    // T803: the keys typed while the editor opens (and after the grid takes the
    // focus back a frame late) go to the editor, without waiting for it.
    await page.keyboard.type('xyz');
    const editor = page.locator('#portal textarea, #portal input').first();
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/xyz$/u);
    // The panel opens (back/forward, a link) while the editor is open: the editor closes.
    await page.evaluate((search) => {
      window.history.pushState({}, '', `${window.location.pathname}${search}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `?record=${ids.recordId}`);
    await expect(page.getByTestId('record-panel')).toBeVisible();
    await expect(page.locator('#portal')).toBeEmpty();
    // Editors stay under the panel anyway.
    const [portalZ, panelZ] = await page.evaluate(() => [
      Number(getComputedStyle(document.getElementById('portal') as Element).zIndex),
      Number(
        getComputedStyle(document.querySelector('[data-testid="record-panel"]') as Element).zIndex,
      ),
    ]);
    expect(portalZ).toBeLessThan(panelZ);
    await page.context().close();
  });

  test('grid: "+" column adds a field; "Delete" only for whole rows, apart from "+ Record"', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.ownViewId));
    await gridReady(page);
    // A cell only: no "Delete"; the whole row (Shift+Space): "Delete 1 record".
    const cell = await cellPoint(page, 120, 0);
    await page.mouse.click(cell.x, cell.y);
    await expect(page.getByText('1 row selected')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Delete \d+ record/u })).toHaveCount(0);
    await page.keyboard.press('Shift+Space');
    const remove = page.getByRole('button', { name: 'Delete 1 record' });
    await expect(remove).toBeVisible();
    const [removeBox, addBox, search] = await Promise.all([
      remove.boundingBox(),
      page.getByRole('button', { name: 'Add record' }).boundingBox(),
      page.getByRole('toolbar', { name: 'View options' }).getByRole('searchbox').boundingBox(),
    ]);
    // Left of the search box, far from the primary action.
    expect((removeBox?.x ?? 0) + (removeBox?.width ?? 0)).toBeLessThan(search?.x ?? 0);
    expect((addBox?.x ?? 0) - ((removeBox?.x ?? 0) + (removeBox?.width ?? 0))).toBeGreaterThan(200);

    // Scroll to the end of the columns: the "+" after the last header.
    await page.locator('.ob-grid .dvn-scroller').evaluate((scroller) => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
    const add = page.getByTestId('grid-add-field');
    await expect(add).toBeVisible();
    expect((await add.boundingBox())?.height).toBe(36);
    await add.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // "Add field" is still in the "⋯" menu.
    await page.getByTestId('grid-toolbar-more').click();
    const addItem = page.getByRole('menuitem', { name: 'Add field' });
    await expect(addItem).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(addItem).toHaveCount(0);
    await page.context().close();
  });

  test('hard load of a record link: the app shell skeleton, not a full-page spinner', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/me', async (route) => {
      await held;
      await route.continue();
    });
    const loaded = page.goto(`${viewPath()}?record=${ids.recordId}`);
    await expect(page.getByTestId('app-shell-skeleton')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('skeleton-1440.png') });
    release();
    await loaded;
    await expect(page.getByTestId('record-panel')).toBeVisible();
    await expect(page.getByTestId('app-shell-skeleton')).toHaveCount(0);
    // The base's name once in the sidebar (the breadcrumb says it too).
    const sidebar = page.getByRole('complementary');
    await expect(sidebar.getByText('Chăm sóc khách hàng', { exact: true })).toHaveCount(1);
    await page.context().close();
  });
});
