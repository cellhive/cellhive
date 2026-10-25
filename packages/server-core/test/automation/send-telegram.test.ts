import {
  automationDefinitionSchema,
  type AutomationDefinitionInput,
  type EffectiveAccess,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  closeCutTelegramHtml,
  telegramChatIdOf,
  TelegramClient,
  validateAutomationDefinition,
  type AutomationFieldMeta,
} from '../../src/automation/index.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const TITLE = 'fld_OrdersTitle00001';
const CHAT = 'fld_OrdersChat000001';
const HIDDEN = 'fld_OrdersHidden0001';
const SEC = 'sec_TelegramBot00001';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

describe('closeCutTelegramHtml (BACKLOG T516)', () => {
  it.each([
    ['closes the open tags, innermost first', 'a <b>bold <i>it…', 'a <b>bold <i>it…</i></b>'],
    ['drops an unfinished tag', 'a <b>x</b> <a href="https://ex…', 'a <b>x</b> …'],
    ['drops an unfinished entity', 'Tom &amp; Jerry &am…', 'Tom &amp; Jerry …'],
    ['keeps closed tags as they are', '<b>x</b> <i>y</i>…', '<b>x</b> <i>y</i>…'],
    ['ignores a stray closing tag', 'x</b> <u>y…', 'x</b> <u>y…</u>'],
    [
      'closes an open link',
      'see <a href="https://e.vn">her…',
      'see <a href="https://e.vn">her…</a>',
    ],
  ])('%s', (_name, cut, expected) => {
    expect(closeCutTelegramHtml(cut)).toBe(expected);
  });
});

describe('telegramChatIdOf (BACKLOG T516)', () => {
  it.each([
    [-1001234567890, '-1001234567890'],
    ['  -100123  ', '-100123'],
    ['@ops_alerts', '@ops_alerts'],
    [['42'], '42'],
    [0, null],
    ['', null],
    ['Kho Hà Nội', null],
    ['@ab', null],
    [['1', '2'], null],
    [null, null],
    [{ id: '1' }, null],
  ])('%j → %j', (value, expected) => {
    expect(telegramChatIdOf(value)).toBe(expected);
  });
});

/** A fetch answering with `status` and `body`, recording the calls. */
function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, body: JSON.parse(init?.body as string) as unknown });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('TelegramClient (BACKLOG T516)', () => {
  const message = { chatId: '-100123', text: '<b>Hi</b>' };

  it('posts sendMessage with parse_mode HTML to the fixed host', async () => {
    const fake = fakeFetch(200, { ok: true, result: { message_id: 77 } });
    const client = new TelegramClient({ fetch: fake.fetch });
    await expect(client.sendMessage(TOKEN, message)).resolves.toEqual({ ok: true, messageId: 77 });
    expect(fake.calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        body: { chat_id: '-100123', text: '<b>Hi</b>', parse_mode: 'HTML' },
      },
    ]);
  });

  it.each([
    [
      '429 with parameters.retry_after',
      429,
      { ok: false, error_code: 429, parameters: { retry_after: 7 } },
      {},
      { ok: false, kind: 'rate_limited', retryAfterMs: 7_000 },
    ],
    [
      '429 with only the Retry-After header',
      429,
      { ok: false },
      { 'retry-after': '3' },
      { ok: false, kind: 'rate_limited', retryAfterMs: 3_000 },
    ],
    [
      '400 (chat not found)',
      400,
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      {},
      { ok: false, kind: 'rejected', status: 400, errorCode: 400, refusal: 'chat_not_found' },
    ],
    [
      '403 (bot blocked)',
      403,
      { ok: false, error_code: 403 },
      {},
      { ok: false, kind: 'rejected', status: 403, errorCode: 403, refusal: 'blocked' },
    ],
    // T550: only these two say something about the chat; the description is never kept.
    [
      '403 (user deactivated)',
      403,
      { ok: false, error_code: 403, description: 'Forbidden: user is deactivated' },
      {},
      { ok: false, kind: 'rejected', status: 403, errorCode: 403, refusal: 'blocked' },
    ],
    [
      '400 (HTML refused)',
      400,
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      {},
      { ok: false, kind: 'rejected', status: 400, errorCode: 400, refusal: null },
    ],
    [
      '400 without a body',
      400,
      null,
      {},
      { ok: false, kind: 'rejected', status: 400, errorCode: null, refusal: null },
    ],
    [
      '404 (chat not found wording on another status)',
      404,
      { ok: false, error_code: 404, description: 'Not Found: chat not found' },
      {},
      { ok: false, kind: 'rejected', status: 404, errorCode: 404, refusal: null },
    ],
    ['502', 502, {}, {}, { ok: false, kind: 'unavailable', cause: 'server_error', status: 502 }],
  ])('classifies %s', async (_name, status, body, headers, expected) => {
    const client = new TelegramClient({ fetch: fakeFetch(status, body, headers).fetch });
    await expect(client.sendMessage(TOKEN, message)).resolves.toEqual(expected);
  });

  it('times out after its timeout and never calls with a malformed token', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const client = new TelegramClient({ fetch: hanging, timeoutMs: 20 });
    await expect(client.sendMessage(TOKEN, message)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      cause: 'timeout',
      status: null,
    });
    const fake = fakeFetch(200, { ok: true, result: { message_id: 1 } });
    const strict = new TelegramClient({ fetch: fake.fetch });
    await expect(strict.sendMessage('1/../x?y', message)).resolves.toMatchObject({
      kind: 'rejected',
    });
    expect(fake.calls).toEqual([]);
  });
});

describe('send_telegram at save (BACKLOG T516)', () => {
  const fields: AutomationFieldMeta[] = [
    { id: TITLE, table_id: ORDERS, name: 'title', type: 'text', options: {} },
    { id: CHAT, table_id: ORDERS, name: 'chat', type: 'text', options: {} },
    { id: HIDDEN, table_id: ORDERS, name: 'hidden', type: 'text', options: {} },
  ];
  const table: TableAccess = {
    perm: 'manage',
    operations: ['add', 'delete'],
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    fields: { [TITLE]: 'edit', [CHAT]: 'edit' },
    option_edit_fields: [],
    file_download_fields: [],
  };
  const access: EffectiveAccess = {
    role: null,
    is_admin: false,
    base_rule: { copy: true, download: true, share_link: true },
    tables: { [ORDERS]: table },
    dashboards: {},
  };
  const errorsOf = (input: AutomationDefinitionInput) => {
    const result = validateAutomationDefinition(automationDefinitionSchema.parse(input), {
      tables: [{ id: ORDERS }],
      fields,
      access,
      views: new Map(),
    });
    return result.ok ? [] : result.errors.map(({ path, code }) => ({ path, code }));
  };
  const telegram = (config: Record<string, unknown>) => ({
    id: 'act_tg',
    type: 'send_telegram' as const,
    config: {
      secret_id: SEC,
      chat_id: { literal: '-100123' },
      text: { template: `<b>{{ [${TITLE}] }}</b>` },
      ...config,
    } as never,
  });
  const onCreate = { type: 'record.created', table_id: ORDERS } as const;

  it('accepts a readable chat field and a template of readable fields', () => {
    expect(
      errorsOf({ trigger: onCreate, actions: [telegram({ chat_id: { field: CHAT } })] }),
    ).toEqual([]);
  });

  it('refuses a hidden field, REGEX and a digest placeholder without a digest', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          telegram({
            chat_id: { field: HIDDEN },
            text: { template: `{{ REGEXMATCH([${TITLE}], "a") }} {{ [@digest] }}` },
          }),
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        { path: 'definition.actions[0].config.chat_id.field', code: 'UNKNOWN_FIELD' },
        { path: 'definition.actions[0].config.text.template', code: 'UNSUPPORTED_FUNCTION' },
      ]),
    );
  });

  it('places the lines of an earlier find_records with a digest', () => {
    const find = {
      id: 'act_find',
      type: 'find_records' as const,
      config: { table_id: ORDERS, fields: [TITLE] },
    };
    expect(
      errorsOf({
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          find,
          telegram({
            text: {
              template: 'Quá hạn:\n{{ [@digest] }}',
              digest: { step: 'act_find', row_template: `• <b>{{ [${TITLE}] }}</b>` },
            },
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          telegram({
            text: {
              template: '{{ [@digest] }}',
              digest: { step: 'act_find', row_template: 'x' },
            },
          }),
        ],
      }),
    ).toEqual([{ path: 'definition.actions[0].config.text.digest.step', code: 'UNKNOWN_STEP' }]);
  });
});
