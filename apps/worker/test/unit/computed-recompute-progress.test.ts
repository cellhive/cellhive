import { AppError, type QueuedRecomputeBatch } from '@cellhive/server-core';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  createComputedRecomputeTask,
  type ComputedRecomputeProgress,
} from '../../src/tasks/computed-recompute.js';
import { createSchemaRecomputeAutoNumberTask } from '../../src/tasks/schema-recompute-auto-number.js';

import type { JobHelpers } from 'graphile-worker';

/**
 * T459: the `computed.recompute` job reports its progress for the realtime
 * `computed.recomputing` (running after each batch, succeeded / failed at
 * the end); the auto number job asks for a link title refresh once numbers
 * changed.
 */
const ORG = 'org_UnitProgressOrg1';
const TBL = 'tbl_UnitProgressTbl1';
const FLD = 'fld_UnitProgressFld1';
const helpers = { job: { id: '7' } } as unknown as JobHelpers;
const logger = pino({ level: 'silent' });
const EMPTY = { recomputed: [], deferred: [], stateChanged: [] };

function records(batches: (QueuedRecomputeBatch | Error)[]) {
  return {
    recomputeComputedBatch: () => {
      const next = batches.shift();
      if (next === undefined) throw new Error('no more batches');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const more = (rows: number, remaining: number): QueuedRecomputeBatch => ({
  status: 'more',
  rows,
  remaining,
  tableId: TBL,
  result: EMPTY,
});

describe('computed.recompute progress (T459)', () => {
  it('running from 0 after each batch, then succeeded', async () => {
    const seen: ComputedRecomputeProgress[] = [];
    const task = createComputedRecomputeTask({
      schema: {
        analyzeComputedTable: () => Promise.resolve(),
        markComputedTimeout: () => Promise.resolve(false),
      },
      records: records([
        more(5000, 5000),
        more(5000, 0),
        { status: 'done', tableId: TBL, result: EMPTY },
      ]),
      logger,
      onProgress: (progress) => {
        seen.push(progress);
      },
    });
    await task({ organization_id: ORG, field_id: FLD }, helpers);
    expect(seen.map((item) => [item.status, item.progress])).toEqual([
      ['running', 0],
      ['running', 0.5],
      ['running', 1],
      ['succeeded', 1],
    ]);
    expect(seen[0]).toMatchObject({ organizationId: ORG, tableId: TBL, fieldId: FLD });
  });

  it('failed with the last progress when a batch fails for good; a field gone reports nothing', async () => {
    const seen: ComputedRecomputeProgress[] = [];
    const task = createComputedRecomputeTask({
      schema: {
        analyzeComputedTable: () => Promise.resolve(),
        markComputedTimeout: () => Promise.resolve(false),
      },
      records: records([more(100, 300), new AppError('INTERNAL')]),
      logger,
      onProgress: (progress) => {
        seen.push(progress);
      },
    });
    await expect(task({ organization_id: ORG, field_id: FLD }, helpers)).rejects.toThrow();
    expect(seen.map((item) => [item.status, item.progress])).toEqual([
      ['running', 0],
      ['running', 0.25],
      ['failed', 0.25],
    ]);

    seen.length = 0;
    const gone = createComputedRecomputeTask({
      schema: {
        analyzeComputedTable: () => Promise.resolve(),
        markComputedTimeout: () => Promise.resolve(false),
      },
      records: records([{ status: 'gone', result: EMPTY }]),
      logger,
      onProgress: (progress) => {
        seen.push(progress);
      },
    });
    await gone({ organization_id: ORG, field_id: FLD }, helpers);
    expect(seen).toEqual([]);
  });

  it('auto numbers: link titles are refreshed only when numbers changed', async () => {
    const calls: string[][] = [];
    const run = async (updated: number) => {
      const task = createSchemaRecomputeAutoNumberTask({
        records: {
          recomputeAutoNumber: () => Promise.resolve({ rows: 3, updated, fieldFound: true }),
        },
        logger,
        onRenumbered: (org, table, field) => {
          calls.push([org, table, field]);
          return Promise.resolve();
        },
      });
      await task({ organization_id: ORG, table_id: TBL, field_id: FLD }, helpers);
    };
    await run(0);
    expect(calls).toEqual([]);
    await run(2);
    expect(calls).toEqual([[ORG, TBL, FLD]]);
  });
});
