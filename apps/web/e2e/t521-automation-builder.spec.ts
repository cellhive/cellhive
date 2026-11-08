import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T521: the automation builder (CONTRACTS §21, ADR-25; boards "S5 ·
 * Automation builder", "… - trigger và điều kiện", "… - action") on the
 * demo base (CONTRACTS §9): an automation "ticket turns urgent → update its
 * status" built without the mouse, an `if` that stops, a `422` pointing at
 * its step, chips following a field rename, the `run_as` band, phones.
 * T1012: the condition branch builder (Lucian UX/UI #132) — "All" / "Any",
 * "N records match now" as the person editing (P-test with u_sales1), no
 * count for a `changed_to` alone, a `422` on the right rule.
 */

const EDITOR_EMAIL = WORKER_ORG.email('editor');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
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

interface Field {
  id: string;
  name: string;
  type: string;
  options: { options?: { id: string; name: string }[] };
}

interface Demo {
  baseId: string;
  tickets: string;
  fields: Field[];
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
      const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${tickets}/fields`);
      return { baseId: base.id, tickets, fields: fields.items };
    }
  }
  throw new Error('The demo base is missing.');
}

function field(demo: Demo, name: string): Field {
  const found = demo.fields.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Tickets has no field ${name}`);
  return found;
}

function option(item: Field, name: string): string {
  const found = item.options.options?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${item.name} has no option ${name}`);
  return found.id;
}

interface Automation {
  id: string;
  version: number;
  definition: {
    trigger: Record<string, unknown>;
    condition: Record<string, unknown> | null;
    actions: Record<string, unknown>[];
  };
}

async function createViaApi(
  page: Page,
  demo: Demo,
  name: string,
  fieldId: string,
  template: string,
) {
  return ok<Automation>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name,
    definition: {
      trigger: { type: 'record.created', table_id: demo.tickets },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: { table_id: demo.tickets, record_id: null, fields: { [fieldId]: { template } } },
        },
      ],
    },
  });
}

/** Focuses a control and presses a key (the keyboard way, no pointer). */
async function press(page: Page, locator: ReturnType<Page['locator']>, key: string) {
  await locator.focus();
  await page.keyboard.press(key);
}

/** How many records of `tableId` match `filter` for the signed-in user (`records/query`, one row). */
async function matchCount(page: Page, tableId: string, filter: unknown): Promise<number> {
  const result = await ok<{ total?: number; total_estimate?: number }>(
    page,
    'POST',
    `/tables/${tableId}/records/query`,
    { filter, limit: 1, fields: [] },
  );
  return result.total ?? result.total_estimate ?? -1;
}

/**
 * Filtered records queries of the page from now on: the counts of the
 * condition builder (other parts of the builder read a record without one).
 */
function countQueries(page: Page): string[] {
  const bodies: string[] = [];
  page.on('request', (request) => {
    const body = request.postData() ?? '';
    if (request.url().includes('/records/query') && body.includes('"filter"')) bodies.push(body);
  });
  return bodies;
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  await context.close();
});

test('builds “ticket turns urgent → update its status” with the keyboard', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const priority = field(demo, 'Ưu tiên');
  const status = field(demo, 'Trạng thái');
  await page.goto(`/b/${demo.baseId}/automations`);

  // The create dialog: a name and the trigger, then "Continue" to the builder.
  await press(page, page.getByTestId('create-automation'), 'Enter');
  const dialog = page.getByTestId('create-automation-dialog');
  await expect(dialog.getByTestId('create-automation-name')).toBeFocused();
  const name = `E2E urgent ${RUN}`;
  await page.keyboard.type(name);
  await press(page, dialog.getByTestId('trigger-record.updated'), 'Space');
  await press(page, dialog.getByTestId('create-automation-submit'), 'Enter');
  await expect(page).toHaveURL(/\/automations\/new\?/u);
  await expect(page.getByTestId('builder-title')).toHaveText(name);

  // Trigger: Tickets, watching "Ưu tiên".
  const trigger = page.getByTestId('trigger-panel');
  await trigger.getByTestId('trigger-table').focus();
  await trigger.getByTestId('trigger-table').selectOption({ label: 'Tickets' });
  await trigger.getByPlaceholder('Search fields').focus();
  await page.keyboard.type('Ưu');
  await press(page, trigger.getByRole('checkbox', { name: 'Ưu tiên' }), 'Space');
  await expect(page.getByTestId('step-trigger')).toContainText('Watching Ưu tiên');

  // Condition: "Ưu tiên" changed to "Khẩn cấp".
  await press(page, page.locator('[data-step-button="condition"]'), 'Enter');
  const conditions = page.getByTestId('condition-panel');
  await press(page, conditions.getByRole('button', { name: 'Add condition' }), 'Enter');
  await conditions.getByLabel('Field').selectOption({ label: 'Ưu tiên' });
  await conditions.getByLabel('Operator for Ưu tiên').selectOption('changed_to');
  await conditions.getByLabel('Value for Ưu tiên').selectOption({ label: 'Khẩn cấp' });
  await expect(page.getByTestId('step-condition')).toContainText('Ưu tiên changed to Khẩn cấp');
  await expectNoSeriousA11yViolations(page, 'builder with the condition panel');

  // Step: update the trigger record's status.
  await press(page, page.getByTestId('add-step'), 'Enter');
  await expect(page.getByTestId('add-update_record')).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('config-panel');
  await expect(panel.getByRole('heading', { name: 'Step 1 · Update record' })).toBeFocused();
  await panel.getByTestId('field-map-add').selectOption({ label: 'Trạng thái' });
  await panel
    .getByLabel('Value of Trạng thái', { exact: true })
    .selectOption({ label: 'Đang xử lý' });
  await expectNoSeriousA11yViolations(page, 'builder with an action panel');

  // Ctrl/⌘+S creates it (off).
  await page.keyboard.press('Control+s');
  await expect(page.getByText(`Saved “${name}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/automations\/aut_/u);
  const id = /\/automations\/(aut_[^/?]+)/u.exec(page.url())?.[1] ?? '';
  const saved = await ok<Automation>(page, 'GET', `/automations/${id}`);
  expect(saved.definition.trigger).toEqual({
    type: 'record.updated',
    table_id: demo.tickets,
    watch_fields: [priority.id],
    skip_bulk: false,
  });
  expect(JSON.stringify(saved.definition.condition)).toContain(option(priority, 'Khẩn cấp'));
  expect(JSON.stringify(saved.definition.condition)).toContain('changed_to');
  expect(saved.definition.actions).toEqual([
    {
      id: 'act_1',
      type: 'update_record',
      config: {
        table_id: demo.tickets,
        record_id: null,
        fields: { [status.id]: { literal: option(status, 'Đang xử lý') } },
      },
    },
  ]);

  // An if whose "False" branch stops the run.
  await press(page, page.getByTestId('add-step'), 'Enter');
  await press(page, page.getByTestId('add-if'), 'Enter');
  const ifPanel = page.getByTestId('config-panel');
  await press(page, ifPanel.getByRole('button', { name: 'Value comparison' }), 'Enter');
  await press(page, ifPanel.getByRole('button', { name: 'Choose a value for Value 1' }), 'Enter');
  await page.keyboard.type('Ưu tiên');
  await page.keyboard.press('Enter');
  await press(page, ifPanel.getByLabel('Stop the automation'), 'Space');
  await expect(page.getByTestId(`branch-act_2-else`)).toContainText('Stops the run');
  await page.keyboard.press('Control+s');
  await expect
    .poll(
      async () => (await ok<Automation>(page, 'GET', `/automations/${id}`)).definition.actions[1],
    )
    .toMatchObject({
      id: 'act_2',
      type: 'if',
      config: {
        on_false: 'stop',
        conditions: [{ value: { field: priority.id }, operator: 'is_not_empty' }],
      },
    });
  expect(csp).toEqual([]);
  await context.close();
});

test('a 422 points at its step; chips follow field renames', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  const notes = field(demo, 'Mô tả');
  const temp = await ok<Field>(page, 'POST', `/tables/${demo.tickets}/fields`, {
    name: `E2E temp ${RUN}`,
    type: 'text',
  });
  const automation = await createViaApi(
    page,
    demo,
    `E2E chips ${RUN}`,
    notes.id,
    `Copy: {{ [${temp.id}] }}`,
  );
  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  const step = page.getByTestId('step-act_1');
  await expect(step).toContainText(`Mô tả = Copy: E2E temp ${RUN}`);

  // Renaming the field renames its chip (stored with the id).
  await ok(page, 'PATCH', `/fields/${temp.id}`, { name: `E2E renamed ${RUN}` });
  await page.reload();
  await expect(step).toContainText(`Copy: E2E renamed ${RUN}`);

  // The field goes away meanwhile: the save answers 422 at the step that uses it.
  await ok(page, 'DELETE', `/fields/${temp.id}`);
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByTestId('builder-name').fill(`E2E chips ${RUN} 2`);
  await page.keyboard.press('Enter');
  // Change the definition so that it is checked again.
  await page.locator('[data-step-button="trigger"]').click();
  await page.getByTestId('trigger-skip-bulk').check();
  await page.getByTestId('builder-save').click();
  const summary = page.getByTestId('issue-summary');
  await expect(summary).toContainText('Not saved: 1 problem');
  await expect(summary).toContainText('Step 1:');
  await expect(step).toContainText('1 problem');
  await expectNoSeriousA11yViolations(page, 'builder with a 422');
  await context.close();
});

test('editing an automation that runs as someone else says so (ADR-25 §4)', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  const automation = await createViaApi(
    page,
    demo,
    `E2E run as ${RUN}`,
    field(demo, 'Mô tả').id,
    'x',
  );
  const [editor] = await sql(`SELECT id, display_name FROM meta.users WHERE email = $1`, [
    EDITOR_EMAIL,
  ]);
  await sql(
    `UPDATE meta.automations SET run_as_user_id = $2, version = version + 1 WHERE id = $1`,
    [automation.id, editor?.['id']],
  );
  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  const banner = page.getByTestId('run-as-banner');
  const who = String(editor?.['display_name']);
  await expect(banner).toContainText(`This automation runs with the permissions of ${who}.`);
  await page.locator('[data-step-button="trigger"]').click();
  await page.getByTestId('trigger-skip-bulk').check();
  await expect(banner).toContainText(
    `After saving, it will run with your permissions instead of ${who}’s.`,
  );
  await banner.getByRole('button', { name: 'Permissions used' }).click();
  await expect(banner.getByTestId('run-as-scope')).toContainText('Write: Tickets (fields Mô tả)');
  await expectNoSeriousA11yViolations(page, 'run_as band');
  await context.close();
});

test('update_records with a value from the trigger, delay with recheck, [@previous] (T521b)', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const notes = field(demo, 'Mô tả');
  const priority = field(demo, 'Ưu tiên');
  const status = field(demo, 'Trạng thái');
  const automation = await ok<Automation>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E bulk ${RUN}`,
    definition: {
      trigger: { type: 'record.updated', table_id: demo.tickets, watch_fields: [priority.id] },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: demo.tickets,
            record_id: null,
            fields: {
              [notes.id]: { template: `{{ [@actor] }}: {{ [@previous].[${priority.id}] }}` },
            },
          },
        },
      ],
    },
  });
  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  // Chips of the actor and of the value before the change.
  await expect(page.getByTestId('step-act_1')).toContainText(
    'Changed by: Before the change · Ưu tiên',
  );

  // Update records: Tickets whose "Ưu tiên" is the trigger record's.
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-update_records').click();
  const panel = page.getByTestId('config-panel');
  await panel.getByTestId('action-table').selectOption({ label: 'Tickets' });
  await panel.getByRole('button', { name: 'Add condition', exact: true }).click();
  await panel
    .getByTestId('filter-condition')
    .getByLabel('Field', { exact: true })
    .selectOption({ label: 'Ưu tiên' });
  await panel.getByRole('button', { name: 'Choose a value for Value for Ưu tiên' }).click();
  await page.keyboard.type('Ưu tiên');
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('filter-value-source')).toContainText('Ưu tiên');
  await expect(panel.getByTestId('update-records-count')).toContainText('known when the step runs');
  await panel.getByTestId('field-map-add').selectOption({ label: 'Trạng thái' });
  await panel.getByLabel('Value of Trạng thái', { exact: true }).selectOption({ label: 'Mới' });

  // Delay: 2 days, then check the record again.
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-delay').click();
  await panel.getByTestId('delay-amount').fill('2');
  await panel.getByLabel('Unit').selectOption('days');
  await panel.getByTestId('delay-recheck').click();
  await panel.getByRole('button', { name: 'Add condition', exact: true }).click();
  await panel
    .getByTestId('filter-condition')
    .getByLabel('Field', { exact: true })
    .selectOption({ label: 'Trạng thái' });
  await panel.getByLabel('Value for Trạng thái').selectOption({ label: 'Mới' });
  await expectNoSeriousA11yViolations(page, 'delay panel');
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(`Saved “E2E bulk ${RUN}”.`)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'builder after save (hovered Save)');

  const saved = await ok<Automation>(page, 'GET', `/automations/${automation.id}`);
  expect(saved.definition.actions[1]).toMatchObject({
    id: 'act_2',
    type: 'update_records',
    config: {
      table_id: demo.tickets,
      filter: { items: [{ field: priority.id, value: { field: priority.id } }] },
      fields: { [status.id]: { literal: option(status, 'Mới') } },
      limit: 1000,
    },
  });
  expect(saved.definition.actions[2]).toMatchObject({
    id: 'act_3',
    type: 'delay',
    config: { minutes: 2880, until: null },
  });
  expect(JSON.stringify(saved.definition.actions[2])).toContain(option(status, 'Mới'));
  await context.close();
});

test('“N records match now” follows All → Any; a 422 marks its rule (T1012)', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const status = field(demo, 'Trạng thái');
  const priority = field(demo, 'Ưu tiên');
  const isNew = { field: status.id, operator: 'is', value: option(status, 'Mới') };
  const isUrgent = { field: priority.id, operator: 'is', value: option(priority, 'Khẩn cấp') };
  const automation = await ok<Automation>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E count ${RUN}`,
    definition: {
      trigger: { type: 'record.created', table_id: demo.tickets },
      condition: { op: 'and', items: [isNew, isUrgent] },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: demo.tickets,
            record_id: null,
            fields: { [status.id]: { literal: option(status, 'Đang xử lý') } },
          },
        },
      ],
    },
  });
  const all = await matchCount(page, demo.tickets, { op: 'and', items: [isNew, isUrgent] });
  const any = await matchCount(page, demo.tickets, { op: 'or', items: [isNew, isUrgent] });
  expect(any).toBeGreaterThan(all);

  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  await press(page, page.locator('[data-step-button="condition"]'), 'Enter');
  const conditions = page.getByTestId('condition-panel');
  const count = conditions.getByTestId('condition-match-count');
  await expect(count).toHaveAttribute('data-count', String(all));
  await expect(count).toContainText('records match now');
  await expect(count).toContainText('Based on your access, on current data');
  const pill = conditions.getByRole('group', { name: 'Conditions to match' });
  await expect(pill.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await expectNoSeriousA11yViolations(page, 'condition branch builder');

  // "Any", with the keyboard: the group becomes an or, the count follows.
  await press(page, pill.getByRole('button', { name: 'Any' }), 'Enter');
  await expect(pill.getByRole('button', { name: 'Any' })).toHaveAttribute('aria-pressed', 'true');
  await expect(pill.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('step-condition')).toContainText('Any condition is true');
  await expect(count).toHaveAttribute('data-count', String(any));
  await expect(count).toHaveAttribute('aria-busy', 'false');

  // The server refuses the second rule: that rule, not the first, says why.
  await page.route(`**/automations/${automation.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return route.fulfill({
      status: 422,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Invalid automation',
        status: 422,
        code: 'AUTOMATION_INVALID',
        errors: [{ path: 'definition.condition.items[1].value', code: 'UNKNOWN_OPTION' }],
      }),
    });
  });
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('issue-summary')).toContainText('Not saved: 1 problem');
  const rules = conditions.getByTestId('filter-condition');
  await expect(rules.nth(1)).toHaveAttribute('aria-invalid', 'true');
  await expect(rules.nth(1)).toContainText('This option does not belong to the field.');
  await expect(rules.nth(0)).not.toHaveAttribute('aria-invalid');
  await expectNoSeriousA11yViolations(page, 'condition branch builder with a 422');
  expect(csp).toEqual([]);
  await context.close();
});

test('a changed_to alone shows no count; the rest of the condition is counted (T1012)', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const status = field(demo, 'Trạng thái');
  const priority = field(demo, 'Ưu tiên');
  const automation = await ok<Automation>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E changed ${RUN}`,
    definition: {
      trigger: { type: 'record.updated', table_id: demo.tickets, watch_fields: [priority.id] },
      condition: {
        op: 'and',
        items: [
          { field: priority.id, operator: 'changed_to', value: option(priority, 'Khẩn cấp') },
        ],
      },
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: demo.tickets,
            record_id: null,
            fields: { [status.id]: { literal: option(status, 'Đang xử lý') } },
          },
        },
      ],
    },
  });
  const isNew = await matchCount(page, demo.tickets, {
    op: 'and',
    items: [{ field: status.id, operator: 'is', value: option(status, 'Mới') }],
  });
  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  const queries = countQueries(page);
  await page.locator('[data-step-button="condition"]').click();
  const conditions = page.getByTestId('condition-panel');
  await expect(conditions.getByLabel('Operator for Ưu tiên')).toHaveValue('changed_to');
  // Past the 400 ms wait: nothing counted, nothing asked.
  await page.waitForTimeout(1_000);
  await expect(conditions.getByTestId('condition-match-count')).toHaveCount(0);
  expect(queries).toEqual([]);

  // A plain condition next to it: its records are counted, without the changed_to.
  await conditions.getByRole('button', { name: 'Add condition', exact: true }).click();
  await conditions
    .getByLabel('Field', { exact: true })
    .nth(1)
    .selectOption({ label: 'Trạng thái' });
  await conditions.getByLabel('Value for Trạng thái').selectOption({ label: 'Mới' });
  const count = conditions.getByTestId('condition-match-count');
  await expect(count).toHaveAttribute('data-count', String(isNew));
  expect(queries.at(-1)).not.toContain('changed_to');
  // Removed again: the count goes away.
  await conditions.getByRole('button', { name: 'Remove condition on Trạng thái' }).click();
  await expect(count).toHaveCount(0);
  await context.close();
});

test('P-test: u_sales1 managing Orders sees the count of their own records (T1012)', async ({
  browser,
}) => {
  const admin = await openAs(browser);
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    admin.page,
    'GET',
    `/bases/${demo.baseId}/tables`,
  );
  const orders = tables.items.find((table) => table.name === 'Orders')?.id ?? '';
  const orderFields = (await ok<{ items: Field[] }>(admin.page, 'GET', `/tables/${orders}/fields`))
    .items;
  const ofOrders = (name: string) => {
    const found = orderFields.find((item) => item.name === name);
    if (found === undefined) throw new Error(`Orders has no field ${name}`);
    return found;
  };
  const status = ofOrders('status');
  const owner = ofOrders('owner');
  const isNew = {
    op: 'and',
    items: [{ field: status.id, operator: 'is', value: option(status, 'Mới') }],
  };
  const [sales1] = await sql(`SELECT id FROM meta.users WHERE email = $1`, [SALES1_EMAIL]);
  // Like the Sales role, but managing Orders (automations): only their own orders.
  const role = await ok<{ id: string }>(admin.page, 'POST', `/bases/${demo.baseId}/roles`, {
    name: `E2E own orders ${RUN}`,
    config: {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [orders]: {
          perm: 'manage',
          view_rule: { allow_edit: false, visible_views: null },
          record_rule: {
            operations: [],
            edit_filter: {
              op: 'and',
              items: [
                { field: owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
              ],
            },
            read_scope: 'editable',
            read_filter: null,
          },
        },
      },
      dashboards: {},
    },
  });
  const assignment = {
    principal_type: 'user',
    principal_id: String(sales1?.['id']),
    role_id: role.id,
  };
  await ok(admin.page, 'PUT', `/bases/${demo.baseId}/role-assignments`, assignment);
  const sales = await openAs(browser, { email: SALES1_EMAIL });
  try {
    const theirs = await matchCount(sales.page, orders, isNew);
    const everyone = await matchCount(admin.page, orders, isNew);
    expect(theirs).toBeGreaterThan(0);
    expect(everyone).toBeGreaterThan(theirs);
    const automation = await ok<Automation>(
      sales.page,
      'POST',
      `/bases/${demo.baseId}/automations`,
      {
        name: `E2E sales count ${RUN}`,
        definition: {
          trigger: { type: 'record.created', table_id: orders },
          condition: isNew,
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: orders,
                record_id: null,
                fields: { [status.id]: { literal: option(status, 'Xong') } },
              },
            },
          ],
        },
      },
    );
    await sales.page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
    await sales.page.locator('[data-step-button="condition"]').click();
    const count = sales.page.getByTestId('condition-panel').getByTestId('condition-match-count');
    await expect(count).toHaveAttribute('data-count', String(theirs));
    await expect(count).toContainText('Based on your access, on current data');
    // The base admin sees every order on the same condition.
    await admin.page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
    await admin.page.locator('[data-step-button="condition"]').click();
    await expect(
      admin.page.getByTestId('condition-panel').getByTestId('condition-match-count'),
    ).toHaveAttribute('data-count', String(everyone));
    await ok(admin.page, 'DELETE', `/automations/${automation.id}`);
  } finally {
    await sales.context.close();
    await ok(admin.page, 'DELETE', `/bases/${demo.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: assignment.principal_id,
    });
    await ok(admin.page, 'DELETE', `/bases/${demo.baseId}/roles/${role.id}`);
    await admin.context.close();
  }
});

test('phones look and turn on/off only (375 px, vi)', async ({ browser }) => {
  const { context, page } = await openAs(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  const automation = await createViaApi(
    page,
    demo,
    `E2E phone ${RUN}`,
    field(demo, 'Mô tả').id,
    'x',
  );
  await page.goto(`/b/${demo.baseId}/automations/${automation.id}`);
  await expect(page.getByText('Sửa automation trên màn hình rộng ≥ 768 px.')).toBeVisible();
  await expect(page.getByTestId('step-trigger')).toContainText('Khi');
  await expect(page.getByTestId('builder-save')).toHaveCount(0);
  await expect(page.getByTestId('config-panel')).toHaveCount(0);
  await expect(page.getByTestId('add-step')).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  // T527: the name stays readable and the tabs sit below the top bar, clear of the bell.
  const title = await page.getByTestId('builder-title').boundingBox();
  expect(title?.width ?? 0).toBeGreaterThan(40);
  const tabs = await page.getByTestId('automation-tab-runs').boundingBox();
  const bell = await page.getByTestId('notification-bell').filter({ visible: true }).boundingBox();
  expect(tabs?.y ?? 0).toBeGreaterThanOrEqual((bell?.y ?? 0) + (bell?.height ?? 0));
  await expectNoSeriousA11yViolations(page, 'builder at 375 px');
  // Turning it on is still possible (the caller is its run_as: no question).
  await page.getByTestId('builder-enabled').click();
  await expect(page.getByTestId('builder-enabled')).toBeChecked();
  await context.close();
});
