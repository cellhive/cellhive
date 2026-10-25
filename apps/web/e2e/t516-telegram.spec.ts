import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T516: Telegram bots of the organization (CONTRACTS §24) and the
 * `send_telegram` step of the builder (CONTRACTS §21) on the demo base
 * (CONTRACTS §9). Nothing here sends a message: the builder only saves the
 * step (the run against a fake Bot API is covered by the API integration
 * tests) — the real Telegram API is never called.
 */

const EDITOR_EMAIL = WORKER_ORG.email('editor');
const RUN = String(Date.now()).slice(-6);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

async function openAs(
  browser: Browser,
  options: {
    email?: string;
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const language = options.language ?? 'en';
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: language === 'en' ? 'en-US' : 'vi-VN',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, language);
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, options.email ?? WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

interface Demo {
  org: { id: string; slug: string };
  baseId: string;
  baseName: string;
  tickets: string;
  titleField: string;
}

let demo: Demo;
const BOT = `E2E bot ${RUN}`;

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
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
      const tables = await ok<{ items: { id: string; name: string; primary_field_id: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const tickets = tables.items.find((table) => table.name === 'Tickets');
      if (tickets === undefined) break;
      const fields = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/tables/${tickets.id}/fields`,
      );
      const title = fields.items.find((item) => item.id === tickets.primary_field_id);
      return {
        org: { id: org.id, slug: org.slug },
        baseId: base.id,
        baseName: base.name,
        tickets: tickets.id,
        titleField: title?.name ?? '',
      };
    }
  }
  throw new Error('The demo base is missing.');
}

const settingsPath = () => `/o/${encodeURIComponent(demo.org.slug)}/settings/telegram`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  await context.close();
});

test('an organization admin adds a bot for one base; the token never comes back', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const bodies: string[] = [];
  page.on('response', (response) => {
    if (!response.url().includes('/api/v1/')) return;
    void response
      .text()
      .then((text) => bodies.push(text))
      .catch(() => undefined);
  });
  await page.goto(settingsPath());
  await expect(page.getByRole('heading', { name: 'Telegram bots', level: 1 })).toBeVisible();
  await expect(page.getByTestId('nav-telegram')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('bot-add').click();
  const dialog = page.getByRole('dialog', { name: 'Add a Telegram bot' });
  await dialog.getByLabel('Name').fill(BOT);
  await dialog.getByLabel('Bot token').fill('not-a-token');
  await dialog.getByTestId('bot-save').click();
  await expect(dialog.getByText(/This is not a Telegram bot token/u)).toBeVisible();
  await dialog.getByLabel('Bot token').fill(TOKEN);
  await dialog.getByLabel('Selected bases').check();
  await dialog.getByRole('checkbox', { name: demo.baseName }).check();
  await expectNoSeriousA11yViolations(page, 'add Telegram bot dialog');
  await dialog.getByTestId('bot-save').click();
  await expect(page.getByText(`Bot “${BOT}” added.`)).toBeVisible();
  const row = page.getByTestId('bot-row').filter({ hasText: BOT });
  await expect(row).toContainText(`Bases: ${demo.baseName}`);
  await expectNoSeriousA11yViolations(page, 'Telegram bots page');

  // Changing it without a token keeps the saved one.
  await row.getByRole('button', { name: `Change ${BOT}` }).click();
  const edit = page.getByRole('dialog', { name: `Change ${BOT}` });
  await expect(edit.getByLabel('Bot token')).toHaveValue('');
  await edit.getByTestId('bot-save').click();
  await expect(page.getByText(`Bot “${BOT}” saved.`)).toBeVisible();

  const list = await ok<{ items: { name: string; base_ids: string[] }[] }>(
    page,
    'GET',
    `/orgs/${demo.org.id}/secrets`,
  );
  expect(list.items.find((item) => item.name === BOT)?.base_ids).toEqual([demo.baseId]);
  for (const body of bodies) expect(body).not.toContain('AAHdqTcv');
  await context.close();
});

test('the builder sends a Telegram message with a bot of the base, a chat id and chips', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const created = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E Telegram ${RUN}`,
    definition: { trigger: { type: 'record.created', table_id: demo.tickets }, actions: [] },
  });
  await page.goto(`/b/${demo.baseId}/automations/${created.id}`);
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-send_telegram').click();
  const panel = page.getByTestId('config-panel');
  await expect(
    panel.getByRole('heading', { name: 'Step 1 · Send Telegram message' }),
  ).toBeVisible();

  // Saving an empty step names what is missing.
  await page.keyboard.press('Control+s');
  await expect(panel.getByText('Choose a value.').first()).toBeVisible();

  await panel.getByTestId('telegram-bot').selectOption({ label: BOT });
  await panel.getByRole('textbox', { name: 'Chat id' }).fill('-1001234567890');
  const message = panel.getByRole('textbox', { name: 'Message' });
  await message.click();
  await page.keyboard.type('<b>Ticket mới</b>: ');
  await panel.getByRole('button', { name: 'Insert a value into Message' }).click();
  await page.keyboard.type(demo.titleField);
  await page.keyboard.press('Enter');
  await expect(message).toContainText(demo.titleField);
  await expectNoSeriousA11yViolations(page, 'builder with the Telegram step');

  await page.keyboard.press('Control+s');
  await expect(page.getByText(`Saved “E2E Telegram ${RUN}”.`)).toBeVisible();
  await expect(page.getByTestId('step-act_1')).toContainText('To');
  const saved = await ok<{ definition: { actions: Record<string, unknown>[] } }>(
    page,
    'GET',
    `/automations/${created.id}`,
  );
  const list = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${demo.baseId}/secrets?kind=telegram_bot`,
  );
  const botId = list.items.find((item) => item.name === BOT)?.id;
  expect(saved.definition.actions).toEqual([
    {
      id: 'act_1',
      type: 'send_telegram',
      config: {
        secret_id: botId,
        chat_id: { literal: -1001234567890 },
        text: {
          template: expect.stringMatching(
            /^<b>Ticket mới<\/b>: \{\{ \[fld_[0-9A-Za-z]{16}\] \}\}$/u,
          ),
          digest: null,
        },
      },
    },
  ]);

  // The bot is in use: deleting it is refused and the automation is listed.
  await page.goto(settingsPath());
  await page
    .getByTestId('bot-row')
    .filter({ hasText: BOT })
    .getByRole('button', { name: `Delete ${BOT}` })
    .click();
  const confirm = page.getByRole('alertdialog', { name: `Delete ${BOT}?` });
  await expect(confirm.getByTestId('bot-usages')).toContainText(`E2E Telegram ${RUN}`);
  await confirm.getByTestId('bot-delete-confirm').click();
  await expect(
    confirm.getByText('Automations still use this bot. Change them first.').first(),
  ).toBeVisible();
  await context.close();
});

test('members who are not organization admins get the 404 screen and 403 from the API', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, { email: EDITOR_EMAIL });
  await page.goto(settingsPath());
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  const answer = await api(page, 'GET', `/orgs/${demo.org.id}/secrets`);
  expect(answer.status).toBe(403);
  await context.close();
});

test('375 px and Vietnamese: the list and the sheet fit, no horizontal scroll', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(settingsPath());
  await expect(page.getByRole('heading', { name: 'Bot Telegram', level: 1 })).toBeVisible();
  await expect(page.getByTestId('bot-row').filter({ hasText: BOT })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'Telegram bots (375 px, vi)');
  await page.getByTestId('bot-add').click();
  await expect(page.getByRole('dialog', { name: 'Thêm bot Telegram' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'add bot sheet (375 px, vi)');
  await context.close();
});
