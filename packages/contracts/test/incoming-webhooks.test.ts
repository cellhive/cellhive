import { describe, expect, it } from 'vitest';

import { ERROR_DETAIL_CODES, INCOMING_WEBHOOK_DETAIL_CODES } from '../src/error-details.js';
import { ERROR_STATUS } from '../src/errors.js';
import { isAuditAction, isEventType } from '../src/events.js';
import { newId } from '../src/ids.js';
import {
  authOf,
  authUsesBearer,
  authUsesSignature,
  createIncomingWebhookRequestSchema,
  CREDENTIAL_REQUIRED,
  INCOMING_WEBHOOK_TOKEN_PATTERN,
  incomingWebhookRequestListSchema,
  incomingWebhookSchema,
  incomingWebhookWithSecretsSchema,
  RATE_LIMIT_TOO_HIGH,
  TOO_MANY_WEBHOOKS,
  updateIncomingWebhookRequestSchema,
  WEBHOOK_IN_USE,
  WEBHOOK_NAME_TAKEN,
} from '../src/incoming-webhooks.js';

describe('incoming webhook requests (CONTRACTS §25.1)', () => {
  it.each([
    [{ name: 'Orders', auth: 'signature' }, true],
    [{ name: '  Orders  ', auth: 'both', rate_limit_per_sec: 20 }, true],
    [{ name: 'Orders', auth: 'none' }, true],
    [{ name: 'Orders', auth: 'bearer', rate_limit_per_sec: 1 }, true],
    [{ name: 'Orders' }, false], // auth is mandatory
    [{ name: 'Orders', auth: 'hmac' }, false],
    [{ name: '', auth: 'none' }, false],
    [{ name: '   ', auth: 'none' }, false],
    [{ name: 'x'.repeat(101), auth: 'none' }, false],
    [{ name: 'Orders', auth: 'none', rate_limit_per_sec: 0 }, false],
    [{ name: 'Orders', auth: 'none', rate_limit_per_sec: 1.5 }, false],
    [{ name: 'Orders', auth: 'none', rate_limit_per_sec: 1001 }, false],
    [{ name: 'Orders', auth: 'none', token: 'x' }, false], // strict
  ])('create %j → %s', (body, ok) => {
    expect(createIncomingWebhookRequestSchema.safeParse(body).success).toBe(ok);
  });

  it('trims the name', () => {
    expect(createIncomingWebhookRequestSchema.parse({ name: ' A ', auth: 'none' }).name).toBe('A');
  });

  it.each([
    [{ name: 'B' }, true],
    [{ enabled: false }, true],
    [{ rate_limit_per_sec: 10 }, true],
    [{ auth: 'none' }, true],
    [{}, false],
    [{ signing_secret: 'whsec_x' }, false],
    [{ base_id: newId('bse') }, false],
  ])('update %j → %s', (body, ok) => {
    expect(updateIncomingWebhookRequestSchema.safeParse(body).success).toBe(ok);
  });
});

describe('auth helpers', () => {
  it.each([
    ['signature', true, false],
    ['bearer', false, true],
    ['both', true, true],
    ['none', false, false],
  ] as const)('%s', (auth, signature, bearer) => {
    expect(authUsesSignature(auth)).toBe(signature);
    expect(authUsesBearer(auth)).toBe(bearer);
    expect(authOf(signature, bearer)).toBe(auth);
  });
});

describe('hook token pattern', () => {
  it.each([
    ['A'.repeat(43), true],
    ['abc_-DEF0123456789abcdefghijklmnopqrstuvwxy', true],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
    [`${'A'.repeat(42)}=`, false],
    [`${'A'.repeat(42)}/`, false],
  ])('%s → %s', (token, ok) => {
    expect(INCOMING_WEBHOOK_TOKEN_PATTERN.test(token)).toBe(ok);
  });
});

describe('responses', () => {
  const hook = {
    id: newId('hok'),
    base_id: newId('bse'),
    name: 'Orders',
    url: 'https://ob.example/api/v1/hooks/x',
    auth: 'signature',
    enabled: true,
    rate_limit_per_sec: 5,
    signing_secret_rotating_until: null,
    listen_until: null,
    sample_captured_at: null,
    last_received_at: null,
    usages: [{ automation_id: newId('aut'), name: null }],
    created_by: null,
    created_at: '2026-10-18T03:00:00.000Z',
    updated_at: '2026-10-18T03:00:00.000Z',
  };

  it('a plain hook has no secret fields; the issuing responses have both keys', () => {
    expect(incomingWebhookSchema.parse(hook)).not.toHaveProperty('signing_secret');
    expect(
      incomingWebhookWithSecretsSchema.safeParse({ ...hook, signing_secret: 'whsec_a' }).success,
    ).toBe(false);
    expect(
      incomingWebhookWithSecretsSchema.parse({
        ...hook,
        signing_secret: 'whsec_a',
        bearer_token: null,
      }).signing_secret,
    ).toBe('whsec_a');
  });

  it('a request log page carries metadata only', () => {
    const page = incomingWebhookRequestListSchema.parse({
      items: [
        {
          id: newId('whr'),
          received_at: '2026-10-18T03:00:00.000Z',
          size_bytes: 12,
          duplicate: false,
          causation_accepted: false,
          event_id: newId('evt'),
          body: { secret: 1 },
        },
      ],
      next_cursor: null,
    });
    expect(page.items[0]).not.toHaveProperty('body');
  });
});

describe('codes', () => {
  it('registers the detail codes, the 409 and the audit-only actions', () => {
    for (const code of [
      WEBHOOK_NAME_TAKEN,
      TOO_MANY_WEBHOOKS,
      RATE_LIMIT_TOO_HIGH,
      CREDENTIAL_REQUIRED,
      WEBHOOK_IN_USE,
    ]) {
      expect(INCOMING_WEBHOOK_DETAIL_CODES).toContain(code);
      expect(ERROR_DETAIL_CODES).toContain(code);
    }
    expect(ERROR_STATUS.WEBHOOK_IN_USE).toBe(409);
    for (const action of [
      'incoming_webhook.secret_rotated',
      'incoming_webhook.token_regenerated',
    ]) {
      expect(isEventType(action)).toBe(false);
      expect(isAuditAction(action)).toBe(true);
    }
    expect(isEventType('incoming_webhook.created')).toBe(true);
  });
});
