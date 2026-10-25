import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/client';
import { retryDelay, shouldRetry } from '../client';
import { keys, recordQueryHash, stableQueryHash } from '../keys';
import { recordBlockQuery, recordBlockRange } from '../queries';

describe('query keys (FRONTEND §3.2)', () => {
  it.each([
    [keys.me(), ['me']],
    [keys.setupStatus(), ['setup']],
    [keys.orgs(), ['orgs']],
    [keys.workspaces('org_1'), ['org', 'org_1', 'workspaces']],
    [keys.workspace('wsp_1'), ['workspace', 'wsp_1']],
    [keys.bases('wsp_1'), ['workspace', 'wsp_1', 'bases']],
    [keys.base('bse_1'), ['base', 'bse_1']],
    [keys.tables('bse_1'), ['base', 'bse_1', 'tables']],
    [keys.fields('tbl_1'), ['table', 'tbl_1', 'fields']],
    [keys.fieldTrash('tbl_1'), ['table', 'tbl_1', 'fields', 'trash']],
    [keys.views('tbl_1'), ['table', 'tbl_1', 'views']],
    [keys.recordBlock('tbl_1', 'h', 42, 3), ['table', 'tbl_1', 'records', 'h', 42, 3]],
    [keys.record('tbl_1', 'rec_1'), ['table', 'tbl_1', 'record', 'rec_1']],
    [keys.recordHistory('rec_1'), ['record', 'rec_1', 'history']],
    [keys.recordHistory('rec_1', 'fld_1'), ['record', 'rec_1', 'history', 'fld_1']],
    [keys.widgetData('wgt_1', 'h'), ['widget', 'wgt_1', 'h']],
    [keys.roles('bse_1'), ['base', 'bse_1', 'roles']],
    [keys.table('tbl_1'), ['table', 'tbl_1']],
    [keys.tableMeta('tbl_1'), ['table', 'tbl_1', 'meta']],
    [keys.recordBlocks('tbl_1'), ['table', 'tbl_1', 'records']],
    [keys.recordTrash('tbl_1'), ['table', 'tbl_1', 'trash']],
    [keys.job('job_1'), ['job', 'job_1']],
  ])('builds %j', (actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it('nests table data under the table prefix, base data under the base prefix', () => {
    const tablePrefix = ['table', 'tbl_1'];
    for (const key of [
      keys.fields('tbl_1'),
      keys.views('tbl_1'),
      keys.record('tbl_1', 'r'),
      keys.tableMeta('tbl_1'),
      keys.recordTrash('tbl_1'),
      keys.recordBlock('tbl_1', 'h', 1, 0),
    ]) {
      expect(key.slice(0, 2)).toEqual(tablePrefix);
      expect(key.slice(0, 2)).toEqual(keys.table('tbl_1'));
    }
    expect(keys.recordBlock('tbl_1', 'h', 1, 0).slice(0, 3)).toEqual(keys.recordBlocks('tbl_1'));
    expect(keys.recordHistory('rec_1', 'fld_1').slice(0, 3)).toEqual(keys.recordHistory('rec_1'));
    expect(keys.tables('bse_1').slice(0, 2)).toEqual(keys.base('bse_1'));
    expect(keys.roles('bse_1').slice(0, 2)).toEqual(keys.base('bse_1'));
    expect(keys.bases('wsp_1').slice(0, 2)).toEqual(keys.workspace('wsp_1'));
  });

  it('changes the record block key when the permission version changes', () => {
    expect(keys.recordBlock('tbl_1', 'h', 1, 0)).not.toEqual(keys.recordBlock('tbl_1', 'h', 2, 0));
  });
});

describe('stableQueryHash', () => {
  it('ignores object key order and undefined values', () => {
    expect(stableQueryHash({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe(
      stableQueryHash({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('keeps array order', () => {
    expect(stableQueryHash({ sort: ['a', 'b'] })).not.toBe(stableQueryHash({ sort: ['b', 'a'] }));
  });

  it('hashes undefined like null', () => {
    expect(stableQueryHash(undefined)).toBe('null');
  });
});

describe('recordQueryHash', () => {
  const query = {
    view_id: 'viw_1',
    filter: { op: 'and', items: [{ field: 'fld_1', op: 'is', value: 'A' }] },
    sort: [{ field: 'fld_2', direction: 'desc' as const }],
    search: 'an phat',
    fields: ['fld_1', 'fld_2'],
  };

  it('does not depend on key order', () => {
    const reordered = {
      fields: ['fld_1', 'fld_2'],
      search: 'an phat',
      sort: [{ direction: 'desc' as const, field: 'fld_2' }],
      filter: { items: [{ value: 'A', op: 'is', field: 'fld_1' }], op: 'and' },
      view_id: 'viw_1',
    };
    expect(recordQueryHash(reordered)).toBe(recordQueryHash(query));
  });

  it('is the same on every call (stable across renders)', () => {
    expect(recordQueryHash(structuredClone(query))).toBe(recordQueryHash(query));
  });

  it('treats absent, null, empty string and empty lists as unset', () => {
    const empty = recordQueryHash({});
    expect(recordQueryHash({ view_id: null, filter: null, sort: [], search: '' })).toBe(empty);
    expect(recordQueryHash({ sort: null, search: null, group: null, fields: null })).toBe(empty);
  });

  it('defaults the sort direction to asc', () => {
    expect(recordQueryHash({ sort: [{ field: 'fld_1' }] })).toBe(
      recordQueryHash({ sort: [{ field: 'fld_1', direction: 'asc' }] }),
    );
  });

  it.each([
    ['view', { view_id: 'viw_2' }],
    ['filter', { filter: { op: 'or', items: [] } }],
    ['sort order', { sort: [{ field: 'fld_2', direction: 'asc' as const }] }],
    ['search', { search: 'other' }],
    ['group', { group: [{ field: 'fld_1' }] }],
    ['fields', { fields: ['fld_2', 'fld_1'] }],
    ['no fields', { fields: [] }],
    ['no group (the view group set aside)', { group: [] }],
    ['filter mode replace', { filter_mode: 'replace' as const }],
    ['sort mode replace', { sort_mode: 'replace' as const }],
  ])('changes with the %s', (_name, change) => {
    expect(recordQueryHash({ ...query, ...change })).not.toBe(recordQueryHash(query));
  });

  it('ignores the default modes', () => {
    expect(recordQueryHash({ ...query, filter_mode: 'and', sort_mode: 'append' })).toBe(
      recordQueryHash(query),
    );
  });

  it('ignores paging, so every block of a query shares the hash', () => {
    const paged = { ...query, offset: 400, limit: 200, include_total: false };
    expect(recordQueryHash(paged)).toBe(recordQueryHash(query));
  });

  it('builds block query options with the hash, permission version and range', () => {
    const options = recordBlockQuery('tbl_1', query, 7, 3);
    expect(options.queryKey).toEqual(['table', 'tbl_1', 'records', recordQueryHash(query), 7, 3]);
    expect(recordBlockRange(3)).toEqual({ offset: 600, limit: 200 });
  });
});

describe('shouldRetry', () => {
  const error = (status: number) => new ApiError({ status, code: 'INTERNAL' });
  it.each([
    [0, error(500), true],
    [2, error(500), false],
    [0, error(404), false],
    [0, error(401), false],
    [0, error(429), true],
    [1, error(429), true],
    [2, error(429), false],
    [0, error(408), true],
    [1, error(408), false],
    [0, new TypeError('x'), true],
  ])('attempt %i after %o → %s', (count, failure, expected) => {
    expect(shouldRetry(count, failure)).toBe(expected);
  });
});

describe('retryDelay (T470)', () => {
  const limited = (seconds?: number) =>
    new ApiError({ status: 429, code: 'RATE_LIMITED', retry_after: seconds });
  it.each([
    ['a 429 waits for its Retry-After plus jitter', 0, limited(1), 0.5, 1125],
    ['no jitter at 0', 1, limited(2), 0, 2000],
    ['a long Retry-After is capped', 0, limited(120), 0, 30_000],
    ['a 429 without Retry-After backs off', 1, limited(), 0.5, 2000],
    ['other errors back off', 0, new ApiError({ status: 500, code: 'INTERNAL' }), 0.5, 1000],
  ] as const)('%s', (_name, count, failure, random, expected) => {
    expect(retryDelay(count, failure, () => random)).toBe(expected);
  });
});
