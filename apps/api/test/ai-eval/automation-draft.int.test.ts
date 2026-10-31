/**
 * Opt-in eval of "Create an automation with AI" with a real model (BACKLOG
 * T908, S8 milestone risk 1; T917 extends `test/ai-eval/**`):
 *
 *   S8_AI_EVAL=1 S8_AI_BASE_URL=http://localhost:11434/v1 S8_AI_MODEL=qwen2.5:7b-instruct \
 *     pnpm --filter @cellhive/api test:int test/ai-eval/automation-draft
 *
 * `S8_AI_API_KEY` (optional), `S8_AI_OUTPUT` (`auto` | `json_schema` |
 * `json_object` | `prompt`, default `auto`). Never in CI: it calls the
 * provider for real. Each of the 20 sentences goes through the real route
 * as a base admin on the CONTRACTS §5 fixture (+ `Phụ trách`, a form and a
 * bot); a draft counts when the route answers `200` and the definition does
 * what the sentence asks (or warns where drafts cannot). The score and every
 * failure are printed; below 12/20 the test fails — narrow the draft's
 * triggers/actions or name a minimum model (BACKLOG S8 risk 1).
 */
import { type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from '../int/database.js';
import { buildRecordFixture, type RecordFixture } from '../int/record-fixture.js';
import { startTestApp, type TestApp } from '../int/support.js';

const PASS_MARK = 12;
const env = process.env;

interface Node {
  readonly field?: string;
  readonly operator?: string;
  readonly value?: unknown;
  readonly items?: readonly Node[];
  readonly item?: Node;
}
interface Action {
  readonly type: string;
  readonly config: Record<string, unknown>;
}
interface Draft {
  readonly definition: {
    readonly trigger: Record<string, unknown> & { readonly type: string };
    readonly condition: Node | null;
    readonly actions: readonly Action[];
  };
  readonly warnings: readonly { readonly code: string }[];
}

const nodes = (node: Node | null | undefined): Node[] =>
  node === null || node === undefined
    ? []
    : [node, ...(node.items ?? []).flatMap(nodes), ...nodes(node.item)];

describe.skipIf(env['S8_AI_EVAL'] !== '1')('AI automation draft eval (T908)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let assignee: Id<'fld'>;
  let form: Id<'viw'>;
  let bot: Id<'sec'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const option = (field: string, name: string) =>
    (fx.fld[field]?.options as { options: { id: string; name: string }[] }).options.find(
      (item) => item.name === name,
    )?.id;

  // --- What a draft must do -------------------------------------------------------------
  const on = (d: Draft, type: string, table: Id<'tbl'>) =>
    d.definition.trigger.type === type && d.definition.trigger['table_id'] === table;
  const watches = (d: Draft, field: Id<'fld'>) =>
    (d.definition.trigger['watch_fields'] as string[] | undefined)?.includes(field) === true;
  const changedTo = (d: Draft, field: Id<'fld'>, value: unknown) =>
    nodes(d.definition.condition).some(
      (node) => node.field === field && node.operator === 'changed_to' && node.value === value,
    );
  const conditionOn = (d: Draft, field: Id<'fld'>, operator: string) =>
    [...nodes(d.definition.condition), ...nodes(d.definition.trigger['condition'] as Node)].some(
      (node) => node.field === field && node.operator === operator,
    );
  const action = (d: Draft, type: string) =>
    d.definition.actions.find((item) => item.type === type);
  const notifies = (d: Draft, field: Id<'fld'>) =>
    d.definition.actions.some(
      (item) =>
        (item.type === 'send_notification' || item.type === 'send_email') &&
        JSON.stringify(item.config['recipients'] ?? item.config['to']).includes(field),
    );
  const telegram = (d: Draft) => action(d, 'send_telegram')?.config['secret_id'] === bot;
  const cron = (d: Draft, expression: string) =>
    d.definition.trigger.type === 'schedule' &&
    String(d.definition.trigger['cron']).replace(/\s+/gu, ' ') === expression;
  const warns = (d: Draft, ...codes: string[]) =>
    d.warnings.some((warning) => codes.includes(warning.code));
  const writes = (d: Draft, type: string, field: Id<'fld'>) =>
    JSON.stringify(action(d, type)?.config['fields'] ?? {}).includes(field);

  const cases: readonly { readonly prompt: string; readonly ok: (d: Draft) => boolean }[] = [
    {
      // The milestone sentence (Quyết định S8 #6).
      prompt: 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách',
      ok: (d) =>
        on(d, 'record.updated', fx.tickets.id) &&
        watches(d, F('ticketStatus')) &&
        changedTo(d, F('ticketStatus'), option('ticketStatus', 'Đã xong')) &&
        action(d, 'send_notification') !== undefined &&
        notifies(d, assignee),
    },
    {
      prompt: 'When a ticket status becomes Đã xong, notify the person in charge (Phụ trách)',
      ok: (d) =>
        on(d, 'record.updated', fx.tickets.id) &&
        changedTo(d, F('ticketStatus'), option('ticketStatus', 'Đã xong')) &&
        notifies(d, assignee),
    },
    {
      prompt: 'Khi có ticket mới thì thông báo cho người phụ trách',
      ok: (d) => on(d, 'record.created', fx.tickets.id) && notifies(d, assignee),
    },
    {
      prompt: 'Khi đơn hàng chuyển sang Xong thì báo cho owner',
      ok: (d) =>
        on(d, 'record.updated', fx.orders.id) &&
        changedTo(d, F('status'), option('status', 'Xong')) &&
        notifies(d, F('owner')),
    },
    {
      prompt:
        'Mỗi sáng thứ Hai lúc 8 giờ, gửi tin nhắn vào nhóm Telegram -1001234567890 bằng Bot nhóm để nhắc họp tuần',
      ok: (d) => cron(d, '0 8 * * 1') && telegram(d),
    },
    {
      prompt: 'Một ngày trước hạn của ticket, nhắc người phụ trách',
      ok: (d) =>
        on(d, 'record.date_reached', fx.tickets.id) &&
        d.definition.trigger['field_id'] === F('due') &&
        d.definition.trigger['offset_minutes'] === -1440 &&
        notifies(d, assignee),
    },
    {
      prompt: 'Khi ticket chuyển Đã xong thì tạo một đơn hàng mới có title là tiêu đề của ticket',
      ok: (d) =>
        on(d, 'record.updated', fx.tickets.id) &&
        action(d, 'create_record')?.config['table_id'] === fx.orders.id &&
        writes(d, 'create_record', F('title')),
    },
    {
      prompt: 'Khi ticket có số tiền lớn hơn 10 triệu thì báo người phụ trách',
      ok: (d) =>
        d.definition.trigger['table_id'] === fx.tickets.id &&
        conditionOn(d, F('ticketAmount'), 'gt') &&
        notifies(d, assignee),
    },
    {
      prompt: 'Khi ticket mới được tạo thì đặt trạng thái là Mới',
      ok: (d) =>
        on(d, 'record.created', fx.tickets.id) && writes(d, 'update_record', F('ticketStatus')),
    },
    {
      prompt: 'Khi ticket chuyển Đang xử lý, đợi 2 tiếng rồi nhắc người phụ trách',
      ok: (d) =>
        changedTo(d, F('ticketStatus'), option('ticketStatus', 'Đang xử lý')) &&
        action(d, 'delay')?.config['minutes'] === 120 &&
        notifies(d, assignee),
    },
    {
      prompt: 'Khi ticket xong thì gọi webhook https://example.com/hook',
      ok: (d) => warns(d, 'unsupported_action'),
    },
    {
      prompt: 'Xoá ticket khi trạng thái là Đã xong',
      ok: (d) => warns(d, 'unsupported_action'),
    },
    {
      prompt: 'Khi khách hàng mới được thêm thì gửi email cho khách hàng đó',
      ok: (d) =>
        on(d, 'record.created', fx.customers.id) && warns(d, 'unsupported_action', 'ambiguous'),
    },
    {
      prompt: 'Every day at 18:00 post "Đóng ca" to the Telegram chat @cellhive_ops with Bot nhóm',
      ok: (d) => cron(d, '0 18 * * *') && telegram(d),
    },
    {
      prompt: 'When an order is created, email its owner',
      ok: (d) => on(d, 'record.created', fx.orders.id) && notifies(d, F('owner')),
    },
    {
      prompt: 'Khi đơn hàng được tạo với amount trên 5 triệu thì báo owner',
      ok: (d) =>
        d.definition.trigger['table_id'] === fx.orders.id &&
        conditionOn(d, F('amount'), 'gt') &&
        notifies(d, F('owner')),
    },
    {
      prompt: 'Khi tiêu đề ticket thay đổi thì báo người phụ trách',
      ok: (d) =>
        on(d, 'record.updated', fx.tickets.id) &&
        watches(d, F('ticketTitle')) &&
        notifies(d, assignee),
    },
    {
      prompt: 'Khi đơn hàng chuyển sang Xong thì tạo một ticket mới có tiêu đề là title của đơn',
      ok: (d) =>
        on(d, 'record.updated', fx.orders.id) &&
        action(d, 'create_record')?.config['table_id'] === fx.tickets.id &&
        writes(d, 'create_record', F('ticketTitle')),
    },
    {
      prompt: 'Ngày 1 hằng tháng lúc 9 giờ, nhắc nhóm Telegram @cellhive_ops qua Bot nhóm chốt sổ',
      ok: (d) => cron(d, '0 9 1 * *') && telegram(d),
    },
    {
      prompt: 'Khi có ticket gửi qua form Gửi ticket thì báo người phụ trách',
      ok: (d) =>
        d.definition.trigger.type === 'form.submitted' &&
        d.definition.trigger['view_id'] === form &&
        notifies(d, assignee),
    },
  ];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    const url = new URL(env['S8_AI_BASE_URL'] ?? '');
    // `localhost` → 127.0.0.1, where Ollama and llama.cpp listen by default (not `::1`).
    t = await startTestApp(
      { DATABASE_URL: database.url },
      url.hostname === 'localhost' ? { outboundLookup: () => Promise.resolve(['127.0.0.1']) } : {},
    );
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };

    const field = await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'Phụ trách',
      type: 'user',
    });
    assignee = field.json<{ id: Id<'fld'> }>().id;
    const view = await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/views`, {
      name: 'Gửi ticket',
      type: 'form',
    });
    form = view.json<{ id: Id<'viw'> }>().id;
    const secret = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'telegram_bot',
      name: 'Bot nhóm',
      // Obviously fake: the eval never sends a message.
      value: '000000000:FAKE_TEST_TOKEN_not_a_real_bot_000000',
      base_scope: 'all',
    });
    bot = secret.json<{ id: Id<'sec'> }>().id;

    // A provider on the machine or the network needs its allowlist entry (CONTRACTS §25.4).
    await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`,
    });
    const settings = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: env['S8_AI_BASE_URL'],
      model: env['S8_AI_MODEL'],
      api_key: env['S8_AI_API_KEY'] === undefined ? null : { value: env['S8_AI_API_KEY'] },
      structured_output: env['S8_AI_OUTPUT'] ?? 'auto',
      request_timeout_seconds: 120,
    });
    expect(settings.statusCode, settings.body).toBe(200);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it(`drafts at least ${String(PASS_MARK)} of ${String(cases.length)} sentences`, async () => {
    const lines: string[] = [];
    let passed = 0;
    for (const [index, item] of cases.entries()) {
      const started = performance.now();
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/ai/automation-draft`, {
        prompt: item.prompt,
      });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const ok = response.statusCode === 200 && item.ok(response.json<Draft>());
      if (ok) passed += 1;
      lines.push(
        `${ok ? 'PASS' : 'FAIL'} #${String(index + 1)} ${seconds}s ${item.prompt}` +
          (ok ? '' : `\n     ${String(response.statusCode)} ${response.body.slice(0, 2000)}`),
      );
    }
    process.stdout.write(
      `\nAI automation draft eval — ${String(env['S8_AI_MODEL'])}: ${String(passed)}/${String(cases.length)}\n${lines.join('\n')}\n`,
    );
    expect(passed).toBeGreaterThanOrEqual(PASS_MARK);
  });
});
