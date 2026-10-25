import { AppError, type OrgScope, type QueuedRecomputeBatch } from '@cellhive/server-core';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import {
  COMPUTED_RECOMPUTE_BATCH_ATTEMPTS,
  createComputedRecomputeTask,
} from '../../src/tasks/computed-recompute.js';

import type { JobHelpers } from 'graphile-worker';

const ORG = 'org_UnitRecompOrg001';
const TBL = 'tbl_UnitRecompTbl001';
const FLD = 'fld_UnitRecompFld001';
const helpers = { job: { id: '7' } } as unknown as JobHelpers;
const EMPTY = { recomputed: [], deferred: [], stateChanged: [] };

/** A PostgreSQL statement timeout as `pg` raises it (SQLSTATE 57014). */
function statementTimeout(): Error {
  return Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  });
}

/** A lock wait past `lock_timeout`, as `RecordMutationService` translates it. */
function lockTimeout(): AppError {
  return new AppError('SCHEMA_LOCKED', {
    detail: 'locked',
    cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  });
}

const more: QueuedRecomputeBatch = {
  status: 'more',
  rows: 10,
  remaining: 0,
  tableId: TBL,
  result: EMPTY,
};
const done: QueuedRecomputeBatch = { status: 'done', tableId: TBL, result: EMPTY };

function harness(steps: (QueuedRecomputeBatch | Error)[]) {
  const marked: string[] = [];
  const sizes: (number | undefined)[] = [];
  const sleeps: number[] = [];
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const task = createComputedRecomputeTask({
    schema: {
      analyzeComputedTable: () => Promise.resolve(),
      markComputedTimeout: (_scope: OrgScope, fieldId) => {
        marked.push(fieldId);
        return Promise.resolve(true);
      },
    },
    records: {
      recomputeComputedBatch: (_scope, _field, options) => {
        sizes.push(options.batchSize);
        const next = steps.shift();
        if (next === undefined) return Promise.reject(new Error('no more batches'));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
    logger,
    batchSize: 100,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  return {
    marked,
    sizes,
    sleeps,
    lines,
    run: () => task({ organization_id: ORG, field_id: FLD }, helpers),
  };
}

/**
 * T460 + T474: a batch of `computed.recompute` past its statement timeout is
 * tried once more with half the records; only a second timeout in a row
 * marks the field `TIMEOUT` (through `SchemaService.markComputedTimeout`)
 * and ends the job. Lock waits and deadlocks are retried with a backoff and
 * never mark the field; still blocked, the job fails (graphile retries it,
 * records still queued). Other errors fail the job.
 */
describe('computed.recompute: statement timeout vs lock wait (T460, T474)', () => {
  it('two timeouts in a row (the second with half the rows) mark the field TIMEOUT and end the job', async () => {
    const h = harness([statementTimeout(), statementTimeout(), more]);
    await h.run();
    expect(h.marked).toEqual([FLD]);
    expect(h.sizes).toEqual([100, 50]);
    expect(h.lines.map((line) => line['msg'])).toContain(
      'computed.recompute: batch past its statement timeout twice, field marked TIMEOUT',
    );
  });

  it('one timeout then success: not TIMEOUT, the run goes on with the halved batch', async () => {
    const h = harness([statementTimeout(), more, done]);
    await h.run();
    expect(h.marked).toEqual([]);
    expect(h.sizes).toEqual([100, 50, 50]);
  });

  it('lock waits are retried with a backoff, the field untouched', async () => {
    const h = harness([lockTimeout(), lockTimeout(), more, done]);
    await h.run();
    expect(h.marked).toEqual([]);
    expect(h.sizes).toEqual([100, 100, 100, 100]);
    expect(h.sleeps).toEqual([250, 500]);
    const retries = h.lines.filter(
      (line) => line['msg'] === 'computed.recompute: batch waited for locks, retrying',
    );
    expect(retries).toHaveLength(2);
    // Codes, never the message of the database error.
    expect(retries[0]).toMatchObject({ error_code: 'SCHEMA_LOCKED', sqlstate: '55P03' });
    expect(JSON.stringify(h.lines)).not.toContain('canceling statement');
  });

  it('still blocked after every attempt: the job fails for graphile to retry, no TIMEOUT', async () => {
    const h = harness(Array.from({ length: COMPUTED_RECOMPUTE_BATCH_ATTEMPTS }, lockTimeout));
    await expect(h.run()).rejects.toMatchObject({ code: 'SCHEMA_LOCKED' });
    expect(h.marked).toEqual([]);
    expect(h.sizes).toHaveLength(COMPUTED_RECOMPUTE_BATCH_ATTEMPTS);
  });

  it('another error still fails the job (retried by graphile-worker)', async () => {
    const h = harness([new Error('boom')]);
    await expect(h.run()).rejects.toThrow('boom');
    expect(h.marked).toEqual([]);
    expect(h.sizes).toEqual([100]);
    expect(JSON.stringify(h.lines)).not.toContain('boom');
  });
});
