import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T524: the notification center and notification settings (CONTRACTS §22;
 * boards "S5 · Notification center", "… - 375 px", "S5 · Notification
 * settings") on the demo organization (CONTRACTS §9).
 *
 * Notifications are produced by the real pipeline: a `notifications.fanout`
 * job (the one producers such as the circuit breaker enqueue, T511) is
 * added through graphile-worker's `add_job` with the API's own `pg` (no new
 * dependency); the worker (MODE=all) checks recipients, writes them and
 * announces `notification.created` on `user:` (realtime, CONTRACTS §7).
 */

const RUN = String(Date.now()).slice(-6);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function fakeId(prefix: string): string {
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += BASE62[Math.floor(Math.random() * BASE62.length)] ?? '0';
  }
  return `${prefix}_${id}`;
}

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

async function sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const { DATABASE_URL } = JSON.parse(raw) as { DATABASE_URL: string };
  const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg') as Pg;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

interface Demo {
  orgId: string;
  orgSlug: string;
  userId: string;
  baseId: string;
  baseName: string;
  tickets: string;
  recordId: string;
  automationId: string;
  automationName: string;
}

interface Fanout {
  readonly type: 'automation.disabled' | 'automation.message';
  readonly tableId?: string | null;
  readonly entity: { readonly type: 'automation' | 'record'; readonly id: string };
  readonly toAdmins?: boolean;
  readonly recordId?: string | null;
  readonly data: Record<string, unknown>;
}

/** Queues `notifications.fanout` like a producer does (CONTRACTS §22.2). */
async function notify(demo: Demo, input: Fanout): Promise<void> {
  const payload = {
    organization_id: demo.orgId,
    type: input.type,
    base_id: demo.baseId,
    table_id: input.tableId ?? null,
    entity_type: input.entity.type,
    entity_id: input.entity.id,
    actor: null,
    group_key: fakeId('key'),
    recipients: {
      user_ids: input.toAdmins === true ? [] : [demo.userId],
      base_admins: input.toAdmins === true,
    },
    requires: { record_id: input.recordId ?? null, field_ids: [] },
    skip_actor: input.type !== 'automation.message',
    data: input.data,
  };
  // Ahead of the seed's backlog of `events.dispatch` jobs (23 000 records created).
  await sql(`SELECT graphile_worker.add_job('notifications.fanout', $1::json, priority => -100)`, [
    JSON.stringify(payload),
  ]);
}

function message(demo: Demo, title: string, entity: Fanout['entity'], extra: Partial<Fanout> = {}) {
  return notify(demo, {
    type: 'automation.message',
    entity,
    data: {
      // Messages of the demo automation are grouped when 3+ come in a row; the
      // others come from automations of their own.
      automation_id: entity.type === 'automation' ? demo.automationId : fakeId('aut'),
      run_id: fakeId('run'),
      title,
      body: `Body of ${title}`,
    },
    ...extra,
  });
}

async function openAs(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const language = options.language ?? 'en';
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, language);
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ user: { id: string }; orgs: { id: string; slug: string }[] }>(
    page,
    'GET',
    '/me',
  );
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
      const tickets = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
      const fields = await ok<{ items: { id: string; type: string; is_primary: boolean }[] }>(
        page,
        'GET',
        `/tables/${tickets}/fields`,
      );
      const primary = fields.items.find((field) => field.is_primary)?.id ?? '';
      const textField =
        fields.items.find((field) => field.type === 'text' && !field.is_primary)?.id ?? '';
      const records = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
        page,
        'POST',
        `/tables/${tickets}/records/query?field_key_type=id&cell_format=text`,
        { limit: 1, fields: [primary] },
      );
      const record = records.records[0];
      if (record === undefined) throw new Error('The demo Tickets table is empty.');
      const automationName = `E2E notify ${RUN}`;
      const automation = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/automations`, {
        name: automationName,
        definition: {
          trigger: { type: 'record.created', table_id: tickets },
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: tickets,
                record_id: null,
                fields: { [textField]: { literal: 'e2e' } },
              },
            },
          ],
        },
      });
      return {
        orgId: org.id,
        orgSlug: org.slug,
        userId: me.user.id,
        baseId: base.id,
        baseName: base.name,
        tickets,
        recordId: record.id,
        automationId: automation.id,
        automationName,
      };
    }
  }
  throw new Error('The demo base is missing.');
}

async function unreadCount(page: Page, demo: Demo): Promise<number> {
  const body = await ok<{ count: number }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/me/notifications/unread-count`,
  );
  return body.count;
}

/** The bell's badge as a number (0 without a badge). */
async function badge(page: Page): Promise<number> {
  // T527: never `innerText()` after `count()`: the badge may leave in between
  // (mark all as read), and `innerText()` would then wait for it until the
  // poll times out. `allInnerTexts()` reads what is there now.
  const texts = await page
    .getByTestId('notification-badge')
    .filter({ visible: true })
    .allInnerTexts();
  const text = texts[0];
  return text === undefined ? 0 : Number(text.replace(/\D/gu, ''));
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  // A clean slate: nothing unread for the admin in the demo organization.
  await ok(page, 'POST', `/orgs/${demo.orgId}/me/notifications/read`, { all: true });
  await context.close();
});

test('bell, realtime count across tabs, toast, panel and reads synced between tabs', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const other = await context.newPage();
  const home = `/o/${demo.orgSlug}`;
  await page.goto(home);
  await other.goto(home);
  const bell = page.getByTestId('notification-bell').filter({ visible: true });
  await expect(bell).toHaveAccessibleName('Notifications');
  expect(await badge(other)).toBe(0);

  // The circuit breaker turns the automation off (T503's end state + its notification).
  await sql(
    `UPDATE meta.automations SET enabled = false, disabled_reason = 'circuit_breaker',
       version = version + 1 WHERE id = $1`,
    [demo.automationId],
  );
  const started = Date.now();
  await notify(demo, {
    type: 'automation.disabled',
    entity: { type: 'automation', id: demo.automationId },
    toAdmins: true,
    data: { automation_id: demo.automationId, reason: 'circuit_breaker' },
  });
  // The other tab's bell goes +1 without polling (BACKLOG T524: < 1 s).
  await expect.poll(() => badge(other), { timeout: 10_000, intervals: [25] }).toBe(1);
  const elapsed = Date.now() - started;
  test
    .info()
    .annotations.push({ type: 'realtime', description: `bell +1 in ${String(elapsed)} ms` });
  expect(elapsed, 'notification.created to the bell of another tab').toBeLessThan(1000);
  // Every tab shows the toast for automation.disabled (board: "realtime, every tab").
  const toast = page.getByText(`«${demo.automationName}» just turned itself off.`);
  await expect(toast).toBeVisible();
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread');

  // Messages: one about a record, one whose record the admin cannot read (lost access),
  // three in a row of one automation (a group). Jobs run concurrently: each step waits
  // for its notifications so that the list order is known.
  await message(
    demo,
    `Paid ${RUN}`,
    { type: 'record', id: demo.recordId },
    { tableId: demo.tickets, recordId: demo.recordId },
  );
  await message(
    demo,
    `Gone ${RUN}`,
    { type: 'record', id: fakeId('rec') },
    { tableId: demo.tickets },
  );
  await expect.poll(() => badge(page), { timeout: 10_000 }).toBe(3);
  for (const index of [1, 2, 3]) {
    await message(demo, `Hourly ${String(index)} ${RUN}`, {
      type: 'automation',
      id: demo.automationId,
    });
  }
  await expect.poll(() => badge(page), { timeout: 10_000 }).toBe(6);

  await bell.click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  const list = panel.getByTestId('notification-list');
  await expect(list.getByRole('listitem').first()).toBeVisible();
  // The burst of three: one group row, expandable.
  const group = list.getByRole('button', {
    name: `3 messages from automation «${demo.automationName}»`,
  });
  await expect(group).toBeVisible();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('link', { name: `Hourly 2 ${RUN}` })).toBeVisible();
  // Lost access: a lock and no link.
  const gone = list.locator('li', { hasText: `Gone ${RUN}` });
  await expect(gone.getByText('No longer allowed to view the record')).toBeVisible();
  await expect(gone.getByRole('link')).toHaveCount(0);
  // The automation turned off: mandatory ("Always sent"), links to its builder (T521).
  const disabled = list.locator('li', {
    hasText: `Automation «${demo.automationName}» turned itself off`,
  });
  await expect(disabled.getByText('Always sent')).toBeVisible();
  await expect(disabled.getByRole('link')).toHaveAttribute(
    'href',
    `/b/${demo.baseId}/automations/${demo.automationId}`,
  );
  await expectNoSeriousA11yViolations(page, 'notification panel');

  // Mark one read here: the other tab's bell follows (BroadcastChannel, no polling).
  await gone.getByRole('button', { name: 'Mark as read' }).click();
  await expect.poll(() => badge(other), { timeout: 5_000 }).toBe(5);
  await expect.poll(() => unreadCount(page, demo)).toBe(5);

  // Opening an item marks it read and goes to the record.
  const paid = list.locator('li', { hasText: `Paid ${RUN}` });
  await paid.getByRole('link', { name: `Paid ${RUN}` }).click();
  await expect(page).toHaveURL(
    new RegExp(`/b/${demo.baseId}/t/${demo.tickets}.*record=${demo.recordId}`, 'u'),
  );
  await expect(panel).toHaveCount(0);
  await expect.poll(() => badge(other), { timeout: 5_000 }).toBe(4);

  // Mark all as read: both bells clear; the Unread tab is empty.
  await bell.click();
  await panel.getByTestId('mark-all-read').click();
  await expect.poll(() => badge(page)).toBe(0);
  await expect.poll(() => badge(other), { timeout: 5_000 }).toBe(0);
  await panel.getByTestId('filter-unread').click();
  await expect(panel.getByTestId('panel-empty')).toContainText('You have read everything');
  // Escape closes and gives the focus back to the bell.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bell).toBeFocused();

  expect(csp).toEqual([]);
  await context.close();
});

test('settings: no SMTP state, frequency and digest hour, types, mute from the sidebar', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const settings = `/o/${demo.orgSlug}/settings/notifications`;
  // Links of emails sent before T524 land on the settings of the current organization.
  await page.goto('/me/settings/notifications');
  await expect(page).toHaveURL(new RegExp(`${settings}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();

  // The E2E stack has no SMTP: the email channel and frequency are hidden, with a reason.
  await expect(page.getByTestId('no-smtp')).toContainText('The email channel is not available');
  await expect(page.getByTestId('email-frequency')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
  // Mandatory type: in-app locked on.
  const locked = page.getByTestId('pref-automation.disabled-in_app');
  await expect(locked).toBeChecked();
  await expect(locked).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'notification settings without SMTP');

  // With SMTP (the instance answer stubbed: the stack has no mail server).
  await page.route('**/api/v1/setup', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { auth_config: { smtp_enabled: boolean } };
    await route.fulfill({
      response,
      json: { ...body, auth_config: { ...body.auth_config, smtp_enabled: true } },
    });
  });
  await page.reload();
  const frequency = page.getByTestId('email-frequency');
  await expect(frequency).toBeVisible();
  await expect(page.getByTestId('no-smtp')).toHaveCount(0);
  await expect(page.getByTestId('frequency-immediate')).toBeChecked();
  await expect(page.getByTestId('daily-hour')).toBeDisabled();
  await page.getByText('Daily', { exact: true }).click();
  await expect(page.getByTestId('settings-saved')).toContainText(
    'Saved: a daily summary email at 08:00.',
  );
  await page.getByTestId('daily-hour').selectOption('9');
  await expect(page.getByTestId('settings-saved')).toContainText(
    'Saved: a daily summary email at 09:00.',
  );
  // Email column: a type turned off by email, saved.
  const overflowEmail = page.getByTestId('pref-automation.batch_overflow-email');
  await expect(overflowEmail).toBeChecked();
  await overflowEmail.click();
  await expect(page.getByTestId('settings-saved')).toContainText('Email off');
  await expectNoSeriousA11yViolations(page, 'notification settings with SMTP');
  await page.reload();
  await expect(page.getByTestId('frequency-daily')).toBeChecked();
  await expect(page.getByTestId('daily-hour')).toHaveValue('9');
  await expect(page.getByTestId('pref-automation.batch_overflow-email')).not.toBeChecked();
  const stored = await ok<{ email_frequency: string; daily_hour: number }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/me/notification-settings`,
  );
  expect(stored).toMatchObject({ email_frequency: 'daily', daily_hour: 9 });

  // Mute the base from its menu in the sidebar, then unmute it on the settings page.
  await expect(page.getByTestId('muted-empty')).toBeVisible();
  await page.locator('#app-sidebar').getByRole('link', { name: demo.baseName }).hover();
  await page.getByRole('button', { name: `Actions for base ${demo.baseName}` }).click();
  await page.getByRole('menuitem', { name: 'Mute notifications' }).click();
  await expect(page.getByText(`«${demo.baseName}» is muted`)).toBeVisible();
  const muted = page.getByTestId(`muted-${demo.baseId}`);
  await expect(muted).toBeVisible();
  await muted.getByRole('button', { name: `Unmute ${demo.baseName}` }).click();
  await expect(muted).toHaveCount(0);
  await expect(page.getByTestId('settings-saved')).toContainText('is no longer muted');

  // Back to the defaults for the other specs.
  await ok(page, 'PUT', `/orgs/${demo.orgId}/me/notification-settings`, {
    email_frequency: 'immediate',
    daily_hour: 8,
  });
  await ok(page, 'PUT', `/orgs/${demo.orgId}/me/notification-preferences`, {
    items: [{ type: 'automation.batch_overflow', channel: 'email', enabled: true }],
  });
  await context.close();
});

test('375 px: the panel takes the whole screen; Vietnamese', async ({ browser }) => {
  const { context, page } = await openAs(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/o/${demo.orgSlug}`);
  await message(
    demo,
    `Điện thoại ${RUN}`,
    { type: 'record', id: demo.recordId },
    {
      tableId: demo.tickets,
      recordId: demo.recordId,
    },
  );
  const bell = page.getByTestId('notification-bell').filter({ visible: true });
  await expect(bell).toHaveAccessibleName('Thông báo, 1 chưa đọc');
  expect((await bell.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await bell.click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel.getByRole('heading', { name: 'Thông báo' })).toBeVisible();
  await expect(panel.getByRole('link', { name: `Điện thoại ${RUN}` })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 375, height: 812 });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'notification panel at 375 px');
  await panel.getByRole('button', { name: 'Đóng thông báo' }).click();
  await expect(panel).toHaveCount(0);
  await expect(bell).toBeFocused();

  // T527: over a table page, the page behind the full-screen panel is inert
  // (axe target-size flagged the grid's controls under it).
  await page.goto(`/b/${demo.baseId}/t/${demo.tickets}`);
  await bell.click();
  await expect(panel.getByRole('heading', { name: 'Thông báo' })).toBeVisible();
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  expect(
    await page.evaluate(() =>
      [...document.body.children]
        .filter((element) => element.getAttribute('data-testid') !== 'notification-panel')
        .every((element) => element.hasAttribute('inert') || element.tagName === 'SCRIPT'),
    ),
  ).toBe(true);
  await expectNoSeriousA11yViolations(page, 'notification panel over a table at 375 px');
  await panel.getByRole('button', { name: 'Đóng thông báo' }).click();
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('body > [inert]').length)).toBe(0);

  await page.goto(`/o/${demo.orgSlug}/settings/notifications`);
  await expect(page.getByRole('heading', { name: 'Thông báo', level: 1 })).toBeVisible();
  await expect(page.getByTestId('preferences')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'notification settings at 375 px');
  await context.close();
});
