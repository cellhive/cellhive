import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { apiSignIn, ok } from './support';

/**
 * T204: the realtime client between browser contexts on the demo base
 * (CONTRACTS §5 fixture, §9 seed). Edits are made through the API from one
 * context (the grid editors are T203's); the other contexts only watch
 * their grid, fed by the WebSocket.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const EMAIL = {
  admin: WORKER_ORG.email('admin'),
  editor: WORKER_ORG.email('editor'),
  sales1: WORKER_ORG.email('sales1'),
  sales2: WORKER_ORG.email('sales2'),
} as const;
/** Edits measured for the two-tab latency budget (FRONTEND §11.1: < 1 s p95). */
const LATENCY_SAMPLES = 20;

interface Session {
  context: BrowserContext;
  page: Page;
  userId: string;
  /** Every WebSocket text frame the page received. */
  frames: string[];
}

async function openSession(browser: Browser, email: string): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  // Demo users have the Vietnamese profile locale; this device picks English.
  await context.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  const page = await context.newPage();
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') frames.push(frame.payload);
    });
  });
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  const me = await ok<{ user: { id: string } }>(page, 'GET', '/me');
  return { context, page, userId: me.user.id, frames };
}

interface Demo {
  baseId: string;
  orders: string;
  customers: string;
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
      const base = bases.items.find((item) => item.name === DEMO_BASE);
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { baseId: base.id, orders: id('Orders'), customers: id('Customers') };
    }
  }
  throw new Error('demo base not found');
}

interface OrderRow {
  id: string;
  version: number;
  fields: { [name: string]: unknown; owner?: { id: string }[] };
}

/** The demo order's title (primary field, by name). */
function titleOf(row: OrderRow): string {
  const title = row.fields[DEMO_ORDER_TITLE];
  return typeof title === 'string' ? title : '';
}

async function firstOrders(page: Page, tableId: string, limit: number): Promise<OrderRow[]> {
  const list = await ok<{ records: OrderRow[] }>(
    page,
    'POST',
    `/tables/${tableId}/records/query?field_key_type=name`,
    { limit, include_total: false },
  );
  return list.records;
}

async function setTitle(page: Page, tableId: string, recordId: string, title: string) {
  await ok(page, 'PATCH', `/tables/${tableId}/records/${recordId}?field_key_type=name`, {
    fields: { [DEMO_ORDER_TITLE]: title },
  });
}

function cells(page: Page) {
  return page.locator('table[role="grid"] td[role="gridcell"]');
}

function footerCount(page: Page) {
  return page.getByRole('status').filter({ hasText: /records?$/u });
}

async function rowCount(page: Page): Promise<number> {
  const text = (await footerCount(page).textContent()) ?? '';
  return Number(text.replace(/[^0-9]/gu, ''));
}

async function openGrid(session: Session, demo: Demo) {
  await session.page.goto(`/b/${demo.baseId}/t/${demo.orders}`);
  await expect(session.page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(footerCount(session.page)).toBeVisible();
  await expect(cells(session.page).first()).toBeAttached();
  // Subscribed: the server confirmed `table:{id}`.
  await expect
    .poll(() => session.frames.some((frame) => frame.includes(`"table:${demo.orders}"`)))
    .toBe(true);
}

/** Resolves with `Date.now()` when a grid cell shows `text` (MutationObserver, no polling delay). */
function whenShown(page: Page, text: string): Promise<number> {
  return page.evaluate(
    (wanted) =>
      new Promise<number>((resolve) => {
        const shown = () =>
          [...document.querySelectorAll('table[role="grid"] td[role="gridcell"]')].some((cell) =>
            cell.textContent.includes(wanted),
          );
        if (shown()) {
          resolve(Date.now());
          return;
        }
        const observer = new MutationObserver(() => {
          if (shown()) {
            observer.disconnect();
            resolve(Date.now());
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      }),
    text,
  );
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

test.describe('T204 realtime client', () => {
  test.describe.configure({ timeout: 180_000 });

  let demo: Demo;
  let admin: Session;
  let editor: Session;
  const restore: (() => Promise<void>)[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    admin = await openSession(browser, EMAIL.admin);
    editor = await openSession(browser, EMAIL.editor);
    demo = await findDemo(admin.page);
  });

  test.afterAll(async () => {
    for (const undo of restore.reverse()) await undo();
    await admin.context.close();
    await editor.context.close();
  });

  test('an edit in one tab shows in the other in < 1 s p95', async () => {
    await openGrid(editor, demo);
    const [first] = await firstOrders(admin.page, demo.orders, 1);
    if (first === undefined) throw new Error('no order');
    const original = titleOf(first);
    restore.push(() => setTitle(admin.page, demo.orders, first.id, original));

    const latencies: number[] = [];
    for (let sample = 0; sample < LATENCY_SAMPLES; sample += 1) {
      const title = `RT ${String(sample)} ${original}`;
      const seen = whenShown(editor.page, title);
      const sent = await admin.page.evaluate(() => Date.now());
      await setTitle(admin.page, demo.orders, first.id, title);
      latencies.push((await seen) - sent);
    }
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);
    test.info().annotations.push({
      type: 'realtime latency (ms)',
      description: `p50 ${String(p50)}, p95 ${String(p95)}, max ${String(max)}; samples ${latencies.join(', ')}`,
    });
    process.stdout.write(
      `[T204] two-tab latency ms: p50=${String(p50)} p95=${String(p95)} max=${String(max)}\n`,
    );
    expect(p95).toBeLessThan(1000);
  });

  test('P22/P24 on the client: out-of-scope edits are silent, ownership moves rows', async ({
    browser,
  }) => {
    const sales1 = await openSession(browser, EMAIL.sales1);
    const sales2 = await openSession(browser, EMAIL.sales2);
    try {
      await openGrid(sales1, demo);
      await openGrid(sales2, demo);
      const [r1] = await firstOrders(sales1.page, demo.orders, 1);
      const [r2] = await firstOrders(sales2.page, demo.orders, 1);
      if (r1 === undefined || r2 === undefined) throw new Error('no orders for sales');
      const r1Title = titleOf(r1);

      await test.step('P22: u_editor edits r2 (owner u_sales2): u_sales1 receives nothing', async () => {
        const before = sales1.frames.length;
        await setTitle(editor.page, demo.orders, r2.id, `${titleOf(r2)} (P22)`);
        restore.push(() => setTitle(admin.page, demo.orders, r2.id, titleOf(r2)));
        // u_sales2 sees it, so the change was published…
        await expect(cells(sales2.page).filter({ hasText: '(P22)' })).toHaveCount(1);
        // …and nothing about r2 reached u_sales1.
        await sales1.page.waitForTimeout(500);
        expect(sales1.frames.slice(before).filter((frame) => frame.includes(r2.id))).toEqual([]);
      });

      await test.step('subscribing to a table without access answers NOT_FOUND', async () => {
        const answer = await sales1.page.evaluate(
          (channel) =>
            new Promise<unknown>((resolve) => {
              const socket = new WebSocket(`${location.origin.replace(/^http/u, 'ws')}/ws`);
              socket.onopen = () => {
                socket.send(JSON.stringify({ type: 'subscribe', channel, req_id: 'x1' }));
              };
              socket.onmessage = (event) => {
                resolve(JSON.parse(String(event.data)));
                socket.close();
              };
            }),
          `table:${demo.customers}`,
        );
        expect(answer).toEqual({
          type: 'error',
          req_id: 'x1',
          code: 'NOT_FOUND',
          channel: `table:${demo.customers}`,
        });
      });

      await test.step('P24: r1 moves from u_sales1 to u_sales2', async () => {
        const count1 = await rowCount(sales1.page);
        const count2 = await rowCount(sales2.page);
        await expect(cells(sales1.page).filter({ hasText: r1Title }).first()).toBeAttached();
        await ok(
          editor.page,
          'PATCH',
          `/tables/${demo.orders}/records/${r1.id}?field_key_type=name`,
          {
            fields: { owner: [{ id: sales2.userId }] },
          },
        );
        restore.push(async () => {
          await ok(
            admin.page,
            'PATCH',
            `/tables/${demo.orders}/records/${r1.id}?field_key_type=name`,
            {
              fields: { owner: [{ id: sales1.userId }] },
            },
          );
        });
        // u_sales1: the row leaves the grid and the count drops.
        await expect(footerCount(sales1.page)).toHaveText(
          `${(count1 - 1).toLocaleString('en-US')} records`,
        );
        await expect(cells(sales1.page).filter({ hasText: r1Title })).toHaveCount(0);
        expect(sales1.frames.some((frame) => frame.includes('record.removed_from_view'))).toBe(
          true,
        );
        // u_sales2: announced by the pill, loaded on click.
        const pill = sales2.page.getByTestId('new-rows-pill');
        await expect(pill).toHaveText('1 new row');
        await pill.click();
        await expect(pill).toBeHidden();
        await expect(footerCount(sales2.page)).toHaveText(
          `${(count2 + 1).toLocaleString('en-US')} records`,
        );
      });
    } finally {
      await sales1.context.close();
      await sales2.context.close();
    }
  });

  test('offline for 10 s, then the grid matches the server again', async () => {
    await openGrid(editor, demo);
    const rows = await firstOrders(admin.page, demo.orders, 3);
    for (const row of rows) {
      const original = titleOf(row);
      restore.push(() => setTitle(admin.page, demo.orders, row.id, original));
    }
    await editor.context.setOffline(true);
    await expect(editor.page.getByTestId('connection-banner')).toContainText('You are offline');
    for (const [index, row] of rows.entries()) {
      await setTitle(admin.page, demo.orders, row.id, `Offline ${String(index)} ${titleOf(row)}`);
    }
    await editor.page.waitForTimeout(10_000);
    await editor.context.setOffline(false);
    // The client reconnects at once and refetches what it shows.
    const server = await firstOrders(admin.page, demo.orders, 3);
    for (const row of server) {
      await expect(
        cells(editor.page)
          .filter({ hasText: titleOf(row) })
          .first(),
      ).toBeAttached({
        timeout: 15_000,
      });
    }
    await expect(editor.page.getByTestId('connection-banner')).toBeEmpty();
  });

  test('the record panel follows edits and closes when its record is deleted', async () => {
    const [first] = await firstOrders(admin.page, demo.orders, 1);
    if (first === undefined) throw new Error('no order');
    const original = titleOf(first);
    restore.push(() => setTitle(admin.page, demo.orders, first.id, original));
    editor.frames.length = 0;
    await editor.page.goto(`/b/${demo.baseId}/t/${demo.orders}?record=${first.id}`);
    await expect(editor.page.getByRole('dialog', { name: original })).toBeVisible();
    await expect
      .poll(() => editor.frames.some((frame) => frame.includes(`"table:${demo.orders}"`)))
      .toBe(true);

    const title = `Panel RT ${original}`;
    await setTitle(admin.page, demo.orders, first.id, title);
    await expect(editor.page.getByRole('dialog', { name: title })).toBeVisible();

    await ok(admin.page, 'DELETE', `/tables/${demo.orders}/records/${first.id}`);
    // Restored before the title is put back (the undo list runs backwards).
    restore.push(async () => {
      await ok(admin.page, 'POST', `/tables/${demo.orders}/records/restore`, { ids: [first.id] });
    });
    await expect(editor.page.getByRole('dialog', { name: title })).toBeHidden();
    await expect(
      editor.page.getByText('This record was deleted or is no longer available to you.'),
    ).toBeVisible();
    await expect(editor.page).not.toHaveURL(/record=/u);
  });

  test('a field added in one tab appears as a column in the other', async () => {
    await openGrid(editor, demo);
    const name = `Ghi chú RT ${String(Date.now() % 10_000)}`;
    const field = await ok<{ id: string }>(admin.page, 'POST', `/tables/${demo.orders}/fields`, {
      name,
      type: 'text',
    });
    restore.push(async () => {
      await ok(admin.page, 'DELETE', `/fields/${field.id}`);
    });
    // S4b added computed columns to the demo Orders: a new field is appended
    // past the viewport, and the grid renders headers of visible columns only.
    // Scroll it into view before asking for its header.
    await editor.page.evaluate(() => {
      document.querySelector<HTMLElement>('.ob-grid .dvn-scroller')?.scrollTo({
        left: 9_999_999,
      });
    });
    await expect(
      editor.page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name }),
    ).toBeAttached();
  });

  test('QA (T303): a new row scrolled into view is shown and counted; deleting it restores the count', async ({
    browser,
  }) => {
    const sales1 = await openSession(browser, EMAIL.sales1);
    try {
      await openGrid(sales1, demo);
      const before = await rowCount(sales1.page);
      const title = `QA new row ${String(Date.now() % 100_000)}`;
      const created = await ok<{ records: { id: string }[] }>(
        admin.page,
        'POST',
        `/tables/${demo.orders}/records?field_key_type=name`,
        { records: [{ fields: { [DEMO_ORDER_TITLE]: title, owner: [{ id: sales1.userId }] } }] },
      );
      const id = created.records[0]?.id ?? '';
      let deleted = false;
      restore.push(async () => {
        if (!deleted) await ok(admin.page, 'DELETE', `/tables/${demo.orders}/records/${id}`);
      });
      const pill = sales1.page.getByTestId('new-rows-pill');
      await expect(pill).toHaveText('1 new row');
      await expect(footerCount(sales1.page)).toHaveText(
        `${before.toLocaleString('en-US')} records`,
      );
      // Scrolled to the bottom (without the pill): the new row loads, shows and counts.
      await expect
        .poll(async () => {
          await sales1.page.evaluate(() => {
            const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
            if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
          });
          return cells(sales1.page).filter({ hasText: title }).count();
        })
        .toBe(1);
      await expect(pill).toBeHidden();
      await expect(footerCount(sales1.page)).toHaveText(
        `${(before + 1).toLocaleString('en-US')} records`,
      );
      // Deleted by admin: the row leaves and the count is the server's again.
      await ok(admin.page, 'DELETE', `/tables/${demo.orders}/records/${id}`);
      deleted = true;
      await expect(cells(sales1.page).filter({ hasText: title })).toHaveCount(0);
      await expect(footerCount(sales1.page)).toHaveText(
        `${before.toLocaleString('en-US')} records`,
      );
      await sales1.page.reload();
      await expect(footerCount(sales1.page)).toHaveText(
        `${before.toLocaleString('en-US')} records`,
      );
    } finally {
      await sales1.context.close();
    }
  });

  test('T303: a 1 000-record bulk edit reaches each tab as one record.batch, filtered per role', async ({
    browser,
  }) => {
    const sales1 = await openSession(browser, EMAIL.sales1);
    const bulkTitles = (rows: readonly { id: string; title: string }[]) =>
      ok(admin.page, 'PATCH', `/tables/${demo.orders}/records?field_key_type=name`, {
        records: rows.map((row) => ({ id: row.id, fields: { [DEMO_ORDER_TITLE]: row.title } })),
      });
    try {
      await openGrid(editor, demo);
      await openGrid(sales1, demo);
      const rows = await firstOrders(admin.page, demo.orders, 1_000);
      expect(rows).toHaveLength(1_000);
      const originals = rows.map((row) => ({ id: row.id, title: titleOf(row) }));
      restore.push(async () => {
        await bulkTitles(originals);
      });
      const readable = new Set(
        rows
          .filter((row) => row.fields.owner?.some((owner) => owner.id === sales1.userId))
          .map((row) => row.id),
      );
      const recordFrames = (session: Session) =>
        session.frames
          .filter((frame) => frame.includes('"type":"record.'))
          .map((frame) => JSON.parse(frame) as Record<string, unknown>);

      const rounds = 5;
      const latencies: number[] = [];
      const afterResponse: number[] = [];
      for (let round = 0; round < rounds; round += 1) {
        editor.frames.length = 0;
        sales1.frames.length = 0;
        const label = `Bulk ${String(round)}`;
        const first = originals[0] as { id: string; title: string };
        const seen = whenShown(editor.page, `${label} ${first.title}`);
        const sent = await admin.page.evaluate(() => Date.now());
        await bulkTitles(originals.map((row) => ({ id: row.id, title: `${label} ${row.title}` })));
        const answered = await admin.page.evaluate(() => Date.now());
        const shown = await seen;
        latencies.push(shown - sent);
        afterResponse.push(Math.max(0, shown - answered));
        await editor.page.waitForTimeout(300);

        // u_editor reads all 1 000 records: exactly one message for the write.
        expect(recordFrames(editor)).toEqual([
          expect.objectContaining({ type: 'record.batch', count: 1_000 }),
        ]);
        // u_sales1: only its own records, one message per record below the threshold.
        const frames = recordFrames(sales1);
        if (readable.size > 100) {
          expect(frames).toEqual([
            expect.objectContaining({ type: 'record.batch', count: readable.size }),
          ]);
        } else {
          expect(frames).toHaveLength(readable.size);
          for (const frame of frames) expect(readable.has(String(frame.record_id))).toBe(true);
        }
      }
      const p50 = percentile(afterResponse, 50);
      const p95 = percentile(afterResponse, 95);
      process.stdout.write(
        `[T303] bulk PATCH 1000 → grid of the other tab: write + refetch ms ` +
          `${latencies.join(', ')}; after the HTTP answer p50=${String(p50)} p95=${String(p95)}; ` +
          `messages per write: editor 1, sales1 ${String(readable.size > 100 ? 1 : readable.size)}\n`,
      );
      expect(p95).toBeLessThan(1_000);
    } finally {
      await sales1.context.close();
    }
  });
});
