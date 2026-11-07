/**
 * Opt-in eval of "Create an automation with AI" (BACKLOG T908, S8 milestone
 * risk 1; T917 moved it onto the demo data and the shared harness — how to
 * run: `test/ai-eval/README.md`): 20 sentences on the demo base as its admin,
 * record data on (the AI steps may be drafted). A draft counts when the
 * route answers `200` and the definition does what the sentence asks — the
 * trigger, table, watched fields, `changed_to`, condition, recipients, cron,
 * bot, form, target fields after the server turned names into ids — or
 * warns where drafts cannot (`unsupported_action` / `ambiguous`). The
 * milestone sentence must also draft no `send_telegram` and save **off**
 * through `POST /bases/:id/automations` (Quyết định S8 #6, #7).
 */
import { type FakeOpenAiReply } from '@cellhive/server-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AI_EVAL,
  expectVerdict,
  runSuite,
  SETUP_TIMEOUT_MS,
  startEval,
  SUITE_TIMEOUT_MS,
  type EvalCase,
  type EvalStack,
} from './harness.js';

import type { LightMyRequestResponse } from 'fastify';

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

interface DraftCase extends EvalCase {
  readonly ok: (d: Draft, s: EvalStack) => boolean | Promise<boolean>;
}

const BOT = 'Bot CSKH (demo)';
const FORM = 'Gửi yêu cầu hỗ trợ';

// --- what the model answers, by name (CONTRACTS §29.3) ----------------------------------------

const trigger = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  table: null,
  watch_fields: null,
  changed_to: null,
  form: null,
  cron: null,
  date_field: null,
  offset_minutes: null,
  ...extra,
});
const act = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  table: null,
  fields: null,
  recipients: null,
  title: null,
  text: null,
  bot: null,
  chat_id: null,
  chat_field: null,
  minutes: null,
  prompt: null,
  target_field: null,
  ...extra,
});
const draft = (
  on: ReturnType<typeof trigger>,
  actions: ReturnType<typeof act>[],
  more: { condition?: unknown; warnings?: unknown[] } = {},
): FakeOpenAiReply => ({
  content: JSON.stringify({
    name: 'Bản nháp',
    trigger: on,
    condition: more.condition ?? null,
    actions,
    explanation: 'Gửi qua kênh thông báo của người nhận.',
    warnings: more.warnings ?? [],
  }),
});
const notify = (recipient: string) =>
  act('send_notification', { recipients: [recipient], title: 'Thông báo', text: 'Có thay đổi' });
const doneTicket = trigger('record.updated', {
  table: 'Tickets',
  watch_fields: ['Trạng thái'],
  changed_to: 'Đã xong',
});
const unsupported = { code: 'unsupported_action', message: 'Bản nháp không làm được việc này.' };

// --- what a draft must do -----------------------------------------------------------------------

const nodes = (node: Node | null | undefined): Node[] =>
  node === null || node === undefined
    ? []
    : [node, ...(node.items ?? []).flatMap(nodes), ...nodes(node.item)];
const on = (d: Draft, s: EvalStack, type: string, table: string) =>
  d.definition.trigger.type === type && d.definition.trigger['table_id'] === s.table(table);
const watches = (d: Draft, s: EvalStack, table: string, field: string) =>
  (d.definition.trigger['watch_fields'] as string[] | undefined)?.includes(
    s.field(table, field),
  ) === true;
const changedTo = (d: Draft, s: EvalStack, table: string, field: string, option: string) =>
  nodes(d.definition.condition).some(
    (node) =>
      node.field === s.field(table, field) &&
      node.operator === 'changed_to' &&
      node.value === s.option(table, field, option),
  );
const conditionOn = (d: Draft, s: EvalStack, table: string, field: string, operator: string) =>
  [...nodes(d.definition.condition), ...nodes(d.definition.trigger['condition'] as Node)].some(
    (node) => node.field === s.field(table, field) && node.operator === operator,
  );
const action = (d: Draft, type: string) => d.definition.actions.find((item) => item.type === type);
const notifies = (d: Draft, s: EvalStack, table: string, field: string) =>
  d.definition.actions.some(
    (item) =>
      (item.type === 'send_notification' || item.type === 'send_email') &&
      JSON.stringify(item.config['recipients'] ?? item.config['to']).includes(
        s.field(table, field),
      ),
  );
const telegram = (d: Draft, s: EvalStack) =>
  action(d, 'send_telegram')?.config['secret_id'] === s.secret(BOT);
const cron = (d: Draft, expression: string) =>
  d.definition.trigger.type === 'schedule' &&
  String(d.definition.trigger['cron']).replace(/\s+/gu, ' ') === expression;
const warns = (d: Draft, ...codes: string[]) =>
  d.warnings.some((warning) => codes.includes(warning.code));
const writes = (d: Draft, s: EvalStack, type: string, table: string, field: string) =>
  JSON.stringify(action(d, type)?.config['fields'] ?? {}).includes(s.field(table, field));

/** The milestone draft, saved through the usual route: always off (Quyết định S8 #7). */
async function savedOff(d: Draft, s: EvalStack): Promise<boolean> {
  const saved = await s.call('POST', `/bases/${s.baseId}/automations`, {
    name: `Eval ${String(Date.now())}`,
    definition: d.definition,
  });
  return saved.statusCode === 201 && !saved.json<{ enabled: boolean }>().enabled;
}

const CASES: readonly DraftCase[] = [
  {
    // The milestone sentence (Quyết định S8 #6).
    prompt: 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách',
    ok: async (d, s) =>
      on(d, s, 'record.updated', 'Tickets') &&
      watches(d, s, 'Tickets', 'Trạng thái') &&
      changedTo(d, s, 'Tickets', 'Trạng thái', 'Đã xong') &&
      notifies(d, s, 'Tickets', 'Phụ trách') &&
      action(d, 'send_telegram') === undefined &&
      (await savedOff(d, s)),
    fake: [draft(doneTicket, [notify('Phụ trách')])],
  },
  {
    prompt: 'When a ticket status becomes Đã xong, notify the person in charge (Phụ trách)',
    ok: (d, s) =>
      on(d, s, 'record.updated', 'Tickets') &&
      changedTo(d, s, 'Tickets', 'Trạng thái', 'Đã xong') &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [draft(doneTicket, [notify('Phụ trách')])],
  },
  {
    // Validation run: an unknown recipient first, repaired on the second try.
    prompt: 'Khi có ticket mới thì thông báo cho người phụ trách',
    ok: (d, s) => on(d, s, 'record.created', 'Tickets') && notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(trigger('record.created', { table: 'Tickets' }), [notify('Người phụ trách')]),
      draft(trigger('record.created', { table: 'Tickets' }), [notify('Phụ trách')]),
    ],
  },
  {
    // Validation run: the wrong option — valid, but not what was asked: a fail.
    prompt: 'Khi đơn hàng chuyển sang Xong thì báo cho owner',
    ok: (d, s) =>
      on(d, s, 'record.updated', 'Orders') &&
      changedTo(d, s, 'Orders', 'status', 'Xong') &&
      notifies(d, s, 'Orders', 'owner'),
    fake: [
      draft(
        trigger('record.updated', { table: 'Orders', watch_fields: ['status'], changed_to: 'Mới' }),
        [notify('owner')],
      ),
    ],
    fakePasses: false,
  },
  {
    prompt: `Mỗi sáng thứ Hai lúc 8 giờ, gửi tin nhắn vào nhóm Telegram -1001234567890 bằng ${BOT} để nhắc họp tuần`,
    ok: (d, s) => cron(d, '0 8 * * 1') && telegram(d, s),
    fake: [
      draft(trigger('schedule', { cron: '0 8 * * 1' }), [
        act('send_telegram', { bot: BOT, chat_id: '-1001234567890', text: 'Họp tuần lúc 9 giờ' }),
      ]),
    ],
  },
  {
    prompt: 'Một ngày trước hạn của ticket, nhắc người phụ trách',
    ok: (d, s) =>
      on(d, s, 'record.date_reached', 'Tickets') &&
      d.definition.trigger['field_id'] === s.field('Tickets', 'Hạn') &&
      d.definition.trigger['offset_minutes'] === -1440 &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(
        trigger('record.date_reached', {
          table: 'Tickets',
          date_field: 'Hạn',
          offset_minutes: -1440,
        }),
        [notify('Phụ trách')],
      ),
    ],
  },
  {
    prompt: 'Khi ticket chuyển Đã xong thì tạo một đơn hàng mới có tên là tiêu đề của ticket',
    ok: (d, s) =>
      on(d, s, 'record.updated', 'Tickets') &&
      action(d, 'create_record')?.config['table_id'] === s.table('Orders') &&
      writes(d, s, 'create_record', 'Orders', 'Tên đơn hàng'),
    fake: [
      draft(doneTicket, [
        act('create_record', {
          table: 'Orders',
          fields: [{ field: 'Tên đơn hàng', value: '{{ [Tiêu đề] }}' }],
        }),
      ]),
    ],
  },
  {
    prompt: 'Khi ticket có số tiền lớn hơn 10 triệu thì báo người phụ trách',
    ok: (d, s) =>
      d.definition.trigger['table_id'] === s.table('Tickets') &&
      conditionOn(d, s, 'Tickets', 'Số tiền', 'gt') &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(trigger('record.created', { table: 'Tickets' }), [notify('Phụ trách')], {
        condition: { logic: 'and', conditions: [['Số tiền', '>', 10_000_000]] },
      }),
    ],
  },
  {
    prompt: 'Khi ticket mới được tạo thì đặt trạng thái là Mới',
    ok: (d, s) =>
      on(d, s, 'record.created', 'Tickets') &&
      writes(d, s, 'update_record', 'Tickets', 'Trạng thái'),
    fake: [
      draft(trigger('record.created', { table: 'Tickets' }), [
        act('update_record', { fields: [{ field: 'Trạng thái', value: 'Mới' }] }),
      ]),
    ],
  },
  {
    prompt: 'Khi ticket chuyển Đang xử lý, đợi 2 tiếng rồi nhắc người phụ trách',
    ok: (d, s) =>
      changedTo(d, s, 'Tickets', 'Trạng thái', 'Đang xử lý') &&
      action(d, 'delay')?.config['minutes'] === 120 &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(
        trigger('record.updated', {
          table: 'Tickets',
          watch_fields: ['Trạng thái'],
          changed_to: 'Đang xử lý',
        }),
        [act('delay', { minutes: 120 }), notify('Phụ trách')],
      ),
    ],
  },
  {
    prompt: 'Khi ticket xong thì gọi webhook https://example.com/hook',
    ok: (d) => warns(d, 'unsupported_action'),
    fake: [draft(doneTicket, [], { warnings: [unsupported] })],
  },
  {
    prompt: 'Xoá ticket khi trạng thái là Đã xong',
    ok: (d) => warns(d, 'unsupported_action'),
    fake: [draft(doneTicket, [], { warnings: [unsupported] })],
  },
  {
    prompt: 'Khi khách hàng mới được thêm thì gửi email cho khách hàng đó',
    ok: (d, s) =>
      on(d, s, 'record.created', 'Customers') && warns(d, 'unsupported_action', 'ambiguous'),
    fake: [
      draft(trigger('record.created', { table: 'Customers' }), [], { warnings: [unsupported] }),
    ],
  },
  {
    // An AI step (T911): record data is on in this suite.
    prompt: 'Khi có ticket mới, dùng AI phân loại mức ưu tiên của ticket dựa trên mô tả',
    ok: (d, s) =>
      on(d, s, 'record.created', 'Tickets') &&
      action(d, 'ai_classify')?.config['target_field_id'] === s.field('Tickets', 'Ưu tiên'),
    fake: [
      draft(trigger('record.created', { table: 'Tickets' }), [
        act('ai_classify', {
          prompt: 'Mức ưu tiên của ticket: {{ [Mô tả] }}',
          target_field: 'Ưu tiên',
        }),
      ]),
    ],
  },
  {
    prompt: 'When an order is created, email its owner',
    ok: (d, s) => on(d, s, 'record.created', 'Orders') && notifies(d, s, 'Orders', 'owner'),
    fake: [draft(trigger('record.created', { table: 'Orders' }), [notify('owner')])],
  },
  {
    // Validation run: the condition left out — a fail.
    prompt: 'Khi đơn hàng được tạo với amount trên 5 triệu thì báo owner',
    ok: (d, s) =>
      d.definition.trigger['table_id'] === s.table('Orders') &&
      conditionOn(d, s, 'Orders', 'amount', 'gt') &&
      notifies(d, s, 'Orders', 'owner'),
    fake: [draft(trigger('record.created', { table: 'Orders' }), [notify('owner')])],
    fakePasses: false,
  },
  {
    prompt: 'Khi tiêu đề ticket thay đổi thì báo người phụ trách',
    ok: (d, s) =>
      on(d, s, 'record.updated', 'Tickets') &&
      watches(d, s, 'Tickets', 'Tiêu đề') &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(trigger('record.updated', { table: 'Tickets', watch_fields: ['Tiêu đề'] }), [
        notify('Phụ trách'),
      ]),
    ],
  },
  {
    prompt: 'Khi đơn hàng chuyển sang Xong thì tạo một ticket mới có tiêu đề là tên đơn hàng',
    ok: (d, s) =>
      on(d, s, 'record.updated', 'Orders') &&
      action(d, 'create_record')?.config['table_id'] === s.table('Tickets') &&
      writes(d, s, 'create_record', 'Tickets', 'Tiêu đề'),
    fake: [
      draft(
        trigger('record.updated', {
          table: 'Orders',
          watch_fields: ['status'],
          changed_to: 'Xong',
        }),
        [
          act('create_record', {
            table: 'Tickets',
            fields: [{ field: 'Tiêu đề', value: '{{ [Tên đơn hàng] }}' }],
          }),
        ],
      ),
    ],
  },
  {
    prompt: `Ngày 1 hằng tháng lúc 9 giờ, nhắc nhóm Telegram @cellhive_ops qua ${BOT} chốt sổ`,
    ok: (d, s) => cron(d, '0 9 1 * *') && telegram(d, s),
    fake: [
      draft(trigger('schedule', { cron: '0 9 1 * *' }), [
        act('send_telegram', { bot: BOT, chat_id: '@cellhive_ops', text: 'Chốt sổ tháng' }),
      ]),
    ],
  },
  {
    prompt: `Khi có ticket gửi qua form ${FORM} thì báo người phụ trách`,
    ok: (d, s) =>
      d.definition.trigger.type === 'form.submitted' &&
      d.definition.trigger['view_id'] === s.view('Tickets', FORM) &&
      notifies(d, s, 'Tickets', 'Phụ trách'),
    fake: [
      draft(trigger('form.submitted', { table: 'Tickets', form: FORM }), [notify('Phụ trách')]),
    ],
  },
];

describe.skipIf(!AI_EVAL.on)('AI automation draft eval (T908, T917)', () => {
  let stack: EvalStack;

  beforeAll(async () => {
    stack = await startEval({ suite: 'automation-draft', recordData: true });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack.close();
  });

  it(
    `drafts 20 sentences (pass mark ${String(AI_EVAL.passMark)})`,
    async () => {
      const summary = await runSuite(
        stack,
        'automation-draft',
        CASES,
        (item) =>
          stack.call('POST', `/bases/${stack.baseId}/ai/automation-draft`, { prompt: item.prompt }),
        (item, response: LightMyRequestResponse) => item.ok(response.json<Draft>(), stack),
      );
      expect(summary.total).toBe(20);
      // The milestone sentence is right with every evaluated model (BACKLOG T917).
      expect(summary.results[0]?.pass, 'the milestone sentence').toBe(true);
      expectVerdict(summary, CASES);
    },
    SUITE_TIMEOUT_MS,
  );
});
