import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  dropNullOptionals,
  LLM_SCHEMA_MAX_DEPTH,
  llmJsonSchema,
  type JsonSchemaNode,
} from '../../src/ai/index.js';

/** Names from a digest (T907–T910 put the readable fields, options, tables here). */
const TABLES = ['Tickets', 'Orders'] as const;
const FIELDS = ['Trạng thái', 'Phụ trách', 'Doanh thu', 'Ngày'] as const;
const OPS = ['is', 'is_not', 'contains', 'gt', 'lt'] as const;

const tuple = z.tuple([
  z.enum(FIELDS),
  z.enum(OPS),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
]);

/** The S8 LLM schemas, in the shape their tasks describe (BACKLOG T907–T910). */
const formulaAnswer = z.strictObject({ formula: z.string(), explanation: z.string() });

const askPlan = z.strictObject({
  answerable: z.boolean(),
  chart: z.enum(['kpi', 'bar', 'line', 'pie', 'table']),
  title: z.string().max(200),
  metric: z.strictObject({
    aggregation: z.enum(['count', 'sum', 'avg', 'min', 'max', 'count_distinct']),
    field: z.enum(FIELDS).nullable(),
  }),
  dimension: z
    .strictObject({
      field: z.enum(FIELDS),
      date_bucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
    })
    .optional(),
  series: z.strictObject({ field: z.enum(FIELDS) }).optional(),
  filter: z.array(tuple).max(10).optional(),
  sort: z.enum(['value_desc', 'value_asc', 'label_asc']).optional(),
  limit: z.int().min(1).max(50).optional(),
  compare: z.boolean().default(false),
});

const automationDraft = z.strictObject({
  name: z.string().min(1).max(100),
  trigger: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('record.created'), table: z.enum(TABLES) }),
    z.strictObject({
      type: z.literal('record.updated'),
      table: z.enum(TABLES),
      watch_fields: z.array(z.enum(FIELDS)).max(10),
      changed_to: z.string().nullable(),
    }),
    z.strictObject({ type: z.literal('schedule'), cron: z.string() }),
  ]),
  condition: z.array(tuple).max(10).optional(),
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('send_notification'),
          recipients_field: z.enum(FIELDS),
          message: z.string(),
        }),
        z.strictObject({ type: z.literal('delay'), minutes: z.int().min(1).max(10_080) }),
      ]),
    )
    .min(1)
    .max(5),
  explanation: z.string(),
  warnings: z.array(
    z.strictObject({
      code: z.enum(['unsupported_action', 'unsupported_trigger', 'ambiguous']),
      message: z.string(),
    }),
  ),
});

const fieldText = z.strictObject({ text: z.string().max(10_000) });
const fieldSelect = z.enum(['Cao', 'Trung bình', 'Thấp']);
const unionRoot = z.union([
  z.strictObject({ ok: z.literal(true), value: z.number() }),
  z.strictObject({ ok: z.literal(false), reason: z.string() }),
]);
const discriminatedRoot = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('a'), a: z.string() }),
  z.strictObject({ kind: z.literal('b'), b: z.number() }),
]);
const sharedEnum = z.enum(['x', 'y']).meta({ id: 'T905SharedEnum', description: 'Shared' });
const withDefs = z.object({ first: sharedEnum, second: sharedEnum.optional() });

/** Keywords outside the strict subset (or that the conversion must remove). */
const FORBIDDEN = [
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'prefixItems',
  '$ref',
  '$defs',
  '$schema',
  'const',
  'default',
  'pattern',
  'format',
  'minLength',
  'maxLength',
];

/** Checks the strict-mode rules on every node; returns the deepest object/array nesting. */
function checkStrict(node: JsonSchemaNode, depth = 1): number {
  for (const key of FORBIDDEN) expect(node, `keyword ${key}`).not.toHaveProperty(key);
  let deepest = depth;
  const properties = node['properties'];
  if (properties !== undefined) {
    expect(node['additionalProperties']).toBe(false);
    expect(node['required']).toEqual(Object.keys(properties as object));
    for (const child of Object.values(properties as Record<string, JsonSchemaNode>)) {
      deepest = Math.max(deepest, checkStrict(child, depth + 1));
    }
  }
  if (node['items'] !== undefined) {
    deepest = Math.max(deepest, checkStrict(node['items'] as JsonSchemaNode, depth + 1));
  }
  for (const branch of (node['anyOf'] as JsonSchemaNode[] | undefined) ?? []) {
    deepest = Math.max(deepest, checkStrict(branch, depth));
  }
  return deepest;
}

describe('llmJsonSchema: zod → strict JSON Schema (T905)', () => {
  it.each([
    ['formula answer (T907)', formulaAnswer, false],
    ['automation draft (T908)', automationDraft, false],
    ['Q&A plan (T909)', askPlan, false],
    ['field AI text (T910)', fieldText, false],
    ['field AI select (T910)', fieldSelect, true],
    ['union root', unionRoot, true],
    ['discriminated union root', discriminatedRoot, true],
    ['shared $defs', withDefs, false],
  ] as const)('%s fits the strict subset', (_name, schema, wrapped) => {
    const converted = llmJsonSchema(schema);
    expect(converted.wrapped).toBe(wrapped);
    expect(converted.schema['type']).toBe('object');
    expect(checkStrict(converted.schema)).toBeLessThanOrEqual(LLM_SCHEMA_MAX_DEPTH);
  });

  it('makes optional keys required and nullable', () => {
    const { schema } = llmJsonSchema(askPlan);
    const properties = schema['properties'] as Record<string, JsonSchemaNode>;
    expect(properties['limit']).toEqual({ type: ['integer', 'null'], minimum: 1, maximum: 50 });
    expect(properties['sort']).toEqual({
      anyOf: [{ type: 'string', enum: ['value_desc', 'value_asc', 'label_asc'] }, { type: 'null' }],
    });
    // An object becomes `anyOf [object, null]`, its own optional keys too.
    const dimension = properties['dimension']?.['anyOf'] as JsonSchemaNode[];
    expect(dimension[1]).toEqual({ type: 'null' });
    expect(dimension[0]?.['required']).toEqual(['field', 'date_bucket']);
    // Already nullable and required: unchanged; a default is required, without `default`.
    expect(
      (properties['metric']?.['properties'] as Record<string, JsonSchemaNode>)['field'],
    ).toEqual({
      anyOf: [{ type: 'string', enum: [...FIELDS] }, { type: 'null' }],
    });
    expect(properties['compare']).toEqual({ type: 'boolean' });
  });

  it('turns a tuple into an array of its members with a fixed length', () => {
    const { schema } = llmJsonSchema(z.strictObject({ filter: z.array(tuple) }));
    const items = (schema['properties'] as Record<string, JsonSchemaNode>)['filter']?.['items'];
    expect(items).toEqual({
      type: 'array',
      items: {
        anyOf: [
          { type: 'string', enum: [...FIELDS] },
          { type: 'string', enum: [...OPS] },
          { type: ['string', 'number', 'boolean', 'null'] },
        ],
      },
      minItems: 3,
      maxItems: 3,
    });
  });

  it('turns oneOf into anyOf and const into a one-value enum', () => {
    const { schema } = llmJsonSchema(automationDraft);
    const trigger = (schema['properties'] as Record<string, JsonSchemaNode>)['trigger'];
    const branches = trigger?.['anyOf'] as JsonSchemaNode[];
    expect(branches).toHaveLength(3);
    expect((branches[0]?.['properties'] as Record<string, JsonSchemaNode>)['type']).toEqual({
      type: 'string',
      enum: ['record.created'],
    });
  });

  it('wraps a non-object root in { result }', () => {
    expect(llmJsonSchema(fieldSelect).schema).toEqual({
      type: 'object',
      properties: { result: { type: 'string', enum: ['Cao', 'Trung bình', 'Thấp'] } },
      required: ['result'],
      additionalProperties: false,
    });
    const union = llmJsonSchema(unionRoot).schema['properties'] as Record<string, JsonSchemaNode>;
    expect(union['result']?.['anyOf']).toHaveLength(2);
  });

  it('inlines $defs and keeps descriptions', () => {
    const properties = llmJsonSchema(withDefs).schema['properties'] as Record<
      string,
      JsonSchemaNode
    >;
    expect(properties['first']).toEqual({
      type: 'string',
      enum: ['x', 'y'],
      description: 'Shared',
    });
    expect(properties['second']).toEqual({
      anyOf: [{ type: 'string', enum: ['x', 'y'], description: 'Shared' }, { type: 'null' }],
    });
  });

  it.each([
    [
      'a recursive schema',
      (() => {
        const node: z.ZodType = z.object({ children: z.array(z.lazy(() => node)) });
        return node;
      })(),
    ],
    ['a map', z.object({ values: z.record(z.string(), z.number()) })],
    [
      'more than 10 levels',
      Array.from({ length: LLM_SCHEMA_MAX_DEPTH }).reduce<z.ZodType>(
        (inner) => z.object({ inner }),
        z.object({ leaf: z.string() }),
      ),
    ],
  ])('refuses %s (RangeError)', (_name, schema) => {
    expect(() => llmJsonSchema(schema)).toThrow(RangeError);
  });
});

describe('dropNullOptionals: answers back to the zod shape (T905)', () => {
  it.each([
    [
      'Q&A plan: null optionals removed, required nullable kept',
      askPlan,
      {
        answerable: true,
        chart: 'bar',
        title: 'Doanh thu theo tháng',
        metric: { aggregation: 'sum', field: null },
        dimension: { field: 'Ngày', date_bucket: null },
        series: null,
        filter: null,
        sort: null,
        limit: null,
        compare: false,
      },
      {
        answerable: true,
        chart: 'bar',
        title: 'Doanh thu theo tháng',
        metric: { aggregation: 'sum', field: null },
        dimension: { field: 'Ngày' },
        compare: false,
      },
    ],
    [
      'automation draft: the branch of the union by its const',
      automationDraft,
      {
        name: 'Ticket xong',
        trigger: {
          type: 'record.updated',
          table: 'Tickets',
          watch_fields: ['Trạng thái'],
          changed_to: null,
        },
        condition: null,
        actions: [{ type: 'send_notification', recipients_field: 'Phụ trách', message: 'Xong' }],
        explanation: '',
        warnings: [],
      },
      {
        name: 'Ticket xong',
        trigger: {
          type: 'record.updated',
          table: 'Tickets',
          watch_fields: ['Trạng thái'],
          changed_to: null,
        },
        actions: [{ type: 'send_notification', recipients_field: 'Phụ trách', message: 'Xong' }],
        explanation: '',
        warnings: [],
      },
    ],
    ['wrapped select', fieldSelect, { result: 'Cao' }, { result: 'Cao' }],
  ] as const)('%s', (_name, schema, answer, expected) => {
    const converted = llmJsonSchema(schema);
    const value = dropNullOptionals(answer, converted.source);
    expect(value).toEqual(expected);
    const zodSchema: z.ZodType = converted.wrapped ? z.object({ result: schema }) : schema;
    expect(zodSchema.safeParse(value).success).toBe(true);
  });
});
