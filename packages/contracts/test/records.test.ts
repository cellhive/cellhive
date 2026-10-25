import { describe, expect, it } from 'vitest';

import {
  createRecordsRequestSchema,
  idempotencyKeySchema,
  recordGetQuerySchema,
  recordIdsRequestSchema,
  recordListQuerySchema,
  recordQueryRequestSchema,
  recordWriteParamsSchema,
  updateRecordsRequestSchema,
} from '../src/records.js';

const REC = 'rec_A1b2C3d4E5f6G7h8';

describe('record request schemas', () => {
  it.each([
    ['records wrapper', { records: [{ fields: { a: 1 } }] }, true],
    ['single fields', { fields: { a: 1 } }, true],
    ['both', { records: [{ fields: {} }], fields: {} }, false],
    ['neither', {}, false],
    ['empty records', { records: [] }, false],
    ['unknown key', { fields: {}, typecast: true }, false],
  ])('create: %s', (_name, body, ok) => {
    expect(createRecordsRequestSchema.safeParse(body).success).toBe(ok);
  });

  it.each([
    ['bulk update', { records: [{ id: REC, version: 1, fields: {} }] }, true],
    ['update without id', { records: [{ fields: {} }] }, false],
    ['upsert', { upsert: { merge_on: ['Code'] }, records: [{ fields: {} }] }, true],
    [
      'upsert with id',
      { upsert: { merge_on: ['Code'] }, records: [{ id: REC, fields: {} }] },
      false,
    ],
    [
      'upsert with 4 merge fields',
      { upsert: { merge_on: ['a', 'b', 'c', 'd'] }, records: [{ fields: {} }] },
      false,
    ],
    ['version 0', { records: [{ id: REC, version: 0, fields: {} }] }, false],
  ])('update: %s', (_name, body, ok) => {
    expect(updateRecordsRequestSchema.safeParse(body).success).toBe(ok);
  });

  it('reports the missing id at records[i].id', () => {
    const result = updateRecordsRequestSchema.safeParse({ records: [{ fields: {} }] });
    expect(result.error?.issues[0]?.path).toEqual(['records', 0, 'id']);
  });

  it('ids: 1–1 000 record ids', () => {
    expect(recordIdsRequestSchema.safeParse({ ids: [REC] }).success).toBe(true);
    expect(recordIdsRequestSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(recordIdsRequestSchema.safeParse({ ids: ['tbl_A1b2C3d4E5f6G7h8'] }).success).toBe(false);
  });

  it('query body defaults offset/limit and caps limit and sort', () => {
    expect(recordQueryRequestSchema.parse({})).toEqual({
      offset: 0,
      limit: 200,
      include_total: true,
    });
    expect(recordQueryRequestSchema.parse({ include_total: false }).include_total).toBe(false);
    expect(recordQueryRequestSchema.safeParse({ ids: ['rec_0123456789abcdef'] }).success).toBe(
      true,
    );
    expect(recordQueryRequestSchema.safeParse({ ids: ['usr_0123456789abcdef'] }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: 1001 }, () => 'rec_0123456789abcdef');
    expect(recordQueryRequestSchema.safeParse({ ids: tooMany }).success).toBe(false);
    expect(recordQueryRequestSchema.safeParse({ limit: 1001 }).success).toBe(false);
    const sort = Array.from({ length: 11 }, () => ({ field: 'a' }));
    expect(recordQueryRequestSchema.safeParse({ sort }).success).toBe(false);
    expect(recordQueryRequestSchema.parse({ sort: [{ field: 'a' }] }).sort).toEqual([
      { field: 'a', direction: 'asc' },
    ]);
  });
});

describe('record query-string schemas', () => {
  it('parses list parameters, JSON filter and sort', () => {
    const parsed = recordListQuerySchema.parse({
      fields: 'Tiêu đề, có dấu phẩy',
      filter: '{"logic":"and","conditions":[["A","==",1]]}',
      sort: '[{"field":"A","direction":"desc"}]',
      limit: '5',
    });
    expect(parsed).toEqual({
      field_key_type: 'name',
      cell_format: 'json',
      fields: ['Tiêu đề, có dấu phẩy'],
      filter: { logic: 'and', conditions: [['A', '==', 1]] },
      sort: [{ field: 'A', direction: 'desc' }],
      offset: 0,
      limit: 5,
    });
    expect(recordGetQuerySchema.parse({ fields: ['a', 'b'] }).fields).toEqual(['a', 'b']);
  });

  it('rejects malformed JSON with MALFORMED_JSON at the parameter', () => {
    const result = recordListQuerySchema.safeParse({ filter: '{nope' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['filter'],
      params: { code: 'MALFORMED_JSON' },
    });
    expect(recordListQuerySchema.safeParse({ sort: '{"field":"a"}' }).success).toBe(false);
  });

  it.each([
    [{}, false],
    [{ typecast: 'true' }, true],
    [{ typecast: '1' }, true],
    [{ typecast: 'false' }, false],
  ])('typecast %j → %s', (query, typecast) => {
    expect(recordWriteParamsSchema.parse(query).typecast).toBe(typecast);
  });

  it('rejects other typecast values', () => {
    expect(recordWriteParamsSchema.safeParse({ typecast: 'yes' }).success).toBe(false);
  });
});

describe('Idempotency-Key', () => {
  it.each([
    ['abc-123', true],
    ['x'.repeat(255), true],
    ['x'.repeat(256), false],
    ['', false],
    ['has space', false],
    ['không', false],
  ])('%s → %s', (key, ok) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(ok);
  });
});
