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
 * T322b: tooltips on keyboard focus, the share dialog as a bottom sheet on
 * phones, the "Hide fields" panel (switches, search, drag to reorder).
 * Self-contained: the first administrator and a table of its own.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());

const ids = { baseId: '', tableId: '', viewId: '', fields: {} as Record<string, string> };
const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;

async function openAs(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, ADMIN.email, ADMIN.password);
  return page;
}

async function gridReady(page: Page) {
  await page.goto(viewPath());
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
}

test.describe('T322b UI polish', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `T322b ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Giao diện T322b',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Phiếu T322b',
    });
    ids.tableId = table.id;
    for (const body of [
      { name: 'Trạng thái', type: 'text' },
      { name: 'Số tiền', type: 'number' },
      { name: 'Hạn', type: 'datetime' },
    ]) {
      const field = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, body);
      ids.fields[body.name] = field.id;
    }
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: [{ fields: { Name: 'Máy in kẹt giấy', 'Số tiền': 100 } }],
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    await page.close();
  });

  test('icon buttons show their tooltip on keyboard focus, not a native title', async ({
    browser,
  }) => {
    const page = await openAs(browser, { width: 1600, height: 900 });
    const csp = collectCspViolations(page);
    await gridReady(page);
    const more = page.getByTestId('grid-toolbar-more');
    await expect(more).not.toHaveAttribute('title');
    // Tab through the toolbar until the "≡" button has the keyboard focus.
    await page.getByRole('button', { name: 'Filter' }).focus();
    for (let step = 0; step < 12; step += 1) {
      if (await more.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(more).toBeFocused();
    const tooltip = page.locator('[data-radix-popper-content-wrapper]').filter({
      hasText: 'More actions',
    });
    await expect(tooltip).toBeVisible();
    // Not announced twice: the button keeps its name, no description.
    await expect(more).toHaveAccessibleName('More actions');
    await expect(more).not.toHaveAttribute('aria-describedby');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    expect(csp).toEqual([]);
    await page.context().close();
  });

  test('hide fields: type icons, search, switches, drag to reorder the view columns', async ({
    browser,
  }) => {
    const page = await openAs(browser, { width: 1600, height: 900 });
    await gridReady(page);
    await page.getByTestId('hidden-fields-button').click();
    const panel = page.getByRole('dialog', { name: 'Shown fields' });
    await expect(panel.getByRole('switch', { name: 'Show Name' })).toBeDisabled();
    const names = () =>
      panel
        .getByTestId('hidden-fields-row')
        .evaluateAll((rows) =>
          rows.map((row) => row.querySelector('.truncate')?.textContent ?? ''),
        );
    expect(await names()).toEqual(['Name', 'Trạng thái', 'Số tiền', 'Hạn']);
    await expectNoSeriousA11yViolations(page, 'hide fields panel (T322b)');

    // Search is accent-insensitive; no dragging while filtered.
    const search = panel.getByRole('searchbox', { name: 'Find a field' });
    await search.fill('so tien');
    expect(await names()).toEqual(['Số tiền']);
    await search.fill('');

    // Hide one: applies at once.
    await panel.getByRole('switch', { name: 'Show Hạn' }).click();
    await expect(page.getByRole('button', { name: '1 hidden field' })).toBeVisible();

    // Reorder with the keyboard: "Hạn" goes above "Trạng thái".
    const handle = panel.getByRole('button', { name: 'Reorder Hạn' });
    await handle.focus();
    // dnd-kit's keyboard sensor: Space picks up, arrows move, Space drops. Each
    // step waits for the sensor to measure the rows (as a person would pause).
    for (const key of ['Space', 'ArrowUp', 'ArrowUp', 'Space']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
    }
    await expect.poll(names).toEqual(['Name', 'Hạn', 'Trạng thái', 'Số tiền']);

    // Reorder with the mouse: "Số tiền" onto "Hạn".
    const from = await panel.getByRole('button', { name: 'Reorder Số tiền' }).boundingBox();
    const to = await panel.getByRole('button', { name: 'Reorder Hạn' }).boundingBox();
    if (from === null || to === null) throw new Error('rows not laid out');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y - 6, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(names).toEqual(['Name', 'Số tiền', 'Hạn', 'Trạng thái']);

    // Written to the view's field order (the admin may save: saved, not a draft).
    await expect
      .poll(async () => {
        const view = await ok<{ config: { field_order: string[] } }>(
          page,
          'GET',
          `/views/${ids.viewId}`,
        );
        return view.config.field_order;
      })
      .toEqual([ids.fields['Số tiền'], ids.fields['Hạn'], ids.fields['Trạng thái']]);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('hidden-fields-button')).toBeFocused();
    await page.context().close();
  });

  test('share dialog: check boxes before a link exists; a bottom sheet with its footer in view on a phone', async ({
    browser,
  }) => {
    const page = await openAs(browser, { width: 390, height: 844 });
    await page.goto(viewPath());
    await page.getByRole('button', { name: /^Share view/u }).click();
    const dialog = page.getByRole('dialog', { name: /^Share “/u });
    await expect(dialog.getByTestId('share-dialog')).toBeVisible();
    const options = dialog.getByTestId('share-options');
    await expect(options.getByRole('checkbox', { name: 'Search' })).toBeChecked();
    await expect(options.getByRole('switch')).toHaveCount(0);

    // Bottom sheet: full width, flush with the bottom edge.
    // Measured once the sheet has risen (its entrance slides it up a few pixels).
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return [box?.width, Math.round((box?.y ?? 0) + (box?.height ?? 0))];
      })
      .toEqual([390, 844]);
    // "Create link" stays in view while the options scroll.
    const create = dialog.getByRole('button', { name: 'Create link' });
    await expect(create).toBeInViewport();
    // Its label is drawn (the view bar's icon-only rule on phones does not reach it).
    expect((await create.boundingBox())?.width ?? 0).toBeGreaterThan(64);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await dialog.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(create).toBeInViewport();
    await dialog.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(create).toBeInViewport();
    await expectNoSeriousA11yViolations(page, 'share bottom sheet (T322b)');
    await page.context().close();
  });
});
