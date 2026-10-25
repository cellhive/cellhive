import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T520: the automation list of a base (CONTRACTS §21, ADR-25; boards "S5 ·
 * Automation list", "… - trạng thái", "… - 375 px") on the demo base
 * (CONTRACTS §9). The admin creates one from the dialog, turns another on
 * and off, fixes one the circuit breaker turned off ("Turn back on") and
 * takes over one whose `run_as` lost access, then deletes; `u_editor`
 * (manages no table) sees why there is nothing to manage; phones get cards.
 *
 * The circuit breaker (T503) and the `run_as` revalidation (T507) are not
 * merged yet: their end state is written straight into `meta.automations`
 * (the columns they will set), through the API's own `pg` (no new
 * dependency).
 */

const EDITOR_EMAIL = WORKER_ORG.email('editor');
const RUN = String(Date.now()).slice(-6);

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

async function openAs(
  browser: Browser,
  email = WORKER_ORG.email('admin'),
  viewport = { width: 1440, height: 900 },
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

interface Demo {
  baseId: string;
  tickets: string;
  textField: string;
}

async function findDemo(page: Page): Promise<Demo> {
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
      const tickets = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
      const fields = await ok<{ items: { id: string; type: string; is_primary: boolean }[] }>(
        page,
        'GET',
        `/tables/${tickets}/fields`,
      );
      const textField =
        fields.items.find((field) => field.type === 'text' && !field.is_primary)?.id ?? '';
      return { baseId: base.id, tickets, textField };
    }
  }
  throw new Error('The demo base is missing.');
}

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
}

async function createViaApi(page: Page, demo: Demo, name: string): Promise<Automation> {
  return ok<Automation>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name,
    definition: {
      trigger: { type: 'record.created', table_id: demo.tickets },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: demo.tickets,
            record_id: null,
            fields: { [demo.textField]: { literal: 'e2e' } },
          },
        },
      ],
    },
  });
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  await context.close();
});

test('admin creates, turns on and off, fixes and deletes automations', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const list = `/b/${demo.baseId}/automations`;
  await page.goto(`/b/${demo.baseId}`);
  // The sidebar entry, with the number of automations.
  await page.getByTestId('base-automations-link').click();
  await expect(page).toHaveURL(new RegExp(`${list}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();

  // Create from the dialog (T521): name and trigger, then the builder creates it on save.
  const created = `E2E created ${RUN}`;
  await page.getByTestId('create-automation').click();
  const dialog = page.getByTestId('create-automation-dialog');
  await dialog.getByTestId('create-automation-name').fill(created);
  await dialog.getByText('When a record is created').click();
  await expectNoSeriousA11yViolations(page, 'create dialog');
  await dialog.getByTestId('create-automation-submit').click();
  await expect(page).toHaveURL(/\/automations\/new\?/u);
  await page.getByTestId('trigger-table').selectOption({ label: 'Tickets' });
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(`Saved “${created}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/automations\/aut_/u);
  await page.getByRole('link', { name: 'Back to automations' }).click();
  const createdSwitch = page.getByRole('switch', { name: `Turn on ${created}` });
  await expect(createdSwitch).not.toBeChecked();
  await expect(page.getByTestId('automation-table')).toContainText('When a record is created');

  // Turn one with an action on and off (the admin is its run_as: no question).
  const toggled = await createViaApi(page, demo, `E2E toggle ${RUN}`);
  await page.reload();
  const toggle = page.getByRole('switch', { name: `Turn on ${toggled.name}` });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText(`“${toggled.name}” is on.`)).toBeVisible();
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  // The circuit breaker turned it off (T503's end state): reason, then "Turn back on".
  await sql(
    `UPDATE meta.automations SET enabled = false, disabled_reason = 'circuit_breaker',
       version = version + 1 WHERE id = $1`,
    [toggled.id],
  );
  await page.reload();
  const breaker = page.getByTestId(`disabled-note-${toggled.id}`);
  await expect(breaker).toContainText('50 runs in a row failed');
  await expectNoSeriousA11yViolations(page, 'list with a circuit breaker note');
  await breaker.getByRole('button', { name: 'Turn back on' }).click();
  await expect(page.getByTestId(`disabled-note-${toggled.id}`)).toHaveCount(0);
  await expect(toggle).toBeChecked();

  // Its run_as lost access (T507's end state): "Take over" makes the admin run_as again.
  const [editor] = await sql(`SELECT id FROM meta.users WHERE email = $1`, [EDITOR_EMAIL]);
  await sql(
    `UPDATE meta.automations SET enabled = false, disabled_reason = 'run_as_lost_access',
       run_as_user_id = $2, version = version + 1 WHERE id = $1`,
    [toggled.id, editor?.['id']],
  );
  await page.reload();
  const row = page.getByTestId(`automation-row-${toggled.id}`);
  await expect(row).toContainText('Trần Thu Hà');
  const lost = page.getByTestId(`disabled-note-${toggled.id}`);
  await expect(lost).toContainText('Trần Thu Hà (who it runs as) no longer has the permissions');
  await lost.getByRole('button', { name: 'Take over' }).click();
  const takeOver = page.getByTestId('take-over-dialog');
  await expect(takeOver.getByTestId('take-over-reads')).toHaveText('Read: Tickets');
  await expectNoSeriousA11yViolations(page, 'take over dialog');
  await takeOver.getByTestId('take-over-confirm').click();
  await expect(page.getByText(`You now manage “${toggled.name}”.`)).toBeVisible();
  await expect(row).toContainText('Nguyễn Minh Anh');
  await expect(toggle).toBeChecked();

  // Delete, confirmed.
  await page.getByRole('button', { name: `Actions for ${created}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByTestId('delete-automation-confirm').click();
  await expect(page.getByText(`Deleted “${created}”.`)).toBeVisible();
  await expect(page.getByRole('switch', { name: `Turn on ${created}` })).toHaveCount(0);
  expect(csp).toEqual([]);
  await context.close();
});

test('u_editor manages no automation: no entry, no buttons', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(`/b/${demo.baseId}/automations`);
  await expect(page.getByTestId('automations-forbidden')).toBeVisible();
  await expect(page.getByTestId('create-automation')).toHaveCount(0);
  await expect(page.getByTestId('base-automations-link')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'automations of u_editor');
  await context.close();
});

test('phones get cards: switch and fixes, no editing (375 px)', async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
    width: 375,
    height: 812,
  });
  const lost = await createViaApi(page, demo, `E2E phone ${RUN}`);
  const [editor] = await sql(`SELECT id FROM meta.users WHERE email = $1`, [EDITOR_EMAIL]);
  await sql(
    `UPDATE meta.automations SET disabled_reason = 'run_as_lost_access', run_as_user_id = $2,
       version = version + 1 WHERE id = $1`,
    [lost.id, editor?.['id']],
  );
  await page.goto(`/b/${demo.baseId}/automations`);
  const card = page.getByTestId(`automation-card-${lost.id}`);
  await expect(card).toBeVisible();
  await expect(page.getByText('Edit automations on a screen at least 768 px wide.')).toBeVisible();
  await expect(page.getByTestId('create-automation')).toHaveCount(0);
  await expect(card.getByText('Turned off: the person it runs as lost access')).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'automation cards at 375 px');
  const fix = card.getByRole('button', { name: 'Take over' });
  expect((await fix.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await context.close();
});
