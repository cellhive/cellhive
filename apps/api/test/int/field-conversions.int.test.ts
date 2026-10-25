import {
  convertFieldPreviewSchema,
  convertFieldResponseSchema,
  fieldSchema,
  jobSchema,
  recordListResponseSchema,
  revertConversionPreviewSchema,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import { SchemaService, type Db, type FieldRow } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

interface ProblemItem {
  readonly path?: string;
  readonly code?: string;
  readonly params?: Record<string, unknown>;
}

/** `errors[]` of a problem response. */
function errorsOf(body: string): ProblemItem[] {
  return (problemOf(body).errors ?? []) as ProblemItem[];
}

/** Polls until `check` returns a value (jobs run in the worker). */
async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('eventually: timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T403: field type conversion over HTTP — preview, `PUT` with confirmations,
 * the `field.convert` job, revert and its preview, style email/phone, and
 * the permission rules (schema rights: `403`; field or table not visible:
 * `404`).
 */
describe('field type conversion API (T403)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let fx: RecordFixture;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  async function addTextField(name: string, values: (string | null)[]): Promise<FieldDto> {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
      name,
      type: 'text',
    });
    expect(created.statusCode).toBe(201);
    const field = fieldSchema.parse(created.json());
    const written = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records?field_key_type=id`,
      { records: values.map((value) => ({ fields: { [field.id]: value } })) },
    );
    expect(written.statusCode).toBe(201);
    return field;
  }

  async function valuesOf(fieldId: Id<'fld'>): Promise<unknown[]> {
    const read = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.customers.id}/records?field_key_type=id&fields=${fieldId}&limit=1000`,
    );
    expect(read.statusCode).toBe(200);
    return recordListResponseSchema
      .parse(read.json())
      .records.map((record) => record.fields[fieldId] ?? null);
  }

  async function jobDone(jobId: Id<'job'>) {
    return eventually(async () => {
      const job = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
      return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
    });
  }

  it('refuses callers without schema rights (403) and fields they cannot see (404)', async () => {
    const field = fx.fld.customerCode as FieldRow;
    const cost = fx.fld.cost as FieldRow;
    const body = { type: 'number' };
    // u_editor reads Customers but has no schema rights.
    expectProblem(
      await fx.call('u_editor', 'POST', `/fields/${field.id}/convert-preview`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_editor', 'PUT', `/fields/${field.id}`, body),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_editor', 'POST', `/fields/${field.id}/revert-conversion`, {}),
      403,
      'PERMISSION_DENIED',
    );
    // Sales cannot see Customers at all, nor `cost` of Orders (no_perm): 404, never 403.
    expectProblem(
      await fx.call('u_sales1', 'POST', `/fields/${field.id}/convert-preview`, body),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_sales1', 'POST', `/fields/${cost.id}/convert-preview`, body),
      404,
      'NOT_FOUND',
    );
    expectProblem(await fx.call('u_sales1', 'PUT', `/fields/${cost.id}`, body), 404, 'NOT_FOUND');
    expectProblem(
      await fx.call('stranger', 'POST', `/fields/${field.id}/revert-conversion/preview`),
      404,
      'NOT_FOUND',
    );
  });

  /** Runs `write` between the counts of `PUT /fields/:id` and the start of the conversion. */
  async function withWriteBeforeStart<T>(write: () => Promise<void>, run: () => Promise<T>) {
    const schema = t.app.get(SchemaService);
    const original = schema.startConversion.bind(schema);
    schema.startConversion = async (...args) => {
      await write();
      return original(...args);
    };
    try {
      return await run();
    } finally {
      schema.startConversion = original;
    }
  }

  async function addValue(fieldId: Id<'fld'>, value: string): Promise<void> {
    const written = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records?field_key_type=id`,
      { records: [{ fields: { [fieldId]: value } }] },
    );
    expect(written.statusCode, written.body).toBe(201);
  }

  it('counts again under the schema lock when records were written after the counts', async () => {
    // A value that cannot become a number, written after the counts: confirm is required.
    const amount = await addTextField('Số đếm lại', ['1', '2']);
    const unconfirmed = await withWriteBeforeStart(
      () => addValue(amount.id, 'abc'),
      () => fx.call('u_admin', 'PUT', `/fields/${amount.id}`, { type: 'number' }),
    );
    expectProblem(unconfirmed, 422, 'CONVERSION_REQUIRES_CONFIRM');
    expect(errorsOf(unconfirmed.body)[0]).toMatchObject({ params: { lost: 1 } });

    // A new value written after the counts gets its select option too.
    const status = await addTextField('Trạng thái đếm lại', ['Mới', 'Xong']);
    const accepted = await withWriteBeforeStart(
      () => addValue(status.id, 'Huỷ'),
      () => fx.call('u_admin', 'PUT', `/fields/${status.id}`, { type: 'select' }),
    );
    expect(accepted.statusCode, accepted.body).toBe(202);
    const started = convertFieldResponseSchema.parse(accepted.json());
    if (started.job_id === null) throw new Error('expected a job');
    expect((await jobDone(started.job_id)).status).toBe('succeeded');
    const converted = fieldSchema.parse(
      (await fx.call('u_admin', 'GET', `/fields/${status.id}`)).json(),
    );
    const names = (converted.options as { options: { id: string; name: string }[] }).options;
    expect(names.map((option) => option.name).sort()).toEqual(['Huỷ', 'Mới', 'Xong']);
    expect((await valuesOf(status.id)).filter((value) => value !== null)).toHaveLength(3);
  });

  it('previews, requires confirm for lost values, converts through the job and reverts', async () => {
    const field = await addTextField('Số tiền chữ', ['1.500.000', 'abc', '12', null]);
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${field.id}/convert-preview`, { type: 'number' })
      ).json(),
    );
    expect(preview).toMatchObject({
      allowed: true,
      reason: null,
      kind: 'keep',
      requires_confirm: true,
      requires_accept_data_loss: false,
      unique_values_reset: false,
      affected: 3,
      lost: 1,
      truncated: 0,
      new_options: [],
      dependents: [],
    });
    expect(preview.samples[0]).toMatchObject({ from: 'abc', to: null, outcome: 'lost' });

    const unconfirmed = await fx.call('u_admin', 'PUT', `/fields/${field.id}`, { type: 'number' });
    expectProblem(unconfirmed, 422, 'CONVERSION_REQUIRES_CONFIRM');
    expect(errorsOf(unconfirmed.body)[0]).toMatchObject({
      path: 'confirm',
      code: 'CONVERSION_REQUIRES_CONFIRM',
      params: { lost: 1, truncated: 0 },
    });

    const accepted = await fx.call('u_admin', 'PUT', `/fields/${field.id}`, {
      type: 'number',
      confirm: true,
    });
    expect(accepted.statusCode).toBe(202);
    const started = convertFieldResponseSchema.parse(accepted.json());
    if (started.job_id === null) throw new Error('expected a job');
    // Until the job ends the field keeps its definition (design decision #8).
    expect(started.field.type).toBe('text');
    expect(started.field.conversion?.job_id).toBe(started.job_id);
    const job = await jobDone(started.job_id);
    expect(job).toMatchObject({ status: 'succeeded', progress: 1 });
    expect(job.result).toMatchObject({ affected: 3, lost: 1 });

    const converted = fieldSchema.parse(
      (await fx.call('u_admin', 'GET', `/fields/${field.id}`)).json(),
    );
    expect(converted).toMatchObject({
      type: 'number',
      conversion: {
        job_id: started.job_id,
        status: 'succeeded',
        from_type: 'text',
        to_type: 'number',
      },
    });
    expect(await valuesOf(field.id)).toEqual(expect.arrayContaining([1500000, 12]));

    // Nothing written since: the revert needs no confirmation.
    const revertPreview = revertConversionPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${field.id}/revert-conversion/preview`)).json(),
    );
    expect(revertPreview).toMatchObject({
      job_id: started.job_id,
      from_type: 'text',
      edited: 0,
      edited_unconvertible: 0,
      new_field_available: true,
    });
    const reverted = await fx.call('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, {});
    expect(reverted.statusCode).toBe(200);
    expect(fieldSchema.parse(reverted.json())).toMatchObject({ type: 'text', conversion: null });
    expect(await valuesOf(field.id)).toEqual(expect.arrayContaining(['1.500.000', 'abc', '12']));
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${field.id}/revert-conversion/preview`),
      404,
      'NOT_FOUND',
    );
  });

  it('reverts keeping later edits by default; overwriting or a new field on request (design decision #7)', async () => {
    const convertWithEdit = async (name: string) => {
      const field = await addTextField(name, ['1', '2']);
      const started = convertFieldResponseSchema.parse(
        (await fx.call('u_admin', 'PUT', `/fields/${field.id}`, { type: 'number' })).json(),
      );
      await jobDone(started.job_id as Id<'job'>);
      const created = await fx.call(
        'u_admin',
        'POST',
        `/tables/${fx.customers.id}/records?field_key_type=id`,
        { records: [{ fields: { [field.id]: 99 } }] },
      );
      expect(created.statusCode).toBe(201);
      return field;
    };

    const keep = await convertWithEdit('Giữ sửa');
    const preview = revertConversionPreviewSchema.parse(
      (await fx.call('u_admin', 'POST', `/fields/${keep.id}/revert-conversion/preview`)).json(),
    );
    expect(preview).toMatchObject({ edited: 1, edited_unconvertible: 0 });
    expect(preview.samples).toEqual([
      expect.objectContaining({ from: 99, to: '99', outcome: 'kept' }),
    ]);
    const kept = await fx.call('u_admin', 'POST', `/fields/${keep.id}/revert-conversion`, {});
    expect(kept.statusCode).toBe(200);
    expect(fieldSchema.parse(kept.json()).type).toBe('text');
    expect(await valuesOf(keep.id)).toEqual(expect.arrayContaining(['1', '2', '99']));

    const overwrite = await convertWithEdit('Ghi đè');
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${overwrite.id}/revert-conversion`, {
        mode: 'overwrite_later_edits',
      }),
      422,
      'CONVERSION_REQUIRES_CONFIRM',
    );
    const overwritten = await fx.call(
      'u_admin',
      'POST',
      `/fields/${overwrite.id}/revert-conversion`,
      {
        mode: 'overwrite_later_edits',
        confirm: true,
      },
    );
    expect(overwritten.statusCode).toBe(200);
    expect(await valuesOf(overwrite.id)).not.toContain('99');

    const copy = await convertWithEdit('Bản sao');
    const restored = await fx.call('u_admin', 'POST', `/fields/${copy.id}/revert-conversion`, {
      mode: 'new_field',
    });
    expect(restored.statusCode).toBe(200);
    const newField = fieldSchema.parse(restored.json());
    expect(newField).toMatchObject({ type: 'text', name: 'Bản sao (old version)' });
    expect(
      fieldSchema.parse((await fx.call('u_admin', 'GET', `/fields/${copy.id}`)).json()).type,
    ).toBe('number');
    expect(await valuesOf(newField.id)).toEqual(expect.arrayContaining(['1', '2']));
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${copy.id}/revert-conversion/preview`),
      404,
      'NOT_FOUND',
    );
  });

  it('changes a text style to email without confirm; the preview counts invalid cells', async () => {
    const field = await addTextField('Email', ['an@x.vn', 'sai', 'b@x.vn', 'cũng sai']);
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${field.id}/convert-preview`, {
          type: 'text',
          options: { style: { type: 'email' } },
        })
      ).json(),
    );
    expect(preview).toMatchObject({
      kind: 'none',
      invalid: 2,
      requires_confirm: false,
      affected: 0,
    });
    expect(preview.samples.map((sample) => sample.outcome)).toEqual(['invalid', 'invalid']);
    const patched = await fx.call('u_admin', 'PATCH', `/fields/${field.id}`, {
      options: { style: { type: 'email' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(await valuesOf(field.id)).toEqual(
      expect.arrayContaining(['an@x.vn', 'sai', 'b@x.vn', 'cũng sai']),
    );
    // The same change through PUT is applied at once, without a job.
    const put = await fx.call('u_admin', 'PUT', `/fields/${field.id}`, {
      type: 'text',
      options: { style: { type: 'phone' } },
    });
    expect(put.statusCode).toBe(202);
    expect(convertFieldResponseSchema.parse(put.json())).toMatchObject({
      job_id: null,
      field: { options: { style: { type: 'phone' } } },
    });
  });

  it('refuses a blacklisted conversion of values without accept_data_loss', async () => {
    const field = await addTextField('Cờ', ['x', null]);
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${field.id}/convert-preview`, {
          type: 'checkbox',
        })
      ).json(),
    );
    expect(preview).toMatchObject({
      kind: 'blacklist',
      requires_accept_data_loss: true,
      affected: 1,
      lost: 1,
    });
    const refused = await fx.call('u_admin', 'PUT', `/fields/${field.id}`, { type: 'checkbox' });
    expectProblem(refused, 422, 'CONVERSION_NOT_ALLOWED');
    expect(errorsOf(refused.body)[0]).toMatchObject({ path: 'accept_data_loss' });
    // With truthy_values it is a whitelisted conversion instead.
    const truthy = convertFieldPreviewSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/fields/${field.id}/convert-preview`, {
          type: 'checkbox',
          conversion: { truthy_values: ['x'] },
        })
      ).json(),
    );
    expect(truthy).toMatchObject({ kind: 'keep', affected: 1, lost: 0, requires_confirm: false });
    const accepted = await fx.call('u_admin', 'PUT', `/fields/${field.id}`, {
      type: 'checkbox',
      accept_data_loss: true,
    });
    expect(accepted.statusCode).toBe(202);
    await jobDone(convertFieldResponseSchema.parse(accepted.json()).job_id as Id<'job'>);
    expect(await valuesOf(field.id)).not.toContain(true);
  });

  it('lists roles using the field as dependents (base admins)', async () => {
    const preview = convertFieldPreviewSchema.parse(
      (
        await fx.call(
          'u_admin',
          'POST',
          `/fields/${(fx.fld.owner as FieldRow).id}/convert-preview`,
          {
            type: 'text',
          },
        )
      ).json(),
    );
    expect(preview.dependents).toContainEqual(expect.objectContaining({ type: 'role' }));
    expect(preview.kind).toBe('keep');
  });

  it('refuses read-only targets and unknown options', async () => {
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${(fx.fld.customerCode as FieldRow).id}`, {
        type: 'auto_number',
      }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    const bad = await fx.call(
      'u_admin',
      'POST',
      `/fields/${(fx.fld.customerCode as FieldRow).id}/convert-preview`,
      {
        type: 'number',
        options: { style: { type: 'nope' } },
      },
    );
    expectProblem(bad, 422, 'VALIDATION_FAILED');
    expect(errorsOf(bad.body)[0]?.path).toMatch(/^options/);
  });
});
