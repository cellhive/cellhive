import {
  automationDefinitionSchema,
  httpRequestConfigSchema,
  type AutomationDefinitionInput,
  type AutomationTextContext,
  type AutomationValue,
  type EffectiveAccess,
  type HttpRequestConfigInput,
  type Id,
  type TableAccess,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { renderHttpRequest } from '../../src/automation/actions/http-request/render.js';
import { AutomationStepError } from '../../src/automation/engine/errors.js';
import {
  redactStepOutput,
  validateAutomationDefinition,
  valuesVisible,
  type AutomationFieldMeta,
  type StepReadability,
} from '../../src/automation/index.js';
import { escapeValue, finishText } from '../../src/automation/values/escape.js';

const ORDERS: Id<'tbl'> = 'tbl_OrdersTable00001';
const TITLE = 'fld_OrdersTitle00001';
const COST = 'fld_OrdersCost000001';
const SEC = 'sec_HttpHeader000001';

describe('escape contexts of http_request (BACKLOG T606)', () => {
  it.each([
    ['url_component', 'a/b?c=d#e f', 'a%2Fb%3Fc%3Dd%23e%20f'],
    ['url_component', '../admin', '..%2Fadmin'],
    ['url_component', 'Đơn 1', '%C4%90%C6%A1n%201'],
    ['url_component', '\ud800x', '%EF%BF%BDx'],
    ['json_string', 'say "hi"\\', 'say \\"hi\\"\\\\'],
    ['json_string', 'line\nbreak\u0001', 'line\\nbreak\\u0001'],
    ['json_string', '"}, "admin": true, "x": "', '\\"}, \\"admin\\": true, \\"x\\": \\"'],
  ] as const)('%s escapes %j', (context, value, expected) => {
    expect(escapeValue(value, context)).toBe(expected);
  });

  it('keeps a URL on one line', () => {
    expect(finishText(' https://x.test/a\r\nb ', 'url_component')).toBe('https://x.test/a b');
    expect(finishText('{"a":\n1}', 'json_string')).toBe('{"a":\n1}');
  });
});

/**
 * A resolver standing in for the evaluator: a template's `{{v}}` is the
 * record value `VALUE`, escaped for the context like the real one does.
 */
function fakeValues(value: string) {
  return {
    resolve(item: AutomationValue, options: { context?: AutomationTextContext } = {}) {
      const context = options.context ?? 'raw';
      if ('template' in item) {
        const text = finishText(
          item.template.replace('{{v}}', escapeValue(value, context)),
          context,
        );
        return Promise.resolve({ value: text, warnings: [], truncated: false });
      }
      if ('literal' in item) {
        return Promise.resolve({ value: item.literal, warnings: [], truncated: false });
      }
      return Promise.resolve({
        value: { id: 'rec_1', note: value },
        warnings: [],
        truncated: false,
      });
    },
  };
}

const config = (
  input: Omit<HttpRequestConfigInput, 'method' | 'url'> & Partial<HttpRequestConfigInput>,
) =>
  httpRequestConfigSchema.parse({
    method: 'POST',
    url: { literal: 'https://x.test/hook' },
    ...input,
  });

describe('renderHttpRequest (BACKLOG T606)', () => {
  it('percent-encodes values in a URL template and appends the query', async () => {
    const rendered = await renderHttpRequest(
      fakeValues('a/../b?admin=1#x'),
      config({
        url: { template: 'https://x.test/items/{{v}}' },
        query: [{ name: 'q', value: { template: '{{v}}' } }],
      }),
    );
    expect(rendered.delivery.request.url).toBe(
      'https://x.test/items/a%2F..%2Fb%3Fadmin%3D1%23x?q=a%2F..%2Fb%3Fadmin%3D1%23x',
    );
  });

  it('keeps header values on one line and adds the body content type', async () => {
    const rendered = await renderHttpRequest(
      fakeValues('v\r\nX-Evil: 1'),
      config({
        headers: [{ name: 'X-Note', value: { template: '{{v}}' } }],
        body: { type: 'text', value: { template: 'hello {{v}}' } },
        auth: { header_name: 'Authorization', secret_id: SEC },
      }),
    );
    expect(rendered.delivery.request.headers).toEqual([
      ['X-Note', 'v X-Evil: 1'],
      ['Content-Type', 'text/plain; charset=utf-8'],
    ]);
    expect(rendered.delivery.request.authHeaderName).toBe('Authorization');
    expect(rendered.delivery.authSecretId).toBe(SEC);
    expect(rendered.delivery.request.failOnHttpError).toBe(true);
  });

  it('a Content-Type header of the action wins', async () => {
    const rendered = await renderHttpRequest(
      fakeValues('x'),
      config({
        headers: [{ name: 'content-type', value: { literal: 'application/vnd.api+json' } }],
        body: { type: 'json', value: { literal: { a: 1 } } },
      }),
    );
    expect(rendered.delivery.request.headers).toEqual([
      ['content-type', 'application/vnd.api+json'],
    ]);
    expect(rendered.delivery.request.body).toBe('{"a":1}');
  });

  it('escapes values of a JSON template so they cannot add keys', async () => {
    const rendered = await renderHttpRequest(
      fakeValues('", "admin": true, "x": "'),
      config({ body: { type: 'json', value: { template: '{"note": "{{v}}"}' } } }),
    );
    expect(JSON.parse(rendered.delivery.request.body ?? '')).toEqual({
      note: '", "admin": true, "x": "',
    });
  });

  it('refuses a JSON template that does not parse (invalid_value)', async () => {
    await expect(
      renderHttpRequest(
        fakeValues('text'),
        config({ body: { type: 'json', value: { template: '{"note": {{v}}}' } } }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid_value',
      options: { params: { reason: 'invalid_json' } },
    });
  });

  it('sends a field value as its JSON and a form as urlencoded', async () => {
    const json = await renderHttpRequest(
      fakeValues('n'),
      config({ body: { type: 'json', value: { field: TITLE } } }),
    );
    expect(json.delivery.request.body).toBe('{"id":"rec_1","note":"n"}');
    const form = await renderHttpRequest(
      fakeValues('a&b=c'),
      config({
        body: {
          type: 'form',
          fields: [
            { name: 'note', value: { template: '{{v}}' } },
            { name: 'n', value: { literal: 3 } },
          ],
        },
      }),
    );
    expect(form.delivery.request.body).toBe('note=a%26b%3Dc&n=3');
    expect(form.delivery.request.headers).toEqual([
      ['Content-Type', 'application/x-www-form-urlencoded'],
    ]);
  });

  it('refuses a body larger than 1 MiB (http_request_too_large)', async () => {
    const error = await renderHttpRequest(
      fakeValues('x'.repeat(1_048_577)),
      config({ body: { type: 'text', value: { template: '{{v}}' } } }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutomationStepError);
    expect(error).toMatchObject({
      code: 'http_request_too_large',
      options: { params: { limit_bytes: 1_048_576 } },
    });
  });

  it('refuses a URL that does not parse when a query is appended (ssrf_blocked)', async () => {
    await expect(
      renderHttpRequest(
        fakeValues('x'),
        config({ url: { literal: 'not a url' }, query: [{ name: 'a', value: { literal: 1 } }] }),
      ),
    ).rejects.toMatchObject({
      code: 'ssrf_blocked',
      options: { params: { reason: 'invalid_url' } },
    });
  });

  it('passes fail_on_http_error and the signing secret through', async () => {
    const rendered = await renderHttpRequest(
      fakeValues('x'),
      config({ fail_on_http_error: false, signing_secret_id: SEC, method: 'GET' }),
    );
    expect(rendered.delivery).toMatchObject({
      request: { method: 'GET', body: null, failOnHttpError: false, authHeaderName: null },
      signingSecretId: SEC,
      authSecretId: null,
    });
  });
});

describe('http_request at save (BACKLOG T606)', () => {
  const fields: AutomationFieldMeta[] = [
    { id: TITLE, table_id: ORDERS, name: 'title', type: 'text', options: {} },
    { id: COST, table_id: ORDERS, name: 'cost', type: 'number', options: {} },
  ];
  const table: TableAccess = {
    perm: 'manage',
    operations: ['add', 'delete'],
    view_rule: { allow_edit: true, visible_views: null },
    read_scope: 'all',
    // `cost` is hidden from this person (the P47 shape).
    fields: { [TITLE]: 'edit' },
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
    return result.ok ? [] : result.errors.map(({ path, code, params }) => ({ path, code, params }));
  };
  const http = (input: Record<string, unknown>) => ({
    id: 'act_http',
    type: 'http_request' as const,
    config: { method: 'POST', url: { literal: 'https://x.test/hook' }, ...input } as never,
  });
  const onCreate = { type: 'record.created', table_id: ORDERS } as const;
  const P = 'definition.actions[0].config';

  it('accepts readable fields in the URL, headers and body', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          http({
            url: { template: `https://x.test/{{ [${TITLE}] }}` },
            headers: [{ name: 'X-Title', value: { field: TITLE } }],
            body: { type: 'json', value: { template: `{"t": "{{ [${TITLE}] }}"}` } },
          }),
        ],
      }),
    ).toEqual([]);
  });

  it('refuses a field the saver cannot read in a body template (UNKNOWN_FIELD, P47)', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [http({ body: { type: 'json', value: { template: `{{ [${COST}] }}` } } })],
      }),
    ).toEqual([
      expect.objectContaining({ path: `${P}.body.value.template`, code: 'UNKNOWN_FIELD' }),
    ]);
  });

  it.each([
    ['Host', 'reserved'],
    ['Content-Length', 'reserved'],
    ['webhook-signature', 'reserved'],
    ['Proxy-Authorization', 'reserved'],
  ])('refuses the header %s (HEADER_NOT_ALLOWED)', (name, reason) => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [http({ headers: [{ name, value: { literal: 'x' } }] })],
      }),
    ).toEqual([
      { path: `${P}.headers[0].name`, code: 'HEADER_NOT_ALLOWED', params: { name, reason } },
    ]);
  });

  it('refuses a header given twice, the auth header included', () => {
    expect(
      errorsOf({
        trigger: onCreate,
        actions: [
          http({
            auth: { header_name: 'Authorization', secret_id: SEC },
            headers: [
              { name: 'authorization', value: { literal: 'x' } },
              { name: 'X-A', value: { literal: '1' } },
              { name: 'x-a', value: { literal: '2' } },
            ],
          }),
        ],
      }),
    ).toEqual([
      {
        path: `${P}.headers[0].name`,
        code: 'HEADER_NOT_ALLOWED',
        params: { name: 'authorization', reason: 'duplicate' },
      },
      {
        path: `${P}.headers[2].name`,
        code: 'HEADER_NOT_ALLOWED',
        params: { name: 'x-a', reason: 'duplicate' },
      },
    ]);
  });

  it.each([
    ['ftp://x.test/', 'invalid_url'],
    ['https://user:pw@x.test/', 'invalid_url'],
    ['not a url', 'invalid_url'],
    [42, 'invalid_url'],
    [`https://x.test/${'a'.repeat(2050)}`, 'invalid_url'],
  ])('refuses the literal URL %j (INVALID_URL)', (literal, reason) => {
    expect(errorsOf({ trigger: onCreate, actions: [http({ url: { literal } })] })).toEqual([
      { path: `${P}.url`, code: 'INVALID_URL', params: { reason } },
    ]);
  });

  it('a literal URL to a private address or another port passes (checked when sent)', () => {
    for (const literal of [
      'http://10.0.0.5/',
      'http://127.0.0.1:6379/',
      'http://169.254.169.254/',
    ]) {
      expect(errorsOf({ trigger: onCreate, actions: [http({ url: { literal } })] })).toEqual([]);
    }
  });

  it('refuses a step not run before and a field without trigger record', () => {
    expect(
      errorsOf({
        trigger: { type: 'schedule', cron: '0 8 * * *' },
        actions: [
          http({
            url: { field: TITLE },
            headers: [{ name: 'X', value: { step: 'act_later' } }],
          }),
        ],
      }),
    ).toEqual([
      expect.objectContaining({ path: `${P}.url`, code: 'UNSUPPORTED_VALUE_SOURCE' }),
      expect.objectContaining({ path: `${P}.headers[0].value.step`, code: 'UNKNOWN_STEP' }),
    ]);
  });
});

describe('HTTP step output in the run log (BACKLOG T606)', () => {
  const nobody: StepReadability = { fieldsOf: () => undefined, recordVisible: () => false };
  const output = {
    delivery_id: 'hdl_A1b2C3d4E5f6G7h8',
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { secret_of_record: 'canary-body' },
    body_truncated: false,
  };

  it('hides the body unless the viewer may see it; keeps status and content-type', () => {
    expect(redactStepOutput('http_request', null, output, nobody)).toEqual({
      output: { ...output, body: null },
      redacted: true,
    });
    expect(redactStepOutput('http_request', null, output, nobody, { showHttpBody: true })).toEqual({
      output,
      redacted: false,
    });
  });

  it('a waiting step shows its delivery id; an odd content-type is hidden', () => {
    expect(
      redactStepOutput('http_request', null, { delivery_id: output.delivery_id }, nobody),
    ).toEqual({ output: { delivery_id: output.delivery_id }, redacted: false });
    expect(
      redactStepOutput(
        'http_request',
        null,
        { ...output, body: null, headers: { 'content-type': 'text/html <script>' } },
        nobody,
      ),
    ).toEqual({
      output: { ...output, body: null, headers: { 'content-type': null } },
      redacted: true,
    });
  });

  it('shows the body when every value the request used is readable now', () => {
    const reader: StepReadability = {
      fieldsOf: (table) => (table === ORDERS ? new Set([TITLE]) : undefined),
      recordVisible: (table, record) => table === ORDERS && record === 'rec_A1b2C3d4E5f6G7h8',
    };
    const context = {
      trigger: { tableId: ORDERS, recordId: 'rec_A1b2C3d4E5f6G7h8', dueFieldId: null },
      steps: new Map(),
    };
    expect(
      valuesVisible([{ literal: 'https://x.test/' }, { trigger: 'body' }], context, reader),
    ).toBe(true);
    expect(
      valuesVisible([{ field: TITLE }, { template: `{{ [${TITLE}] }}` }], context, reader),
    ).toBe(true);
    expect(valuesVisible([{ field: TITLE }, { field: COST }], context, reader)).toBe(false);
    expect(valuesVisible([{ digest: { step: 'act_1', row_template: 'x' } }], context, reader)).toBe(
      false,
    );
    expect(valuesVisible([{ step: 'act_http_before', path: 'body.id' }], context, reader)).toBe(
      false,
    );
  });
});
