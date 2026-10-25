import { afterEach, describe, expect, it } from 'vitest';

import {
  checkHttpRequest,
  checkRunN8nWorkflow,
  headerNameProblem,
  httpStepPaths,
  isCallableUrl,
  isResponsePath,
  jsonBodyTemplate,
  jsonBodyValue,
  jsonTemplateProblem,
  newHttpRequestConfig,
  newRunN8nWorkflowConfig,
  responsePaths,
  switchBodyType,
  urlProblem,
  usedStepPaths,
  valueAtPath,
} from '../actions/http-request/model';
import {
  pickedResponsePaths,
  pickResponsePath,
  resetPickedResponsePaths,
  unpickResponsePath,
} from '../actions/http-request/response-paths';
import { n8nPayloadPreview, payloadFields } from '../actions/run-n8n-workflow/payload';
import { checkDraft } from '../model/check';
import { newAction } from '../model/draft';
import { scopeOf } from '../model/scope';

import type { AutomationAction, AutomationDefinition, FieldDto } from '@cellhive/contracts';

/** T613: the pure part of the `http_request` / `run_n8n_workflow` editors. */

const STEP = 'act_http' as const;

afterEach(() => {
  resetPickedResponsePaths();
});

describe('headerNameProblem', () => {
  it.each([
    ['X-Order', [], null],
    ['', [], 'required'],
    ['   ', [], 'required'],
    ['Bad Header', [], 'invalid'],
    ['X:Y', [], 'invalid'],
    ['Host', [], 'forbidden'],
    ['host', [], 'forbidden'],
    ['User-Agent', [], 'forbidden'],
    ['Proxy-Authorization', [], 'forbidden'],
    ['webhook-signature', [], 'forbidden'],
    ['X-Order', ['x-order'], 'duplicate'],
    ['Authorization', ['Authorization'], 'duplicate'],
    ['Authorization', ['X-Order'], null],
  ] as const)('%j among %j → %j', (name, others, expected) => {
    expect(headerNameProblem(name, others)).toBe(expected);
  });
});

describe('isCallableUrl', () => {
  it.each([
    ['https://api.example.com/orders', true],
    ['http://n8n:5678/webhook/x', true],
    ['http://10.0.0.1', true],
    ['ftp://example.com', false],
    ['https://user:pass@example.com', false],
    ['example.com', false],
    ['https://exa mple.com', false],
    [`https://example.com/${'a'.repeat(2048)}`, false],
    ['', false],
  ] as const)('%s → %s', (url, expected) => {
    expect(isCallableUrl(url)).toBe(expected);
  });
});

describe('urlProblem', () => {
  it.each([
    [undefined, 'REQUIRED'],
    [{ literal: '' }, 'REQUIRED'],
    [{ literal: 'https://ok.example' }, null],
    [{ literal: 'javascript:alert(1)' }, 'INVALID_URL'],
    [{ literal: 42 }, 'INVALID_URL'],
    [{ template: 'https://api.example.com/orders/{{ [fld_code] }}' }, null],
    [{ template: 'https://{{ [fld_host] }}/x' }, 'URL_SCHEME_REQUIRED'],
    [{ template: 'https://h{{ [fld_host] }}/x' }, null],
    [{ template: '{{ [fld_url] }}' }, 'URL_SCHEME_REQUIRED'],
    [{ template: 'api.example.com/{{ [fld_x] }}' }, 'URL_SCHEME_REQUIRED'],
    [{ field: 'fld_url' }, null],
    [{ step: 'act_1', path: 'body.next' }, null],
  ] as const)('%j → %j', (value, expected) => {
    expect(urlProblem(value)).toBe(expected);
  });
});

describe('jsonTemplateProblem', () => {
  it.each([
    ['', false],
    ['{"title": "{{ [fld_title] }}", "amount": {{ [fld_amount] }}}', false],
    ['[1, 2, {{ [fld_n] }}]', false],
    ['{"title": "x",}', true],
    ['{"title": }', true],
    ['{title: 1}', true],
  ] as const)('%s → invalid %s', (template, invalid) => {
    expect(jsonTemplateProblem(template) !== null).toBe(invalid);
  });

  it('gives the 1-based position when the engine says it', () => {
    const problem = jsonTemplateProblem('{"a": 1,, "b": 2}');
    expect(problem).not.toBeNull();
    if (problem?.position !== null) expect(problem?.position).toBeGreaterThan(0);
  });
});

describe('JSON body values', () => {
  it('stores typed JSON as a template (a literal string would be sent as one JSON string)', () => {
    expect(jsonBodyValue({ literal: '{"a": 1}' })).toEqual({ template: '\\{"a": 1}' });
    expect(jsonBodyValue(undefined)).toEqual({ template: '' });
    expect(jsonBodyValue({ template: '{{ [fld_x] }}' })).toEqual({ template: '{{ [fld_x] }}' });
    expect(jsonBodyValue({ field: 'fld_x' })).toEqual({ field: 'fld_x' });
  });

  it('shows a literal JSON value made through the API as its text', () => {
    expect(jsonBodyTemplate({ literal: { a: 1 } })).toEqual({
      template: '\\{\n  "a": 1\n}',
    });
    expect(jsonBodyTemplate({ template: 'x' })).toEqual({ template: 'x' });
  });
});

describe('switchBodyType', () => {
  it.each([
    [null, 'none', null],
    [null, 'json', { type: 'json', value: { template: '' } }],
    [null, 'form', { type: 'form', fields: [] }],
    [null, 'text', { type: 'text', value: { literal: '' } }],
    [{ type: 'form', fields: [] }, 'form', { type: 'form', fields: [] }],
  ] as const)('%j → %s', (body, type, expected) => {
    expect(switchBodyType(body as never, type)).toEqual(expected);
  });
});

describe('checkHttpRequest', () => {
  const base = { ...newHttpRequestConfig(), url: { literal: 'https://ok.example' } };
  it.each([
    ['a complete POST', base, []],
    ['no URL', newHttpRequestConfig(), [['config.url', 'REQUIRED']]],
    [
      'a header the outbox owns and a duplicate',
      {
        ...base,
        headers: [
          { name: 'Host', value: { literal: 'x' } },
          { name: 'X-A', value: { literal: '1' } },
          { name: 'x-a', value: { literal: '2' } },
        ],
      },
      [
        ['config.headers[0].name', 'HEADER_NOT_ALLOWED'],
        ['config.headers[2].name', 'HEADER_NOT_ALLOWED'],
      ],
    ],
    [
      'a header named like the auth header',
      {
        ...base,
        headers: [{ name: 'authorization', value: { literal: 'x' } }],
        auth: { header_name: 'Authorization', secret_id: 'sec_Header0000000001' },
      },
      [['config.headers[0].name', 'HEADER_NOT_ALLOWED']],
    ],
    [
      'auth without a secret',
      { ...base, auth: { header_name: 'Authorization', secret_id: '' } },
      [['config.auth.secret_id', 'REQUIRED']],
    ],
    [
      'an empty query name',
      { ...base, query: [{ name: ' ', value: { literal: 'x' } }] },
      [['config.query[0].name', 'REQUIRED']],
    ],
    [
      'a broken JSON body',
      { ...base, body: { type: 'json', value: { template: '{"a": }' } } },
      [['config.body.value', 'INVALID_JSON']],
    ],
    [
      'an empty JSON body',
      { ...base, body: { type: 'json', value: { template: ' ' } } },
      [['config.body.value', 'REQUIRED']],
    ],
    [
      'a GET with a body',
      { ...base, method: 'GET', body: { type: 'text', value: { literal: 'x' } } },
      [['config.body', 'GET_NO_BODY']],
    ],
    ['a GET without a body', { ...base, method: 'GET', body: null }, []],
    [
      'an empty form field name',
      { ...base, body: { type: 'form', fields: [{ name: '', value: { literal: 'x' } }] } },
      [['config.body.fields[0].name', 'REQUIRED']],
    ],
  ] as const)('%s', (_label, config, expected) => {
    expect(
      checkHttpRequest(STEP, config as never).map((issue) => [issue.path, issue.code]),
    ).toEqual(expected);
  });
});

describe('checkRunN8nWorkflow', () => {
  it.each([
    [
      'new',
      newRunN8nWorkflowConfig(),
      [
        ['config.url', 'REQUIRED'],
        ['config.signing_secret_id', 'REQUIRED'],
      ],
    ],
    [
      'complete',
      {
        ...newRunN8nWorkflowConfig(),
        url: { literal: 'https://n8n.example/webhook/x' },
        signing_secret_id: 'sec_Sign000000000001',
      },
      [],
    ],
    [
      'chosen fields left empty',
      {
        ...newRunN8nWorkflowConfig(),
        url: { literal: 'https://n8n.example/webhook/x' },
        signing_secret_id: 'sec_Sign000000000001',
        fields: [],
      },
      [['config.fields', 'REQUIRED']],
    ],
  ] as const)('%s', (_label, config, expected) => {
    expect(
      checkRunN8nWorkflow(STEP, config as never).map((issue) => [issue.path, issue.code]),
    ).toEqual(expected);
  });
});

describe('response paths', () => {
  it('lists the leaves of a JSON body, the first item of arrays', () => {
    expect(
      responsePaths({
        id: 7,
        customer: { email: 'a@b.vn' },
        items: [{ sku: 'X' }, { sku: 'Y' }],
        'a.b': 1,
        tags: [],
      }),
    ).toEqual(['body.id', 'body.customer.email', 'body.items[0].sku', 'body.tags']);
    expect(responsePaths([1, 2])).toEqual(['body[0]']);
    expect(responsePaths('text')).toEqual([]);
    expect(responsePaths(null)).toEqual([]);
    expect(responsePaths({ a: 1, b: 2, c: 3 }, 2)).toEqual(['body.a', 'body.b']);
  });

  it('reads the value at a path', () => {
    const response = { body: { items: [{ sku: 'X' }] } };
    expect(valueAtPath(response, 'body.items[0].sku')).toBe('X');
    expect(valueAtPath(response, 'body.missing')).toBeNull();
  });

  it.each([
    ['status', true],
    ['headers.content-type', true],
    ['body', true],
    ['body.id', true],
    ['body.items[0].sku', true],
    ['id', false],
    ['body..id', false],
    ['delivery_id', false],
  ] as const)('isResponsePath(%s) → %s', (path, expected) => {
    expect(isResponsePath(path)).toBe(expected);
  });

  const definition = {
    trigger: { type: 'record.created', table_id: 'tbl_A', skip_bulk: false },
    condition: null,
    actions: [
      {
        id: STEP,
        type: 'http_request',
        config: { ...newHttpRequestConfig(), url: { literal: 'https://x.example' } },
      },
      {
        id: 'act_if',
        type: 'if',
        config: {
          match: 'and',
          conditions: [
            { value: { step: STEP, path: 'body.id' }, operator: 'is_not_empty', compare: null },
          ],
          on_false: 'else',
          then: [],
          else: [],
        },
      },
    ],
  } as unknown as AutomationDefinition;

  it('finds the paths later steps already use', () => {
    expect(usedStepPaths(definition.actions, STEP)).toEqual(['body.id']);
    expect(usedStepPaths(definition.actions, 'act_other')).toEqual([]);
  });

  it('offers status, body, used then picked paths without repeats', () => {
    expect(httpStepPaths(definition, STEP, ['body.id', 'body.name'])).toEqual([
      'status',
      'body',
      'body.id',
      'body.name',
    ]);
  });

  it('gives later steps the HTTP paths in their scope (picked in this tab)', () => {
    pickResponsePath(STEP, 'body.total');
    pickResponsePath(STEP, 'body.total');
    expect(pickedResponsePaths(STEP)).toEqual(['body.total']);
    const scope = scopeOf(definition, 'act_if', null);
    expect(scope.steps[0]?.paths).toEqual(['status', 'body', 'body.id', 'body.total']);
    unpickResponsePath(STEP, 'body.total');
    expect(scopeOf(definition, 'act_if', null).steps[0]?.paths).toEqual([
      'status',
      'body',
      'body.id',
    ]);
  });
});

describe('draft and save check', () => {
  it('creates both steps with their defaults and names what is missing', () => {
    const http = newAction('http_request', 'act_1', { triggerTableId: null, firstTableId: null });
    const n8n = newAction('run_n8n_workflow', 'act_2', {
      triggerTableId: null,
      firstTableId: null,
    });
    const definition = {
      trigger: { type: 'record.created', table_id: 'tbl_A0000000000000001', skip_bulk: false },
      condition: null,
      actions: [http, n8n] as AutomationAction[],
    } as AutomationDefinition;
    const issues = checkDraft(definition, {
      name: 'x',
      conditions: new Map(),
      orgTimeZone: 'UTC',
      now: new Date('2026-10-18T00:00:00Z'),
    });
    expect(issues.map((issue) => [issue.step, issue.path, issue.code])).toEqual([
      ['act_1', 'config.url', 'REQUIRED'],
      ['act_2', 'config.url', 'REQUIRED'],
      ['act_2', 'config.signing_secret_id', 'REQUIRED'],
    ]);
  });
});

describe('n8n payload preview', () => {
  const fields = [
    { id: 'fld_title', name: 'Title', type: 'text' },
    { id: 'fld_status', name: 'Status', type: 'single_select' },
    { id: 'fld_go', name: 'Go', type: 'button' },
  ] as unknown as FieldDto[];

  it('sends every field but buttons, or the chosen ones in table order', () => {
    expect(payloadFields(fields, null).map((field) => field.id)).toEqual([
      'fld_title',
      'fld_status',
    ]);
    expect(payloadFields(fields, ['fld_status', 'fld_go']).map((field) => field.id)).toEqual([
      'fld_status',
    ]);
  });

  it('has the shape of N8nWorkflowPayload with placeholders', () => {
    const payload = n8nPayloadPreview({
      triggerType: 'record.updated',
      automationName: 'Sync',
      baseName: 'Sales',
      table: { id: 'tbl_A', name: 'Orders' },
      fields: payloadFields(fields, null),
      includeChanges: true,
    });
    expect(payload.record?.fields).toEqual({ Title: '<text>', Status: '<single_select>' });
    expect(payload.record?.fields_by_id).toEqual({
      fld_title: '<text>',
      fld_status: '<single_select>',
    });
    expect(payload.changes).toEqual({ Title: { from: '<text>', to: '<text>' } });
    expect(payload.table).toEqual({ id: 'tbl_A', name: 'Orders' });
  });

  it('has no record, table or changes without a trigger record', () => {
    const payload = n8nPayloadPreview({
      triggerType: 'schedule',
      automationName: 'Nightly',
      baseName: 'Sales',
      table: null,
      fields: [],
      includeChanges: true,
    });
    expect(payload).toMatchObject({
      record: null,
      table: null,
      changes: null,
      event: { id: null },
    });
  });
});
