import { describe, expect, it } from 'vitest';

import { auditViaSchema } from '../src/audit.js';
import { AUTOMATION_RUN_ERROR_CODES, AUTOMATION_STEP_ERROR_CODES } from '../src/automation-runs.js';
import {
  automationDefinitionSchema,
  INVALID_CONDITION,
  isTemplateReferenceId,
  TEMPLATE_STEP_ERROR_CODES,
  UNKNOWN_WEBHOOK,
  validateAutomationTemplateRequestSchema,
  webhookTemplateReferenceOf,
} from '../src/automations.js';
import { AUTOMATION_DETAIL_CODES } from '../src/error-details.js';
import { eventViaSchema } from '../src/events.js';

const HOOK = 'hok_A1b2C3d4E5f6G7h8';

/** BACKLOG T604 (CONTRACTS §21, ADR-35 §2): the `webhook.received` trigger and its data. */
describe('webhook.received trigger (T604)', () => {
  it('parses `{ type, incoming_webhook_id }` with a null condition', () => {
    expect(
      automationDefinitionSchema.parse({
        trigger: { type: 'webhook.received', incoming_webhook_id: HOOK },
      }),
    ).toEqual({
      trigger: { type: 'webhook.received', incoming_webhook_id: HOOK },
      condition: null,
      actions: [],
    });
  });

  it('lists its save, step and run codes', () => {
    expect(AUTOMATION_DETAIL_CODES).toEqual(
      expect.arrayContaining([UNKNOWN_WEBHOOK, INVALID_CONDITION]),
    );
    expect(AUTOMATION_STEP_ERROR_CODES).toContain('trigger_data_expired');
    expect(TEMPLATE_STEP_ERROR_CODES).toContain('trigger_data_expired');
    expect(AUTOMATION_RUN_ERROR_CODES).toContain('webhook_deleted');
  });

  it('lets validate-template name it', () => {
    expect(
      validateAutomationTemplateRequestSchema.parse({
        table_id: null,
        template: '{{ [@body.customer.email] }}',
        trigger_type: 'webhook.received',
      }),
    ).toMatchObject({ trigger_type: 'webhook.received' });
  });

  it('adds incoming_webhook_id to the via of events and audit entries', () => {
    const via = { automation_id: 'aut_A1b2C3d4E5f6G7h8', run_id: 'run_A1b2C3d4E5f6G7h8' };
    expect(eventViaSchema.parse({ ...via, incoming_webhook_id: HOOK })).toMatchObject({
      incoming_webhook_id: HOOK,
    });
    expect(auditViaSchema.parse({ ...via, incoming_webhook_id: HOOK })).toMatchObject({
      incoming_webhook_id: HOOK,
    });
    expect(eventViaSchema.safeParse({ ...via, incoming_webhook_id: 'hok_x' }).success).toBe(false);
  });
});

describe('webhook template references (T604)', () => {
  it.each([
    ['@body', { part: 'body', path: [] }],
    ['@headers', { part: 'headers', path: [] }],
    ['@query', { part: 'query', path: [] }],
    ['@body.customer.email', { part: 'body', path: ['customer', 'email'] }],
    ['@body.items[0].sku', { part: 'body', path: ['items', 0, 'sku'] }],
    ['@body[1]', { part: 'body', path: [1] }],
    ['@headers.x-shop-topic', { part: 'headers', path: ['x-shop-topic'] }],
    ['@query.tags[2]', { part: 'query', path: ['tags', 2] }],
    ['@body.tên khách', { part: 'body', path: ['tên khách'] }],
  ])('%s parses', (id, expected) => {
    expect(webhookTemplateReferenceOf(id)).toEqual(expected);
    expect(isTemplateReferenceId(id)).toBe(true);
  });

  it.each(['@body.', '@body..x', '@body.a[x]', '@cookies.a', `@body.${'a'.repeat(501)}`, 'body.a'])(
    '%s is not one',
    (id) => {
      expect(webhookTemplateReferenceOf(id)).toBeNull();
      expect(isTemplateReferenceId(id)).toBe(false);
    },
  );

  it('a plain `@name` stays a trigger reference, not webhook data', () => {
    expect(webhookTemplateReferenceOf('@bodyx')).toBeNull();
    expect(isTemplateReferenceId('@bodyx')).toBe(true);
  });
});
