import { describe, expect, it } from 'vitest';

import { AUTOMATION_STEP_ERROR_CODES } from '../src/automation-runs.js';
import {
  automationActionSchema,
  automationBranchActionSchema,
  HTTP_REQUEST_STEP_ERROR_CODES,
  httpRequestConfigSchema,
  httpRequestValuesOf,
  isAllowedHttpRequestHeader,
} from '../src/automations.js';
import { ERROR_DETAIL_CODES } from '../src/error-details.js';
import { httpStepOutputSchema, httpTestRequestSchema } from '../src/http-deliveries.js';
import {
  createSecretRequestSchema,
  isValidSecretValue,
  SECRET_KINDS,
  secretWithValueSchema,
  updateSecretRequestSchema,
} from '../src/secrets.js';

const SEC = 'sec_A1b2C3d4E5f6G7h8';
const SEC2 = 'sec_Z1b2C3d4E5f6G7h8';
const FLD = 'fld_A1b2C3d4E5f6G7h8';

describe('http_request config (CONTRACTS §21, BACKLOG T606)', () => {
  it('fills the defaults', () => {
    expect(
      httpRequestConfigSchema.parse({ method: 'POST', url: { literal: 'https://x.test/h' } }),
    ).toEqual({
      method: 'POST',
      url: { literal: 'https://x.test/h' },
      query: [],
      headers: [],
      auth: null,
      body: null,
      signing_secret_id: null,
      fail_on_http_error: true,
    });
  });

  it.each([
    ['GET with a body', { method: 'GET', body: { type: 'text', value: { literal: 'x' } } }, false],
    ['GET without a body', { method: 'GET' }, true],
    [
      'DELETE with a body',
      { method: 'DELETE', body: { type: 'json', value: { literal: {} } } },
      true,
    ],
    ['HEAD', { method: 'HEAD' }, false],
    [
      'a header name with a space',
      { method: 'POST', headers: [{ name: 'X Y', value: { literal: '1' } }] },
      false,
    ],
    [
      'a header name with a colon',
      { method: 'POST', headers: [{ name: 'X:Y', value: { literal: '1' } }] },
      false,
    ],
    [
      '21 headers',
      {
        method: 'POST',
        headers: Array.from({ length: 21 }, (_, i) => ({
          name: `X-${String(i)}`,
          value: { literal: '1' },
        })),
      },
      false,
    ],
    [
      '21 query parameters',
      {
        method: 'POST',
        query: Array.from({ length: 21 }, (_, i) => ({
          name: `q${String(i)}`,
          value: { literal: '1' },
        })),
      },
      false,
    ],
    [
      'a digest in a header',
      {
        method: 'POST',
        headers: [{ name: 'X', value: { digest: { step: 'act_1', row_template: 'x' } } }],
      },
      false,
    ],
    [
      'a digest in a text body',
      {
        method: 'POST',
        body: { type: 'text', value: { digest: { step: 'act_1', row_template: 'x' } } },
      },
      true,
    ],
    [
      'a digest in a JSON body',
      {
        method: 'POST',
        body: { type: 'json', value: { digest: { step: 'act_1', row_template: 'x' } } },
      },
      false,
    ],
    [
      'an auth secret',
      { method: 'POST', auth: { header_name: 'Authorization', secret_id: SEC } },
      true,
    ],
    ['an auth without secret', { method: 'POST', auth: { header_name: 'Authorization' } }, false],
    [
      'a form body',
      { method: 'PUT', body: { type: 'form', fields: [{ name: 'a', value: { field: FLD } }] } },
      true,
    ],
    ['an unknown key', { method: 'POST', timeout: 5 }, false],
  ])('%s → valid %s', (_label, config, valid) => {
    expect(
      httpRequestConfigSchema.safeParse({ url: { literal: 'https://x.test/' }, ...config }).success,
    ).toBe(valid);
  });

  it('is an action at the top level and inside an if branch', () => {
    const action = {
      id: 'act_http',
      type: 'http_request',
      config: { method: 'POST', url: { template: 'https://x.test/{{ [fld_A1b2C3d4E5f6G7h8] }}' } },
    };
    expect(automationActionSchema.safeParse(action).success).toBe(true);
    expect(automationBranchActionSchema.safeParse(action).success).toBe(true);
  });

  it.each([
    ['Authorization', true],
    ['X-Api-Key', true],
    ['Content-Type', true],
    ['Host', false],
    ['host', false],
    ['Content-Length', false],
    ['Transfer-Encoding', false],
    ['Connection', false],
    ['TE', false],
    ['Upgrade', false],
    ['Expect', false],
    ['Keep-Alive', false],
    ['Trailer', false],
    ['Proxy-Authorization', false],
    ['proxy-anything', false],
    ['User-Agent', false],
    ['Idempotency-Key', false],
    ['webhook-id', false],
    ['Webhook-Signature', false],
    ['webhook-timestamp', false],
    ['X-Cellhive-Causation', false],
  ])('header %s → allowed %s', (name, allowed) => {
    expect(isAllowedHttpRequestHeader(name)).toBe(allowed);
  });

  it('lists every value of a config in order', () => {
    const config = httpRequestConfigSchema.parse({
      method: 'POST',
      url: { literal: 'https://x.test/' },
      query: [{ name: 'q', value: { field: FLD } }],
      headers: [{ name: 'X', value: { step: 'act_1' } }],
      body: { type: 'form', fields: [{ name: 'a', value: { template: 'x' } }] },
    });
    expect(httpRequestValuesOf(config)).toEqual([
      { literal: 'https://x.test/' },
      { field: FLD },
      { step: 'act_1' },
      { template: 'x' },
    ]);
  });

  it('registers its step and detail codes', () => {
    for (const code of HTTP_REQUEST_STEP_ERROR_CODES) {
      expect(AUTOMATION_STEP_ERROR_CODES).toContain(code);
    }
    expect(ERROR_DETAIL_CODES).toEqual(
      expect.arrayContaining(['HEADER_NOT_ALLOWED', 'INVALID_URL', 'INVALID_SECRET_VALUE']),
    );
  });

  it('a step output may carry any final status (fail_on_http_error: false)', () => {
    const output = {
      delivery_id: 'hdl_A1b2C3d4E5f6G7h8',
      headers: { 'content-type': null },
      body: null,
      body_truncated: false,
    };
    expect(httpStepOutputSchema.safeParse({ ...output, status: 404 }).success).toBe(true);
    expect(httpStepOutputSchema.safeParse({ ...output, status: 600 }).success).toBe(false);
  });

  it('a test request defaults to no record', () => {
    expect(httpTestRequestSchema.parse({})).toEqual({ record_id: null });
    expect(httpTestRequestSchema.safeParse({ to: 'x' }).success).toBe(false);
  });
});

describe('HTTP secrets (CONTRACTS §24, BACKLOG T606)', () => {
  it('has the three kinds', () => {
    expect(SECRET_KINDS).toEqual(['telegram_bot', 'http_header', 'webhook_signing']);
  });

  const key = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64');
  it.each([
    ['http_header', 'Bearer abc.def-123', true],
    ['http_header', 'x'.repeat(4096), true],
    ['http_header', 'x'.repeat(4097), false],
    ['http_header', 'line\r\nX-Evil: 1', false],
    ['http_header', 'tab\there', false],
    ['http_header', 'không ASCII', false],
    ['http_header', '', false],
    ['webhook_signing', `whsec_${key(24)}`, true],
    ['webhook_signing', `whsec_${key(32)}`, true],
    ['webhook_signing', `whsec_${key(64)}`, true],
    ['webhook_signing', `whsec_${key(23)}`, false],
    ['webhook_signing', `whsec_${key(65)}`, false],
    ['webhook_signing', key(32), false],
    ['webhook_signing', 'whsec_not base64!', false],
    ['webhook_signing', 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', true],
    ['telegram_bot', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', true],
    ['telegram_bot', 'Bearer x', false],
  ] as const)('%s %s → valid %s', (kind, value, valid) => {
    expect(isValidSecretValue(kind, value)).toBe(valid);
  });

  it.each([
    ['a value', { kind: 'http_header', value: 'Bearer x' }, true],
    ['generate a signing secret', { kind: 'webhook_signing', generate: true }, true],
    ['generate a header value', { kind: 'http_header', generate: true }, false],
    ['generate a bot token', { kind: 'telegram_bot', generate: true }, false],
    ['neither value nor generate', { kind: 'webhook_signing' }, false],
    ['both value and generate', { kind: 'webhook_signing', value: 'x', generate: true }, false],
    ['generate: false', { kind: 'webhook_signing', generate: false }, false],
  ])('create with %s → valid %s', (_label, body, valid) => {
    // T701: HTTP secrets name their allowed hosts.
    const hosts = body.kind === 'telegram_bot' ? {} : { allowed_hosts: ['hooks.example'] };
    expect(createSecretRequestSchema.safeParse({ name: 'S', ...hosts, ...body }).success).toBe(
      valid,
    );
  });

  it.each([
    ['generate', { generate: true }, true],
    ['a value', { value: 'x' }, true],
    ['both', { value: 'x', generate: true }, false],
    ['nothing', {}, false],
  ])('update with %s → valid %s', (_label, body, valid) => {
    expect(updateSecretRequestSchema.safeParse(body).success).toBe(valid);
  });

  it('returns a generated value next to the secret', () => {
    const secret = {
      id: SEC,
      organization_id: 'org_A1b2C3d4E5f6G7h8',
      kind: 'webhook_signing',
      name: 'Ký',
      base_scope: 'all',
      base_ids: [],
      allowed_hosts: ['hooks.example'],
      legacy_hosts_until: null,
      previous_value_expires_at: null,
      created_by: null,
      created_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
    };
    expect(secretWithValueSchema.parse({ ...secret, value: 'whsec_x' }).value).toBe('whsec_x');
    expect(secretWithValueSchema.parse(secret).value).toBeUndefined();
    expect(SEC2).not.toBe(SEC);
  });
});
