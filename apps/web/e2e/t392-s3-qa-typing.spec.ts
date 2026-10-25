import { type Browser, type Page, type Request } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn } from './support';

/**
 * S3 QA regression: type-to-edit right after the page loads (the overlay
 * editor code is still loading) must keep every character, in order —
 * spaces and Vietnamese letters included — and Space must not open the
 * record panel while the editor is on its way.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const STRESS_ROUNDS = 20;
/** Ends every typed text: a value the cell already holds would not be written again. */
const RUN = ` #${String(Date.now() % 100_000)}`;

async function signedIn(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

async function openOrders(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Orders' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await gridReady(page);
}

/** Rows loaded (the footer counts them); not the accessibility table, absent under the dev server. */
async function gridReady(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
}

/** Clicks the primary (first) cell of data row `row`. */
async function clickPrimary(page: Page, row: number): Promise<void> {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + 60 + 40,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
}

/** The value of the next record PATCH (a single cell write). */
function nextPatchValue(page: Page): Promise<unknown> {
  return page
    .waitForRequest(
      (request: Request) =>
        request.method() === 'PATCH' && /\/tables\/[^/]+\/records/u.test(request.url()),
      { timeout: 30_000 },
    )
    .then((request) => {
      const body = request.postDataJSON() as {
        fields?: Record<string, unknown>;
        records?: { fields: Record<string, unknown> }[];
      };
      return Object.values(body.records?.[0]?.fields ?? body.fields ?? {})[0];
    });
}

type Typist = (page: Page, text: string) => Promise<void>;

/** Raw CDP key events carrying the character, as a Vietnamese keyboard layout sends them. */
async function cdpKeys(page: Page, text: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  for (const character of text) {
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: character,
      text: character,
      unmodifiedText: character,
    });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
  }
  await session.detach();
}

const TYPISTS: Record<string, Typist> = {
  // Characters off the US layout ("ễ", "–") are sent without a keydown.
  'keyboard.type': (page, text) => page.keyboard.type(text),
  // A key starts editing, then IME-like input: insertions without a keydown.
  insertText: async (page, text) => {
    const [first = '', ...rest] = Array.from(text);
    await cdpKeys(page, first);
    for (const character of rest) await page.keyboard.insertText(character);
  },
  cdp: cdpKeys,
};

/**
 * Reloads the grid, clicks a cell at once and types; returns what was saved.
 * `enterAtOnce`: Enter right after the text, maybe before the editor is there.
 */
async function reloadAndType(
  page: Page,
  row: number,
  text: string,
  typist: Typist,
  enterAtOnce = false,
) {
  await page.reload();
  await gridReady(page);
  await clickPrimary(page, row);
  const saved = nextPatchValue(page);
  await typist(page, text);
  if (!enterAtOnce) {
    await expect(page.locator('#portal').getByRole('textbox')).toHaveValue(text);
    // Space went to the text, not to the record panel.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.keyboard.press('Enter');
  return saved;
}

test.describe('S3 QA: type to edit right after loading', () => {
  const cases: [string, string][] = [
    ['keyboard.type', 'Xin chao'],
    ['keyboard.type', 'QA S3 Tiếng Việt: Nguyễn Thị Ánh – đơn hàng ưu tiên'],
    ['cdp', 'Đơn hàng'],
    ['cdp', 'Xin chào các bạn'],
    ['insertText', 'Đơn hàng mới của chị Hằng'],
  ];
  for (const [typist, text] of cases) {
    test(`${typist} "${text}" is saved exactly`, async ({ browser }) => {
      const { context, page } = await signedIn(browser);
      try {
        await openOrders(page);
        const typer = TYPISTS[typist];
        if (typer === undefined) throw new Error(typist);
        expect(await reloadAndType(page, 1, text + RUN, typer)).toBe(text + RUN);
      } finally {
        await context.close();
      }
    });
  }

  test(`${String(STRESS_ROUNDS)} × reload, click, type a Vietnamese sentence: exact value every time`, async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { context, page } = await signedIn(browser);
    try {
      await openOrders(page);
      // Glide's editor code arrives late (a slow network): every character typed meanwhile counts.
      await page.route(/data-grid-overlay-editor/u, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 650));
        await route.continue();
      });
      const failures: string[] = [];
      for (let round = 0; round < STRESS_ROUNDS; round += 1) {
        const text = `Lần ${String(round)}: Nguyễn Văn Đức gửi đơn hàng ưu tiên${RUN}`;
        const typist = TYPISTS[['keyboard.type', 'insertText', 'cdp'][round % 3] ?? 'cdp'];
        if (typist === undefined) throw new Error('typist');
        try {
          const saved = await reloadAndType(page, round % 6, text, typist, round % 4 === 3);
          if (saved !== text) failures.push(`#${String(round)} saved ${JSON.stringify(saved)}`);
        } catch (error) {
          // What the page shows when a round fails.
          const state = await page.evaluate(() => ({
            active: document.activeElement?.tagName,
            sink: document.querySelector<HTMLTextAreaElement>('[data-ob-type-sink]')?.value,
            dialogs: document.querySelectorAll('[role=dialog]').length,
            editor: document.querySelector<HTMLTextAreaElement>('#portal textarea, #portal input')
              ?.value,
          }));
          await page.screenshot({ path: test.info().outputPath(`round-${String(round)}.png`) });
          failures.push(
            `#${String(round)} ${JSON.stringify(state)} ${String(error).slice(0, 300)}`,
          );
          await page.keyboard.press('Escape');
        }
      }
      expect(failures).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
