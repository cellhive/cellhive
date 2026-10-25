import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T523: the run history of automations (CONTRACTS §21 "Lịch sử chạy";
 * boards "S5 · Run history", "… - 375 px") on the demo base (CONTRACTS §9),
 * with the real API and worker. An automation on Tickets finds the tickets
 * of this run, then updates the record whose id is in the trigger ticket's
 * title — a new ticket's title is not a record id, so the run fails. The
 * admin opens the "Run history" tab of the builder, reads the error, sees a
 * found ticket that went to the trash as "Hidden (no permission)", fixes the
 * data and re-runs: the new run succeeds. A batch over the fan-out limit
 * (T503's stand-in run) and a queued run (cancelled from the list) are
 * written straight into `meta.automation_runs`, through the API's own `pg`.
 */

const RUN = String(Date.now()).slice(-6);
const MARK = `T523-${RUN}`;

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

/** A run id of this spec (`run_` + 16 base62). */
function runId(tag: string): string {
  return `run_${`${tag}${RUN}`.padEnd(16, '0').slice(0, 16)}`;
}

async function openAs(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

interface Demo {
  baseId: string;
  tickets: string;
  title: string;
  text: string;
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
      return {
        baseId: base.id,
        tickets,
        title: fields.items.find((field) => field.is_primary)?.id ?? '',
        text: fields.items.find((field) => field.type === 'text' && !field.is_primary)?.id ?? '',
      };
    }
  }
  throw new Error('The demo base is missing.');
}

async function createTicket(page: Page, demo: Demo, title: string): Promise<string> {
  const body = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${demo.tickets}/records?field_key_type=id`,
    { records: [{ fields: { [demo.title]: title } }] },
  );
  return body.records[0]?.id ?? '';
}

interface Run {
  id: string;
  status: string;
}

/** Waits for the automation's runs to reach `count` in a final state (the worker runs them). */
async function waitForRuns(page: Page, automationId: string, done: (runs: Run[]) => boolean) {
  await expect
    .poll(
      async () => {
        const list = await ok<{ items: Run[] }>(page, 'GET', `/automations/${automationId}/runs`);
        return done(list.items);
      },
      { timeout: 180_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;
let automationId = '';
let triggerId = '';
let decoyId = '';
let failedRunId = '';
let orgId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  // The seed leaves a backlog of `events.dispatch` jobs (BACKLOG T519 note): wait for it, so
  // that the runs of this spec are created in time. Only the worker's organization (T800):
  // the other worker's edits are not this spec's backlog.
  await expect
    .poll(
      async () =>
        Number(
          (
            await sql(
              `SELECT count(*)::int AS n FROM meta.events e
                 JOIN meta.organizations o ON o.id = e.organization_id
                WHERE e.dispatched_at IS NULL AND o.name = $1`,
              [WORKER_ORG.orgName],
            )
          )[0]?.['n'] ?? 0,
        ),
      { timeout: 360_000, intervals: [2000] },
    )
    .toBeLessThan(50);
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  decoyId = await createTicket(page, demo, `${MARK} decoy`);
  const created = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E runs ${RUN}`,
    enabled: true,
    definition: {
      trigger: { type: 'record.created', table_id: demo.tickets },
      actions: [
        {
          id: 'act_find',
          type: 'find_records',
          config: {
            table_id: demo.tickets,
            filter: { field: demo.title, operator: 'contains', value: MARK },
            fields: [demo.title],
          },
        },
        {
          id: 'act_fix',
          type: 'update_record',
          config: {
            table_id: demo.tickets,
            record_id: { field: demo.title },
            fields: { [demo.text]: { literal: 'fixed by a re-run' } },
          },
        },
      ],
    },
  });
  automationId = created.id;
  triggerId = await createTicket(page, demo, `${MARK} trigger`);
  await waitForRuns(page, automationId, (runs) => runs.some((run) => run.status === 'failed'));
  const list = await ok<{ items: Run[] }>(page, 'GET', `/automations/${automationId}/runs`);
  failedRunId = list.items.find((run) => run.status === 'failed')?.id ?? '';
  // The decoy goes to the trash: its values in the run output are hidden from now on.
  await ok(page, 'DELETE', `/tables/${demo.tickets}/records`, { ids: [decoyId] });
  const [owner] = await sql(`SELECT organization_id FROM meta.automations WHERE id = $1`, [
    automationId,
  ]);
  orgId = owner?.['organization_id'] as string;
  // A batch over the fan-out limit (T503 stand-in run) and a queued run nobody will start.
  const trigger = (record: string | null, batch: object | null) =>
    JSON.stringify({
      automation_version: 1,
      trigger: {
        event_id: null,
        type: 'record.created',
        table_id: demo.tickets,
        record_id: record,
        bulk: batch !== null,
        batch,
      },
    });
  await sql(
    `INSERT INTO meta.automation_runs
       (id, organization_id, automation_id, automation_version, trigger_unit, status, error,
        input, finished_at, created_at)
     VALUES ($1, $2, $3, 1, $4, 'skipped', $5::jsonb, $6::jsonb, now(), now() - interval '1 minute')`,
    [
      runId('Overflow'),
      orgId,
      automationId,
      runId('Overflow'),
      JSON.stringify({
        code: 'batch_fanout_exceeded',
        batch_id: 'job_Import',
        limit: 1000,
        skipped: 4000,
      }),
      trigger(null, { id: 'job_Import', size: 5000 }),
    ],
  );
  await sql(
    `INSERT INTO meta.automation_runs
       (id, organization_id, automation_id, automation_version, trigger_unit, status, input,
        created_at)
     VALUES ($1, $2, $3, 1, $1, 'queued', $4::jsonb, now() - interval '2 minutes')`,
    [runId('Queued'), orgId, automationId, trigger(triggerId, null)],
  );
  await context.close();
});

test('a failed run: error, hidden values, fix, re-run → succeeded', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  // The "Run history" tab of the builder (T521 header).
  await page.goto(`/b/${demo.baseId}/automations/${automationId}`);
  await page.getByTestId('automation-tab-runs').click();
  await expect(page).toHaveURL(new RegExp(`/automations/${automationId}/runs$`, 'u'));
  await expect(page.getByTestId('automation-tab-runs')).toHaveAttribute('aria-current', 'page');

  const row = page.getByTestId(`run-row-${failedRunId}`);
  await expect(row).toContainText('Failed');
  await expect(row).toContainText(`${MARK} trigger`);
  await expect(row).toContainText('The record to update could not be found from the value given.');
  const overflow = page.getByTestId(`run-row-${runId('Overflow')}`);
  await expect(overflow).toContainText('Batch of 5,000 records');
  await expect(overflow).toContainText('4,000 records were skipped');
  await expectNoSeriousA11yViolations(page, 'run history');

  await page.getByTestId(`run-open-${failedRunId}`).click();
  const detail = page.getByTestId('run-detail');
  await expect(detail).toHaveAttribute('data-run-status', 'failed');
  await expect(detail.getByTestId('step-error-act_fix')).toContainText(
    'The record to update could not be found from the value given.',
  );
  await expect(detail.getByTestId('run-step-act_find')).toContainText('Hidden (no permission)');
  await expect(detail.getByTestId('run-step-act_find')).toContainText(`${MARK} trigger`);
  await expect(detail.getByTestId('run-version')).toContainText('(current)');
  await expectNoSeriousA11yViolations(page, 'run drawer');

  // Fix the data: the trigger ticket's title becomes its own record id.
  await ok(page, 'PATCH', `/tables/${demo.tickets}/records/${triggerId}?field_key_type=id`, {
    fields: { [demo.title]: triggerId },
  });
  await detail.getByTestId('run-rerun').click();
  const confirm = page.getByTestId('rerun-dialog');
  await expect(confirm).toContainText('current definition');
  await confirm.getByTestId('rerun-confirm').click();
  await expect(page.getByText('Re-run started.')).toBeVisible();
  await expect(page).toHaveURL(/\?run=run_/u);
  // Polled until the worker ran it; the find step is reused, the update runs again.
  await expect(page.getByTestId('run-detail')).toHaveAttribute('data-run-status', 'succeeded', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('run-step-act_find')).toContainText(
    'Succeeded in the original run; not run again.',
  );
  await expect(page.getByTestId('run-step-act_fix')).toHaveAttribute(
    'data-step-status',
    'succeeded',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('run-detail')).toHaveCount(0);
  expect(csp).toEqual([]);
  await context.close();
});

test('cancel a queued run from the list; filters; base page', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  await page.goto(`/b/${demo.baseId}/automations/${automationId}/runs`);
  const queued = page.getByTestId(`run-row-${runId('Queued')}`);
  await expect(queued).toContainText('Queued');
  await page.getByTestId(`run-cancel-${runId('Queued')}`).click();
  const dialog = page.getByTestId('cancel-run-dialog');
  await expect(dialog).toContainText('The run has not started');
  await expectNoSeriousA11yViolations(page, 'cancel dialog');
  await dialog.getByTestId('cancel-run-confirm').click();
  await expect(page.getByText('Run cancelled.')).toBeVisible();
  await expect(queued).toContainText('Cancelled by Nguyễn Minh Anh.');

  // Filter: failed only.
  await page.getByTestId('run-filter-status').selectOption('failed');
  await expect(page).toHaveURL(/status=failed/u);
  await expect(page.getByTestId(`run-row-${failedRunId}`)).toBeVisible();
  await expect(page.getByTestId(`run-row-${runId('Overflow')}`)).toHaveCount(0);

  // The list of automations: "Errors in 24 h", the errors link, the base run history.
  await page.goto(`/b/${demo.baseId}/automations`);
  await page.getByTestId('status-errors').click();
  await expect(page.getByTestId(`automation-row-${automationId}`)).toBeVisible();
  await page.getByTestId(`automation-errors-${automationId}`).click();
  await expect(page).toHaveURL(/status=failed&range=24h/u);
  await page.goto(`/b/${demo.baseId}/automations`);
  await page.getByTestId('base-runs-link').click();
  await expect(page).toHaveURL(/\/automations\/runs$/u);
  await expect(page.getByTestId(`run-row-${failedRunId}`)).toContainText(`E2E runs ${RUN}`);

  // A circuit breaker note leads to the failed runs.
  await sql(
    `UPDATE meta.automations SET enabled = false, disabled_reason = 'circuit_breaker',
       version = version + 1 WHERE id = $1`,
    [automationId],
  );
  await page.goto(`/b/${demo.baseId}/automations`);
  await page.getByTestId(`disabled-note-link-${automationId}`).click();
  await expect(page).toHaveURL(
    new RegExp(`/automations/${automationId}/runs\\?status=failed`, 'u'),
  );
  await expect(page.getByTestId(`run-row-${failedRunId}`)).toBeVisible();
  await context.close();
});

test('phones: run history and drawer at 375 px', async ({ browser }) => {
  const { context, page } = await openAs(browser, { width: 375, height: 812 });
  await page.goto(`/b/${demo.baseId}/automations/${automationId}/runs`);
  await expect(page.getByTestId(`run-row-${failedRunId}`)).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'run history at 375 px');
  await page.getByTestId(`run-open-${failedRunId}`).click();
  const detail = page.getByTestId('run-detail');
  await expect(detail).toBeVisible();
  const rerun = detail.getByTestId('run-rerun');
  // A re-run of it already succeeded: re-run is allowed again (no re-run in flight).
  expect((await rerun.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expectNoSeriousA11yViolations(page, 'run drawer at 375 px');
  await context.close();
});
