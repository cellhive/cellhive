import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { daysLeft, restoreInChunks } from '../restore';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `rec_${String(index)}`);

function uniqueViolation(paths: readonly string[]): ApiError {
  return new ApiError({
    status: 422,
    code: 'UNIQUE_VIOLATION',
    errors: paths.map((path) => ({ path, code: 'UNIQUE_VIOLATION', message: 'taken' })),
  });
}

describe('restoreInChunks', () => {
  it.each([
    [0, []],
    [1, [1]],
    [1000, [1000]],
    [1001, [1000, 1]],
    [2500, [1000, 1000, 500]],
  ])('restores %i ids in chunks of at most 1000', async (count, sizes) => {
    const restore = vi.fn<(chunk: readonly string[]) => Promise<void>>(() => Promise.resolve());
    const outcome = await restoreInChunks(ids(count), restore);
    expect(restore.mock.calls.map(([chunk]) => chunk.length)).toEqual(sizes);
    expect(outcome.restored).toHaveLength(count);
    expect(outcome.failed.size).toBe(0);
  });

  it('sets aside the records named by errors[] and restores the rest of the chunk', async () => {
    const restore = vi
      .fn<(chunk: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(uniqueViolation(['ids[1]', 'ids[3]']))
      .mockResolvedValueOnce(undefined);
    const outcome = await restoreInChunks(['a', 'b', 'c', 'd'], restore);
    expect(restore).toHaveBeenNthCalledWith(2, ['a', 'c']);
    expect(outcome.restored).toEqual(['a', 'c']);
    expect([...outcome.failed.keys()]).toEqual(['b', 'd']);
    expect(outcome.failed.get('b')?.item?.code).toBe('UNIQUE_VIOLATION');
  });

  it('maps errors[] indices to the ids of the request that failed (after a retry)', async () => {
    const restore = vi
      .fn<(chunk: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(uniqueViolation(['ids[0]']))
      .mockRejectedValueOnce(
        new ApiError({
          status: 404,
          code: 'NOT_FOUND',
          errors: [{ path: 'ids[1]', code: 'NOT_FOUND', message: 'gone' }],
        }),
      )
      .mockResolvedValueOnce(undefined);
    const outcome = await restoreInChunks(['a', 'b', 'c', 'd'], restore);
    // Second request is ['b', 'c', 'd']: its ids[1] is 'c'.
    expect(outcome.failed.get('c')?.item?.code).toBe('NOT_FOUND');
    expect(outcome.restored).toEqual(['b', 'd']);
  });

  it('fails the whole chunk when the error names no record, and goes on', async () => {
    const network = new ApiError({ status: 0, code: 'NETWORK_ERROR' });
    const restore = vi
      .fn<(chunk: readonly string[]) => Promise<void>>()
      .mockRejectedValueOnce(network)
      .mockResolvedValueOnce(undefined);
    const outcome = await restoreInChunks(['a', 'b', 'c'], restore, 2);
    expect(outcome.failed.get('a')).toEqual({ item: undefined, error: network });
    expect(outcome.failed.has('b')).toBe(true);
    expect(outcome.restored).toEqual(['c']);
  });

  it('sends each id once', async () => {
    const restore = vi.fn<(chunk: readonly string[]) => Promise<void>>(() => Promise.resolve());
    await restoreInChunks(['a', 'a', 'b'], restore);
    expect(restore).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('daysLeft', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  it.each([
    ['2026-09-24T12:00:00.000Z', 30],
    ['2026-09-24T11:00:00.000Z', 30],
    ['2026-08-27T12:00:00.000Z', 2],
    ['2026-08-25T13:00:00.000Z', 1],
    ['2026-08-25T12:00:00.000Z', 0],
    ['2026-07-01T00:00:00.000Z', 0],
  ])('deleted at %s → %i days left', (deletedAt, expected) => {
    expect(daysLeft(deletedAt, now)).toBe(expected);
  });
});
