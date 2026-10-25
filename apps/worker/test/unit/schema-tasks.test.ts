import { Writable } from 'node:stream';

import {
  AppError,
  type AuditContext,
  type CompactionResult,
  type OrgScope,
} from '@cellhive/server-core';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { createSchemaCompactTableTask } from '../../src/tasks/schema-compact-table.js';
import { createSchemaRecomputeAutoNumberTask } from '../../src/tasks/schema-recompute-auto-number.js';
import { createSchemaRemoveSelectOptionsTask } from '../../src/tasks/schema-remove-select-options.js';

import type { JobHelpers } from 'graphile-worker';

const ORG = 'org_UnitSchemaOrg001';
const TBL = 'tbl_UnitSchemaTbl001';
const FLD = 'fld_UnitSchemaFld001';

function capture() {
  const chunks: string[] = [];
  const logger = pino(
    { level: 'debug', messageKey: 'msg' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    }),
  );
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines };
}

const helpers = { job: { id: '42' } } as unknown as JobHelpers;

const result: CompactionResult = {
  tableId: TBL,
  dbTableName: 't_aaaaaaaaaaaa',
  slotsBefore: 1400,
  slotsAfter: 20,
  rows: 7,
  purgedFieldIds: [FLD],
  keptDeletedFieldIds: [],
  stillOverBudget: false,
  junctionForeignKeys: [],
};

describe('schema.compact_table', () => {
  it('warns when kept trashed columns leave the table over budget', async () => {
    const { logger, lines } = capture();
    const task = createSchemaCompactTableTask({
      schema: {
        compactTable: () =>
          Promise.resolve({ ...result, keptDeletedFieldIds: [FLD], stillOverBudget: true }),
      },
      logger,
    });
    await task({ organization_id: ORG, table_id: TBL }, helpers);
    expect(lines()).toContainEqual(
      expect.objectContaining({ level: 40, table_id: TBL, kept_deleted_fields: 1 }),
    );
  });

  it('compacts the table of the payload in its organization and logs counters only', async () => {
    const calls: { org: string; table: string }[] = [];
    const { logger, lines } = capture();
    const task = createSchemaCompactTableTask({
      schema: {
        compactTable: (scope: OrgScope, tableId) => {
          calls.push({ org: scope.organizationId, table: tableId });
          return Promise.resolve(result);
        },
      },
      logger,
    });
    await task({ organization_id: ORG, table_id: TBL }, helpers);
    expect(calls).toEqual([{ org: ORG, table: TBL }]);
    expect(lines()).toContainEqual(
      expect.objectContaining({
        msg: 'table compacted',
        table_id: TBL,
        slots_before: 1400,
        slots_after: 20,
        purged_fields: 1,
      }),
    );
  });

  it('completes without work for a malformed payload or a missing table', async () => {
    const { logger, lines } = capture();
    const task = createSchemaCompactTableTask({
      schema: { compactTable: () => Promise.reject(new AppError('NOT_FOUND')) },
      logger,
    });
    await task({ organization_id: 'nope', table_id: TBL } as never, helpers);
    await task({ organization_id: ORG, table_id: TBL }, helpers);
    expect(lines().map((line) => line.msg)).toEqual([
      'schema.compact_table: malformed payload, skipped',
      'schema.compact_table: table not found, nothing to compact',
    ]);
  });

  it('rethrows other failures so graphile-worker retries', async () => {
    const { logger } = capture();
    const task = createSchemaCompactTableTask({
      schema: { compactTable: () => Promise.reject(new Error('lock timeout')) },
      logger,
    });
    await expect(task({ organization_id: ORG, table_id: TBL }, helpers)).rejects.toThrow(
      'lock timeout',
    );
  });
});

describe('schema.recompute_auto_number', () => {
  it('renumbers through RecordMutationService in the payload organization, logging counters only', async () => {
    const calls: { org: string; table: string; field: string }[] = [];
    const { logger, lines } = capture();
    const task = createSchemaRecomputeAutoNumberTask({
      records: {
        recomputeAutoNumber: (scope: OrgScope, tableId, fieldId) => {
          calls.push({ org: scope.organizationId, table: tableId, field: fieldId });
          return Promise.resolve({ rows: 12, updated: 10, fieldFound: true });
        },
      },
      logger,
    });
    await task({ organization_id: ORG, table_id: TBL, field_id: FLD }, helpers);
    expect(calls).toEqual([{ org: ORG, table: TBL, field: FLD }]);
    expect(lines()).toContainEqual(
      expect.objectContaining({ msg: 'auto numbers recomputed', rows: 12, updated: 10 }),
    );
  });

  it('completes for a malformed payload, a missing table or a missing field', async () => {
    const { logger, lines } = capture();
    const missingTable = createSchemaRecomputeAutoNumberTask({
      records: { recomputeAutoNumber: () => Promise.reject(new AppError('NOT_FOUND')) },
      logger,
    });
    await missingTable({ organization_id: 'nope', table_id: TBL, field_id: FLD } as never, helpers);
    await missingTable({ organization_id: ORG, table_id: TBL, field_id: FLD }, helpers);
    const missingField = createSchemaRecomputeAutoNumberTask({
      records: {
        recomputeAutoNumber: () => Promise.resolve({ rows: 0, updated: 0, fieldFound: false }),
      },
      logger,
    });
    await missingField({ organization_id: ORG, table_id: TBL, field_id: FLD }, helpers);
    expect(lines().map((line) => line.msg)).toEqual([
      'schema.recompute_auto_number: malformed payload, skipped',
      'schema.recompute_auto_number: table not found, nothing to do',
      'schema.recompute_auto_number: field not found, nothing to do',
    ]);
  });

  it('rethrows other failures so graphile-worker retries', async () => {
    const { logger } = capture();
    const task = createSchemaRecomputeAutoNumberTask({
      records: { recomputeAutoNumber: () => Promise.reject(new Error('lock timeout')) },
      logger,
    });
    await expect(
      task({ organization_id: ORG, table_id: TBL, field_id: FLD }, helpers),
    ).rejects.toThrow('lock timeout');
  });
});

describe('schema.remove_select_options', () => {
  const OPT = 'opt_UnitSchemaOpt001';
  const JOB = 'job_UnitSchemaJob001';
  const payload = {
    organization_id: ORG,
    table_id: TBL,
    field_id: FLD,
    option_ids: [OPT],
    batch_id: JOB,
  } as const;

  /** A `meta.jobs` double recording the transitions of the job row. */
  function jobsSpy() {
    const transitions: { status: string; id: string; detail?: unknown }[] = [];
    return {
      transitions,
      jobs: {
        markRunning: (_scope: OrgScope, id: string) => {
          transitions.push({ status: 'running', id });
          return Promise.resolve(undefined);
        },
        markSucceeded: (_scope: OrgScope, id: string, result: unknown) => {
          transitions.push({ status: 'succeeded', id, detail: result });
          return Promise.resolve(undefined);
        },
        markFailed: (_scope: OrgScope, id: string, error: unknown) => {
          transitions.push({ status: 'failed', id, detail: error });
          return Promise.resolve(undefined);
        },
      },
    };
  }

  it('removes values through RecordMutationService as the system, with the job batch id', async () => {
    const calls: { org: string; tableId: string; fieldId: string; optionIds: unknown }[] = [];
    const contexts: AuditContext[] = [];
    const { logger, lines } = capture();
    const spy = jobsSpy();
    const task = createSchemaRemoveSelectOptionsTask({
      records: {
        removeSelectOptionValues: (scope: OrgScope, tableId, fieldId, optionIds, context) => {
          calls.push({ org: scope.organizationId, tableId, fieldId, optionIds });
          contexts.push(context);
          return Promise.resolve({ updated: 7, fieldFound: true });
        },
      },
      jobs: spy.jobs,
      logger,
    });
    await task(payload, helpers);
    // The meta.jobs row (id = batch_id) goes running → succeeded with the count.
    expect(spy.transitions).toEqual([
      { status: 'running', id: JOB },
      { status: 'succeeded', id: JOB, detail: { updated: 7 } },
    ]);
    expect(calls).toEqual([{ org: ORG, tableId: TBL, fieldId: FLD, optionIds: [OPT] }]);
    expect(contexts).toEqual([
      {
        actor: { type: 'system', id: null },
        via: null,
        batch_id: JOB,
        request_id: null,
        ip: null,
        user_agent: null,
      },
    ]);
    expect(lines()).toContainEqual(
      expect.objectContaining({ msg: 'select options removed from records', updated: 7 }),
    );
  });

  it('completes for a malformed payload, a missing table or a missing field', async () => {
    const { logger, lines } = capture();
    const missingTable = createSchemaRemoveSelectOptionsTask({
      records: { removeSelectOptionValues: () => Promise.reject(new AppError('NOT_FOUND')) },
      jobs: jobsSpy().jobs,
      logger,
    });
    await missingTable({ ...payload, option_ids: [] }, helpers);
    await missingTable(payload, helpers);
    const missingField = createSchemaRemoveSelectOptionsTask({
      records: {
        removeSelectOptionValues: () => Promise.resolve({ updated: 0, fieldFound: false }),
      },
      jobs: jobsSpy().jobs,
      logger,
    });
    await missingField(payload, helpers);
    expect(lines().map((line) => line.msg)).toEqual([
      'schema.remove_select_options: malformed payload, skipped',
      'schema.remove_select_options: table not found, nothing to do',
      'schema.remove_select_options: field not found, nothing to do',
    ]);
  });

  it('rethrows other failures so graphile-worker retries; the last attempt fails the job', async () => {
    const { logger } = capture();
    const spy = jobsSpy();
    const task = createSchemaRemoveSelectOptionsTask({
      records: { removeSelectOptionValues: () => Promise.reject(new Error('lock timeout')) },
      jobs: spy.jobs,
      logger,
    });
    const attempt = (attempts: number) =>
      ({ job: { id: '42', attempts, max_attempts: 5 } }) as unknown as JobHelpers;
    await expect(task(payload, attempt(1))).rejects.toThrow('lock timeout');
    expect(spy.transitions.map((transition) => transition.status)).toEqual(['running']);
    await expect(task(payload, attempt(5))).rejects.toThrow('lock timeout');
    expect(spy.transitions.map((transition) => transition.status)).toEqual([
      'running',
      'running',
      'failed',
    ]);
    expect(spy.transitions[2]?.detail).toMatchObject({ code: 'INTERNAL' });
  });
});
