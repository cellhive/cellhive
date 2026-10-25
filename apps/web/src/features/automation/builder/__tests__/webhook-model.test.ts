import {
  INCOMING_WEBHOOK_LISTEN_SECONDS,
  MAX_VALUE_PATH_LENGTH,
  parseValuePath,
  WEBHOOK_TRIGGER_PARTS,
  webhookTemplateReferenceOf,
  type IncomingWebhookSample,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { pickerSections } from '../components/values/sections';
import { checkDraft } from '../model/check';
import { hasTriggerRecord, switchTrigger, BUILDER_TRIGGER_TYPES } from '../model/draft';
import { chipNameOf, sourceNameOf, type ValueScope } from '../model/scope';
import { referenceExpression, templateReference } from '../model/values';
import {
  countdownText,
  displayPath,
  flattenTree,
  formatValuePath,
  LISTEN_SECONDS,
  listenState,
  MAX_ARRAY_ITEMS,
  MAX_PATH_LENGTH,
  sampleTree,
  shortPreview,
  WEBHOOK_PARTS,
  webhookPathItems,
  webhookReferenceExpression,
  webhookReferenceOf,
  webhookValue,
} from '../triggers/webhook/model';

import type { TFunction } from 'i18next';

/** T612: the `webhook.received` trigger in the builder — sample tree, paths, references. */

function sample(overrides: Partial<IncomingWebhookSample> = {}): IncomingWebhookSample {
  return {
    body: {
      order: 42,
      customer: { email: 'lan@example.com', name: 'Lan', vip: true, note: null },
      items: [{ sku: 'A-1' }, { sku: 'B-2' }],
      'odd.key': 1,
    },
    headers: { 'content-type': 'application/json', 'x-shop-topic': 'orders/create' },
    query: { source: 'shop', tags: ['a', 'b'] },
    truncated: false,
    received_at: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('constants copied from the contracts', () => {
  it('match', () => {
    expect(LISTEN_SECONDS).toBe(INCOMING_WEBHOOK_LISTEN_SECONDS);
    expect(MAX_PATH_LENGTH).toBe(MAX_VALUE_PATH_LENGTH);
    expect(WEBHOOK_PARTS).toEqual(WEBHOOK_TRIGGER_PARTS);
  });
});

describe('formatValuePath', () => {
  it.each([
    [[], ''],
    [['customer', 'email'], 'customer.email'],
    [['items', 0, 'sku'], 'items[0].sku'],
    [[0], '[0]'],
    [[0, 'a', 1], '[0].a[1]'],
    [['x-shop-topic'], 'x-shop-topic'],
    [['odd.key'], null],
    [['a[b'], null],
    [['a]'], null],
    [[''], null],
  ] as const)('%j → %j', (path, expected) => {
    expect(formatValuePath(path)).toBe(expected);
    // What it writes, the server's parser reads back.
    if (expected !== null && expected !== '') expect(parseValuePath(expected)).toEqual(path);
  });
});

describe('displayPath', () => {
  it.each([
    ['body', '', 'body'],
    ['body', 'customer.email', 'body.customer.email'],
    ['body', '[0].sku', 'body[0].sku'],
    ['headers', 'x-shop-topic', 'headers.x-shop-topic'],
  ] as const)('%s + %j → %s', (part, path, expected) => {
    expect(displayPath(part, path)).toBe(expected);
  });
});

describe('webhook template references', () => {
  it.each([
    ['body', '', '[@body]'],
    ['body', 'customer.email', '[@body.customer.email]'],
    ['body', 'items[0].sku', '[@body.items[0\\].sku]'],
    ['body', '[0].sku', '[@body[0\\].sku]'],
    ['headers', 'x-shop-topic', '[@headers.x-shop-topic]'],
    ['query', 'tags[1]', '[@query.tags[1\\]]'],
    ['body', 'a\\b', '[@body.a\\\\b]'],
  ] as const)('%s %j ↔ %s', (part, path, expression) => {
    expect(webhookReferenceExpression(part, path)).toBe(expression);
    expect(webhookReferenceOf(expression)).toEqual({ part, pathText: path });
    // The id inside the brackets is one the server accepts (`webhookTemplateReferenceOf`).
    const id = expression.slice(1, -1).replace(/\\(.)/gu, '$1');
    expect(webhookTemplateReferenceOf(id)).not.toBeNull();
  });

  it.each([
    '[@fired_at]',
    '[@bodyx]',
    '[@body.]',
    '[@body..a]',
    '[@body].[fld_x]',
    '[@body.items[0].sku]',
    '[fld_abc]',
    '@body',
    '[@body.a[x\\]]',
  ])('%s is not one webhook reference', (expression) => {
    expect(webhookReferenceOf(expression)).toBeNull();
  });

  it('is a reference kind of the template model, named by its path', () => {
    const reference = templateReference(' [@body.customer.email] ');
    expect(reference).toEqual({ kind: 'webhook', part: 'body', pathText: 'customer.email' });
    if (reference === null) throw new Error('not a reference');
    expect(referenceExpression(reference)).toBe('[@body.customer.email]');
    const scope: ValueScope = { triggerType: 'webhook.received', triggerTableId: null, steps: [] };
    const names = { fieldsOf: () => [] };
    expect(chipNameOf('[@body.items[0\\].sku]', scope, names)).toEqual({
      tone: 'trigger',
      webhook: 'body.items[0].sku',
    });
    // Another trigger has no webhook data: #REF.
    expect(chipNameOf('[@body.x]', { ...scope, triggerType: 'schedule' }, names)).toEqual({
      tone: 'error',
      ref: '@body',
    });
    expect(sourceNameOf({ trigger: 'query', path: 'source' }, scope, names)).toEqual({
      tone: 'trigger',
      webhook: 'query.source',
    });
    expect(sourceNameOf({ trigger: 'headers' }, scope, names)).toEqual({
      tone: 'trigger',
      webhook: 'headers',
    });
  });
});

describe('webhookValue', () => {
  it.each([
    ['body', '', { trigger: 'body' }],
    ['body', 'customer.email', { trigger: 'body', path: 'customer.email' }],
    ['query', 'tags[0]', { trigger: 'query', path: 'tags[0]' }],
  ] as const)('%s %j', (part, path, expected) => {
    expect(webhookValue(part, path)).toEqual(expected);
  });
});

describe('sampleTree', () => {
  it('builds body, headers and query with paths, kinds, previews', () => {
    const trees = sampleTree(sample());
    const [body] = trees;
    expect(body?.kind).toBe('object');
    expect(body?.size).toBe(4);
    const nodes = Object.fromEntries(flattenTree(trees).map((n) => [n.id, n]));
    expect(nodes['body.customer.email']).toMatchObject({
      pathText: 'customer.email',
      kind: 'string',
      preview: '"lan@example.com"',
      pickable: true,
    });
    expect(nodes['body.customer.vip']?.preview).toBe('true');
    expect(nodes['body.customer.note']?.kind).toBe('null');
    expect(nodes['body.items[1].sku']?.pathText).toBe('items[1].sku');
    expect(nodes['body.items']).toMatchObject({ kind: 'array', size: 2 });
    expect(nodes['headers.x-shop-topic']?.preview).toBe('"orders/create"');
    expect(nodes['query.tags[1]']?.preview).toBe('"b"');
    // A key with "." cannot be written in a path.
    expect(Object.values(nodes).find((n) => n.key === 'odd.key')?.pickable).toBe(false);
  });

  it('shows the first 20 items of a list and counts the rest', () => {
    const [body] = sampleTree(sample({ body: Array.from({ length: 25 }, (_, i) => i) }));
    expect(body?.children).toHaveLength(MAX_ARRAY_ITEMS);
    expect(body?.hidden).toBe(5);
  });

  it('cuts long strings in the preview', () => {
    const [body] = sampleTree(sample({ body: { text: 'x'.repeat(100) } }));
    expect(body?.children[0]?.preview).toBe(`"${'x'.repeat(60)}…"`);
    expect(shortPreview(body?.children[0]?.preview ?? null)).toHaveLength(24);
    expect(shortPreview('"ok"')).toBe('"ok"');
    expect(shortPreview(null)).toBeUndefined();
  });

  it('keeps a truncated body whole, with no path inside', () => {
    const [body] = sampleTree(sample({ body: '{"order": 1, "big": "…', truncated: true }));
    expect(body).toMatchObject({ truncated: true, children: [], pickable: true, pathText: '' });
    const items = webhookPathItems(sample({ body: '{"order": 1', truncated: true }));
    expect(items.filter((item) => item.part === 'body').map((item) => item.label)).toEqual([
      'body',
    ]);
  });

  it('stops at the node cap', () => {
    const big = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${String(i)}`, i]));
    const nodes = flattenTree(sampleTree(sample({ body: big })));
    // The three parts are always there (headers and query past the cap, without children).
    expect(nodes.length).toBeLessThanOrEqual(1000 + 2);
    expect(nodes.at(-1)?.id).toBe('query');
  });
});

describe('webhookPathItems', () => {
  it('offers the whole parts without a sample', () => {
    expect(webhookPathItems(null).map((item) => item.label)).toEqual(['body', 'headers', 'query']);
  });

  it('adds the pickable paths of the sample, never sensitive headers it does not have', () => {
    const labels = webhookPathItems(sample()).map((item) => item.label);
    expect(labels).toContain('body.customer.email');
    expect(labels).toContain('query.source');
    expect(labels).toContain('headers.content-type');
    expect(labels).not.toContain('body.odd.key');
    expect(labels.some((label) => label.includes('authorization'))).toBe(false);
  });
});

describe('the "+" menu of a webhook trigger', () => {
  const t = ((key: string) => key) as unknown as TFunction<'automationBuilder'>;
  const scope: ValueScope = { triggerType: 'webhook.received', triggerTableId: null, steps: [] };
  it.each([
    ['value', { trigger: 'body', path: 'customer.email' }],
    ['template', '[@body.customer.email]'],
  ] as const)('%s mode picks %j', (mode, expected) => {
    const sections = pickerSections({
      scope,
      names: { fieldsOf: () => [], webhookSample: sample() },
      tableName: () => undefined,
      mode,
      t,
    });
    const webhook = sections.find((section) => section.key === 'webhook');
    const item = webhook?.items.find((entry) => entry.label === 'body.customer.email');
    expect(item?.hint).toBe('"lan@example.com"');
    expect(item?.pick).toEqual(
      mode === 'value' ? { kind: 'value', value: expected } : { kind: 'ref', expression: expected },
    );
  });

  it('is absent for other triggers', () => {
    const sections = pickerSections({
      scope: { ...scope, triggerType: 'schedule' },
      names: { fieldsOf: () => [], webhookSample: sample() },
      tableName: () => undefined,
      mode: 'value',
      t,
    });
    expect(sections.some((section) => section.key === 'webhook')).toBe(false);
  });
});

describe('listenState', () => {
  const now = 1_000_000;
  it.each([
    ['not listening, no sample', { sample: null, deadline: null, startedHere: false }, 'idle'],
    [
      'listening',
      { sample: null, deadline: now + 125_000, startedHere: true },
      { kind: 'listening', secondsLeft: 125 },
    ],
    [
      'captured',
      { sample: sample(), deadline: null, startedHere: true },
      { kind: 'captured', receivedAt: '2026-10-18T10:00:00.000Z' },
    ],
    ['ran out here', { sample: null, deadline: now - 1, startedHere: true }, 'expired'],
    ['ran out elsewhere', { sample: null, deadline: now - 1, startedHere: false }, 'idle'],
    [
      'old sample after the window',
      { sample: sample(), deadline: now - 1, startedHere: true },
      { kind: 'captured', receivedAt: '2026-10-18T10:00:00.000Z' },
    ],
  ] as const)('%s', (_name, input, expected) => {
    const state = listenState({ ...input, now });
    if (typeof expected === 'string') expect(state.kind).toBe(expected);
    else expect(state).toEqual(expected);
  });

  it.each([
    [180, '3:00'],
    [125, '2:05'],
    [9, '0:09'],
    [-3, '0:00'],
  ])('countdown %i → %s', (seconds, text) => {
    expect(countdownText(seconds)).toBe(text);
  });
});

describe('the trigger in the draft model', () => {
  it('is offered, has no record, and needs a hook before saving', () => {
    expect(BUILDER_TRIGGER_TYPES).toContain('webhook.received');
    const trigger = switchTrigger(
      { type: 'record.created', table_id: 'tbl_A', skip_bulk: false },
      'webhook.received',
      'tbl_A',
    );
    expect(trigger).toEqual({ type: 'webhook.received', incoming_webhook_id: '' });
    expect(hasTriggerRecord(trigger)).toBe(false);
    const context = {
      name: 'Orders in',
      conditions: new Map(),
      orgTimeZone: 'UTC',
      now: new Date(),
    };
    expect(
      checkDraft({ trigger, condition: null, actions: [] }, context).map((i) => [i.path, i.code]),
    ).toEqual([['incoming_webhook_id', 'REQUIRED']]);
    expect(
      checkDraft(
        {
          trigger: { type: 'webhook.received', incoming_webhook_id: 'hok_Shop000000000001' },
          condition: null,
          actions: [],
        },
        context,
      ),
    ).toEqual([]);
  });
});
