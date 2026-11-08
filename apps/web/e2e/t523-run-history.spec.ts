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

// --- T1013: the run tape (Lucian UX/UI #191) ------------------------------------------

interface TapeStep {
  readonly action: string;
  readonly type: string;
  readonly status: string;
  readonly attempt?: number;
  /** ms after the run started. */
  readonly from: number;
  readonly to: number | null;
  readonly output?: unknown;
  readonly error?: unknown;
}

/**
 * A run of `automation` written straight into the run log (no job: nobody
 * runs it), started `ago` ms before now, with its definition snapshot.
 */
async function insertRun(run: {
  readonly id: string;
  readonly automation: string;
  readonly status: string;
  readonly ago: number;
  readonly end: number | null;
  readonly error?: unknown;
  readonly definition: unknown;
  readonly steps: readonly TapeStep[];
}): Promise<void> {
  const start = Date.now() - run.ago;
  const at = (ms: number) => new Date(start + ms).toISOString();
  await sql(
    `INSERT INTO meta.automation_runs
       (id, organization_id, automation_id, automation_version, trigger_unit, status, error,
        input, started_at, finished_at, created_at)
     VALUES ($1, $2, $3, 1, $1, $4, $5::jsonb, $6::jsonb, $7, $8, $7)`,
    [
      run.id,
      orgId,
      run.automation,
      run.status,
      run.error === undefined ? null : JSON.stringify(run.error),
      JSON.stringify({
        automation_version: 1,
        definition: run.definition,
        trigger: {
          event_id: null,
          type: 'record.created',
          table_id: demo.tickets,
          record_id: triggerId,
          bulk: false,
          batch: null,
        },
      }),
      at(0),
      run.end === null ? null : at(run.end),
    ],
  );
  for (const [index, step] of run.steps.entries()) {
    await sql(
      `INSERT INTO meta.automation_run_steps
         (id, organization_id, run_id, action_id, status, attempt, idempotency_key, started_at,
          finished_at, input, output, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
      [
        `stp_${`${run.id.slice(4, 10)}${String(index)}`.padEnd(16, '0').slice(0, 16)}`,
        orgId,
        run.id,
        step.action,
        step.status,
        step.attempt ?? 1,
        `${run.id}:${step.action}`,
        at(step.from),
        step.to === null ? null : at(step.to),
        JSON.stringify({ type: step.type }),
        step.output === undefined ? null : JSON.stringify(step.output),
        step.error === undefined ? null : JSON.stringify(step.error),
      ],
    );
  }
}

/** The computed color of a Cellhive token (`--success`…), as the browser writes colors. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('i');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test('run tape: a retry and an error in order and color; scrub to step 2; keyboard', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const definition = {
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
        id: 'act_update',
        type: 'update_record',
        config: {
          table_id: demo.tickets,
          record_id: { field: demo.title },
          fields: { [demo.text]: { literal: 'checked' } },
        },
      },
      {
        id: 'act_create',
        type: 'create_record',
        config: { table_id: demo.tickets, fields: { [demo.title]: { literal: 'follow-up' } } },
      },
    ],
  };
  const tape = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E tape ${RUN}`,
    enabled: false,
    definition,
  });
  // Step 2 failed once and succeeded on its second attempt 10 s later; step 3 failed.
  const run = runId('Tape');
  await insertRun({
    id: run,
    automation: tape.id,
    status: 'failed',
    ago: 60_000,
    end: 13_000,
    error: { code: 'permission_denied', step: 'act_create', params: { scope: 'table' } },
    definition,
    steps: [
      { action: 'act_find', type: 'find_records', status: 'succeeded', from: 50, to: 400 },
      {
        action: 'act_update',
        type: 'update_record',
        status: 'succeeded',
        attempt: 2,
        from: 10_400,
        to: 11_300,
        output: { id: triggerId },
      },
      {
        action: 'act_create',
        type: 'create_record',
        status: 'failed',
        from: 11_350,
        to: 12_950,
        error: { code: 'permission_denied', params: { scope: 'table' }, attempt: 1 },
      },
    ],
  });
  await page.goto(`/b/${demo.baseId}/automations/${tape.id}/runs?run=${run}`);
  const detail = page.getByTestId('run-detail');
  const strip = detail.getByTestId('run-tape');
  await expect(strip).toBeVisible();

  // Order and color: succeeded, succeeded (with a retry dot), failed — left to right.
  const segments = ['act_find', 'act_update', 'act_create'].map((action) =>
    strip.getByTestId(`run-tape-segment-${action}`),
  );
  const statuses = await Promise.all(
    segments.map((segment) => segment.getAttribute('data-status')),
  );
  expect(statuses).toEqual(['succeeded', 'succeeded', 'failed']);
  const lefts = await Promise.all(
    segments.map(async (segment) => (await segment.boundingBox())?.x ?? -1),
  );
  expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
  const colors = await Promise.all(
    segments.map((segment) => segment.evaluate((node) => getComputedStyle(node).backgroundColor)),
  );
  expect(colors).toEqual([
    await tokenColor(page, '--success'),
    await tokenColor(page, '--success'),
    await tokenColor(page, '--danger'),
  ]);
  await expect(strip.getByTestId('run-tape-dot-retry-act_update')).toBeAttached();
  // The playhead starts at the end: the failed step, 13.0 / 13.0 s.
  await expect(strip.getByTestId('run-tape-card')).toContainText('Step 3 · Create record');
  await expect(strip.getByTestId('run-tape-time')).toHaveText('13.0 / 13.0 s');
  await expectNoSeriousA11yViolations(page, 'run drawer with the tape');

  // Drag the playhead from the start to step 2: its card, its row marked, its output in view.
  const track = strip.getByTestId('run-tape-track');
  const box = await track.boundingBox();
  const target = await segments[1]?.boundingBox();
  if (box === null || target === null || target === undefined) throw new Error('No tape.');
  await page.mouse.move(box.x + 14, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, box.y + 15, { steps: 8 });
  await page.mouse.up();
  await expect(strip.getByTestId('run-tape-card')).toContainText('Step 2 · Update record');
  await expect(strip.getByTestId('run-tape-card')).toContainText('Attempt 2');
  const row = detail.getByTestId('run-step-act_update');
  await expect(row).toHaveAttribute('aria-current', 'step');
  await expect(detail.getByTestId('step-output-act_update')).toContainText(triggerId);
  await expect(detail.getByTestId('step-output-act_update')).toBeInViewport();
  await expect(detail.getByTestId('run-step-act_find')).not.toHaveAttribute('aria-current');

  // Keyboard: Home, → step to step (the slider names the step and the time), Space plays.
  await track.focus();
  await page.keyboard.press('Home');
  await expect(track).toHaveAttribute(
    'aria-valuetext',
    /^Step 1 · Find records, Succeeded, 0\.0 s of 13\.0 s$/u,
  );
  await page.keyboard.press('ArrowRight');
  await expect(track).toHaveAttribute(
    'aria-valuetext',
    /^Step 2 · Update record, Succeeded, 10\.4 s/u,
  );
  await expect(row).toHaveAttribute('aria-current', 'step');
  await page.keyboard.press('ArrowRight');
  await expect(track).toHaveAttribute('aria-valuetext', /^Step 3 · Create record, Failed/u);
  await page.keyboard.press('ArrowLeft');
  await expect(track).toHaveAttribute('aria-valuetext', /^Step 2 · Update record/u);
  await page.keyboard.press(' ');
  await expect(strip.getByTestId('run-tape-play')).toHaveAttribute('aria-label', 'Pause');
  await expect(strip.getByTestId('run-tape-play')).toHaveAttribute('aria-label', 'Play', {
    timeout: 10_000,
  });
  await expect(strip.getByTestId('run-tape-time')).toHaveText('13.0 / 13.0 s');
  // Next event from the start lands on step 2; Back to start goes to 0.
  await strip.getByTestId('run-tape-start').click();
  await expect(strip.getByTestId('run-tape-time')).toHaveText('0.0 / 13.0 s');
  await strip.getByTestId('run-tape-next').click();
  await expect(strip.getByTestId('run-tape-card')).toContainText('Step 2 · Update record');

  // Reduced motion: Play shows the end at once.
  await strip.getByTestId('run-tape-start').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await strip.getByTestId('run-tape-play').click();
  await expect(strip.getByTestId('run-tape-time')).toHaveText('13.0 / 13.0 s');
  await expect(strip.getByTestId('run-tape-play')).toHaveAttribute('aria-label', 'Play');
  await expect(detail.getByTestId('run-step-act_create')).toHaveAttribute('aria-current', 'step');
  expect(csp).toEqual([]);
  await context.close();
});

test('run tape: a run waiting in a delay; phones', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser, { width: 375, height: 812 });
  const definition = {
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
      { id: 'act_wait', type: 'delay', config: { minutes: 60 } },
    ],
  };
  const waiting = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E tape wait ${RUN}`,
    enabled: false,
    definition,
  });
  const run = runId('TapeWait');
  await insertRun({
    id: run,
    automation: waiting.id,
    status: 'waiting',
    ago: 120_000,
    end: null,
    definition,
    steps: [
      {
        action: 'act_find',
        type: 'find_records',
        status: 'succeeded',
        from: 40,
        to: 380,
        output: { count: 0, truncated: false, records: [] },
      },
      {
        action: 'act_wait',
        type: 'delay',
        status: 'waiting',
        from: 400,
        to: null,
        output: { until: new Date(Date.now() + 58 * 60_000).toISOString() },
      },
    ],
  });
  await page.goto(`/b/${demo.baseId}/automations/${waiting.id}/runs?run=${run}`);
  const strip = page.getByTestId('run-tape');
  await expect(strip).toBeVisible();
  // The wait runs to the last poll, with its dot; the card says until when.
  await expect(strip.getByTestId('run-tape-segment-act_wait')).toHaveAttribute(
    'data-status',
    'waiting',
  );
  await expect(strip.getByTestId('run-tape-segment-act_wait')).toHaveCSS(
    'background-color',
    await tokenColor(page, '--warning'),
  );
  await expect(strip.getByTestId('run-tape-dot-waiting-act_wait')).toBeAttached();
  await expect(strip.getByTestId('run-tape-card')).toContainText('Waiting until');
  // 375 px: no horizontal scroll, the tape is a full touch target.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  expect(
    (await strip.getByTestId('run-tape-track').boundingBox())?.height ?? 0,
  ).toBeGreaterThanOrEqual(44);
  await expectNoSeriousA11yViolations(page, 'run tape at 375 px');
  // Home: step 1, its row scrolled into view under the tape.
  await strip.getByTestId('run-tape-track').focus();
  await page.keyboard.press('Home');
  await expect(strip.getByTestId('run-tape-card')).toContainText('Step 1 · Find records');
  const first = page.getByTestId('run-step-act_find');
  await expect(first).toHaveAttribute('aria-current', 'step');
  await expect(first).toBeInViewport({ ratio: 1 });
  await context.close();
});
