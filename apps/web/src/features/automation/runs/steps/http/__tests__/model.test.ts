import { HTTP_DELIVERY_MAX_ATTEMPTS } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  allowlistHintOf,
  deliveryPhaseOf,
  httpResponseOf,
  isHttpStep,
  MAX_DELIVERY_ATTEMPTS,
} from '../model';

describe('local copies of contract constants', () => {
  it('six attempts, as the outbox', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(HTTP_DELIVERY_MAX_ATTEMPTS);
  });
});

import type { AutomationRunStepDto, HttpDeliverySummary } from '@cellhive/contracts';

const delivery = (patch: Partial<HttpDeliverySummary> = {}): HttpDeliverySummary => ({
  id: 'hdl_0000000000000001',
  target_host: 'hooks.example.com',
  attempts: 1,
  status: 'pending',
  last_status: null,
  last_error: null,
  next_attempt_at: '2026-10-18T10:00:10.000Z',
  ...patch,
});

const step = (patch: Partial<AutomationRunStepDto> = {}): AutomationRunStepDto => ({
  id: 'stp_0000000000000001',
  action_id: 'act_http',
  action_type: 'http_request',
  status: 'waiting',
  attempt: 1,
  started_at: '2026-10-18T10:00:00.000Z',
  finished_at: null,
  reused: false,
  output: null,
  redacted: false,
  error: null,
  ...patch,
});

describe('isHttpStep', () => {
  it.each([
    ['http_request', undefined, true],
    ['run_n8n_workflow', undefined, true],
    ['send_email', undefined, false],
    [null, undefined, false],
    // A step the server summarises as a delivery is an HTTP step whatever its type.
    ['future_http_action', delivery(), true],
  ] as const)('%s (delivery: %s) → %s', (type, summary, expected) => {
    expect(isHttpStep(type, summary === undefined ? undefined : step({ delivery: summary }))).toBe(
      expected,
    );
  });
});

describe('deliveryPhaseOf', () => {
  it.each([
    ['first attempt not made yet', delivery({ attempts: 0 }), 'queued'],
    ['temporary error, retried', delivery({ last_error: { code: 'http_timeout' } }), 'retry'],
    ['5xx, retried', delivery({ last_status: 502 }), 'retry'],
    ['429 asks to wait (Retry-After)', delivery({ last_status: 429 }), 'paused'],
    ['503 asks to wait (Retry-After)', delivery({ attempts: 2, last_status: 503 }), 'paused'],
    ['pending without a next attempt', delivery({ next_attempt_at: null }), 'queued'],
    ['leased by a worker', delivery({ status: 'sending', next_attempt_at: null }), 'sending'],
    ['succeeded', delivery({ status: 'succeeded', next_attempt_at: null }), 'succeeded'],
    ['failed', delivery({ status: 'failed', next_attempt_at: null }), 'failed'],
    ['cancelled', delivery({ status: 'cancelled', next_attempt_at: null }), 'cancelled'],
  ] as const)('%s → %s', (_label, summary, phase) => {
    expect(deliveryPhaseOf(summary)).toBe(phase);
  });
});

describe('httpResponseOf', () => {
  const output = (body: unknown, extra: Record<string, unknown> = {}) => ({
    delivery_id: 'hdl_0000000000000001',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    body_truncated: false,
    ...extra,
  });

  it('is null without an output (the step has not succeeded)', () => {
    expect(httpResponseOf(step())).toBeNull();
    expect(httpResponseOf(step({ output: 'nonsense' }))).toBeNull();
  });

  it.each([
    [
      'JSON object, pretty printed',
      output({ id: 7 }),
      false,
      { kind: 'text', text: '{\n  "id": 7\n}' },
    ],
    ['JSON array', output([1, 2]), false, { kind: 'text', text: '[\n  1,\n  2\n]' }],
    ['text kept as is', output('<p>ok</p>'), false, { kind: 'text', text: '<p>ok</p>' }],
    ['empty string', output(''), false, { kind: 'empty' }],
    ['empty body', output(null), false, { kind: 'empty' }],
    // The server hides the body unless the viewer reads every value the step used.
    ['hidden by the server', output(null), true, { kind: 'hidden' }],
    ['body field missing and redacted', { status: 200, headers: {} }, true, { kind: 'hidden' }],
    ['number', output(42), false, { kind: 'text', text: '42' }],
    ['boolean', output(false), false, { kind: 'text', text: 'false' }],
  ] as const)('%s', (_label, value, redacted, body) => {
    expect(httpResponseOf(step({ status: 'succeeded', output: value, redacted }))?.body).toEqual(
      body,
    );
  });

  it('reads the status, content type and truncation', () => {
    expect(
      httpResponseOf(
        step({
          status: 'succeeded',
          output: output('x'.repeat(10), {
            status: 201,
            headers: { 'content-type': 'text/plain' },
            body_truncated: true,
          }),
        }),
      ),
    ).toEqual({
      status: 201,
      contentType: 'text/plain',
      truncated: true,
      body: { kind: 'text', text: 'xxxxxxxxxx' },
    });
  });

  it('keeps unknown statuses and content types out', () => {
    expect(
      httpResponseOf(step({ output: { status: 'two hundred', headers: { 'content-type': 3 } } })),
    ).toEqual({ status: null, contentType: null, truncated: false, body: { kind: 'empty' } });
  });
});

describe('allowlistHintOf', () => {
  it.each([
    [{ code: 'ssrf_blocked', params: { reason: 'private_address' } }, 'allowlist'],
    [{ code: 'ssrf_blocked', params: { reason: 'port_not_allowed' } }, 'allowlist'],
    [{ code: 'ssrf_blocked', params: { reason: 'blocked_address' } }, 'never'],
    [{ code: 'ssrf_blocked', params: { reason: 'unresolvable' } }, 'host'],
    [{ code: 'ssrf_blocked', params: { reason: 'invalid_url' } }, null],
    [{ code: 'ssrf_blocked' }, null],
    [{ code: 'http_timeout' }, null],
    [null, null],
  ] as const)('%j → %s', (error, hint) => {
    expect(allowlistHintOf(error)).toBe(hint);
  });
});
