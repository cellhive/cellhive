import { type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T816: color rules of a grid view (FRONTEND §6.9, CONTRACTS §15), in a
 * workspace and base of their own: Orders (title, Status: Late / On time)
 * with "A" Late and "B" On time.
 *
 * - u_admin builds "Status is Late → red row" in the color rules panel with
 *   the keyboard; the rule is saved with the view and row A turns red on
 *   the canvas (the server's `meta.color`), row B does not;
 * - B set to Late by another request turns red without a reload
 *   (`record.updated` carries the colors);
 * - axe on the panel.
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');

/** Canvas rows (CSS px): header 36, compact rows 34. */
const ROW_Y = [36 + 17, 36 + 34 + 17] as const;

const fx = { baseId: '', tableId: '', viewId: '', statusId: '', recordB: '' };

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs[0]?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
    name: `T816 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Color rules T816 ${RUN}`,
  });
  fx.baseId = base.id;
  const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
    name: 'Orders',
    primary_field_name: 'title',
  });
  fx.tableId = table.id;
  fx.statusId = (
    await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
      name: 'Status',
      type: 'select',
      options: { options: [{ name: 'Late' }, { name: 'On time' }] },
    })
  ).id;
  const created = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${table.id}/records?field_key_type=name`,
    {
      records: [
        { fields: { title: 'A', Status: 'Late' } },
        { fields: { title: 'B', Status: 'On time' } },
      ],
    },
  );
  fx.recordB = created.records[1]?.id ?? '';
  const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
  fx.viewId = views.items[0]?.id ?? '';
}

/** `#rrggbb` of a CSS custom property of `<html>`, as `[r, g, b]`. */
async function tokenRgb(page: Page, name: string): Promise<number[]> {
  const hex = await page.evaluate(
    (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
    name,
  );
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

/** Whether most of the canvas row at `y` (CSS px) is painted `rgb` (text pixels aside). */
async function rowPainted(page: Page, y: number, rgb: readonly number[]): Promise<boolean> {
  return page.evaluate(
    ([py, color]) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.ob-grid [data-testid="data-grid-canvas"]',
      );
      const context = canvas?.getContext('2d') ?? null;
      if (canvas === null || context === null) return false;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      let hits = 0;
      let samples = 0;
      for (let x = 120; x < 600; x += 8) {
        const [r = 0, g = 0, b = 0] = context.getImageData(x * ratio, py * ratio, 1, 1).data;
        samples += 1;
        if (
          Math.abs(r - (color[0] ?? 0)) <= 2 &&
          Math.abs(g - (color[1] ?? 0)) <= 2 &&
          Math.abs(b - (color[2] ?? 0)) <= 2
        ) {
          hits += 1;
        }
      }
      return hits > samples / 2;
    },
    [y, rgb] as const,
  );
}

test.describe('T816 color rules', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    await apiSignIn(page, ADMIN_EMAIL, DEMO_PASSWORD);
    await buildFixture(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    await apiSignIn(page, ADMIN_EMAIL, DEMO_PASSWORD);
    await api(page, 'DELETE', `/bases/${fx.baseId}`);
    await page.close();
  });

  test('builds "Status is Late → red row" and the rows are colored, live', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    await page.goto('/login');
    await apiSignIn(page, ADMIN_EMAIL, DEMO_PASSWORD);
    await page.goto(`/b/${fx.baseId}/t/${fx.tableId}`);
    await expect(page.locator('.ob-grid [data-testid="data-grid-canvas"]')).toBeVisible();

    const button = page.getByTestId('color-rules-button');
    await button.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Color rules' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('No color rule yet.')).toBeVisible();

    await panel.getByTestId('color-rule-add').focus();
    await page.keyboard.press('Enter');
    const rule = panel.getByTestId('color-rule');
    await expect(rule).toHaveCount(1);
    // The first new rule takes the first palette color.
    await expect(
      rule.getByRole('radiogroup', { name: 'Color of rule 1' }).getByRole('radio', { name: 'Red' }),
    ).toBeChecked();
    await expect(panel.getByText(/is not saved yet/u)).toBeVisible();

    await rule.getByRole('button', { name: 'Add condition', exact: true }).focus();
    await page.keyboard.press('Enter');
    const condition = rule.getByTestId('filter-condition');
    await condition.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'Status' });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().endsWith(`/views/${fx.viewId}`) &&
        response.ok(),
    );
    const value = condition.getByRole('combobox', { name: 'Value for Status' });
    await value.focus();
    await value.selectOption({ label: 'Late' });
    await saved;
    await expect(panel.getByText(/is not saved yet/u)).toHaveCount(0);
    await expect(button).toHaveAccessibleName('Color: 1 rule');
    await expectNoSeriousA11yViolations(page, 'color rules panel');

    const view = await ok<{ config: { color_rules?: { filter: unknown; target: string }[] } }>(
      page,
      'GET',
      `/views/${fx.viewId}`,
    );
    expect(view.config.color_rules).toEqual([
      expect.objectContaining({ color: 'red', target: 'row', enabled: true }),
    ]);

    // The save's answer does not rebuild the builders: the focus stays on the value.
    await expect(value).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    const red = await tokenRgb(page, '--rule-red-bg');
    await expect.poll(() => rowPainted(page, ROW_Y[0], red)).toBe(true);
    expect(await rowPainted(page, ROW_Y[1], red)).toBe(false);

    // Another change makes B late: its row turns red without a reload.
    await ok(page, 'PATCH', `/tables/${fx.tableId}/records?field_key_type=id`, {
      records: [{ id: fx.recordB, fields: { [fx.statusId]: 'Late' } }],
    });
    await expect.poll(() => rowPainted(page, ROW_Y[1], red)).toBe(true);
  });
});
