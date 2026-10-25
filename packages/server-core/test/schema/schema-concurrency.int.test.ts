import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { isAppError } from '../../src/errors/index.js';
import { SchemaService, schemaLockKey, type CreatedTable } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, userContext } from '../support/schema.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG = 'org_SchemaConcOrg001';

/** Every outcome is a success or a clear 409 SCHEMA_LOCKED — never a deadlock or raw error. */
function expectSuccessOrLocked(results: PromiseSettledResult<unknown>[]): number {
  let succeeded = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      succeeded += 1;
      continue;
    }
    const error: unknown = result.reason;
    expect(isAppError(error) ? error.code : error).toBe('SCHEMA_LOCKED');
  }
  return succeeded;
}

describe('SchemaService under concurrency', () => {
  let database: TestDatabase;
  let db: Db;
  let tenant: SeededTenant;
  let scope: OrgScope;
  let schema: SchemaService;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url, { poolMax: 14 });
    await migrateAll(database.url, db);
    tenant = await seedTenant(db, ORG, { collation: 'vi-VN-x-icu' });
    scope = orgScope(ORG);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const ctx = () => userContext(tenant.userId);

  async function newTable(name: string, service = schema): Promise<CreatedTable> {
    return service.createTable(
      scope,
      { baseId: tenant.baseId, name, primaryFieldName: 'Name' },
      ctx(),
    );
  }

  async function activeFieldCount(table: CreatedTable): Promise<number> {
    const row = await db.kysely
      .selectFrom('meta.fields')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .where('table_id', '=', table.table.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** A second connection that holds a lock until `release()`. */
  async function holdLock(statement: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    await client.query('BEGIN');
    await client.query(statement, params);
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await client.query('ROLLBACK');
        await client.end();
      },
    };
  }

  it('10 concurrent addField on one table: all succeed or SCHEMA_LOCKED, meta matches the catalog', async () => {
    const table = await newTable('Ten at once');
    for (let round = 0; round < 3; round += 1) {
      const types = ['text', 'number', 'select', 'datetime', 'checkbox', 'user', 'auto_number'];
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          schema.addField(
            scope,
            table.table.id,
            {
              name: `R${String(round)} F${String(index)}`,
              type: types[index % types.length] ?? 'text',
            },
            ctx(),
          ),
        ),
      );
      const succeeded = expectSuccessOrLocked(results);
      expect(succeeded).toBeGreaterThan(0);
      await expectConsistent(schema, scope, table.table.id);
    }
    expect(await activeFieldCount(table)).toBeGreaterThan(1);
  });

  it('mixed concurrent DDL (add, rename, options, delete, restore) keeps meta and catalog in step', async () => {
    const table = await newTable('Mixed');
    const seed = [];
    for (let index = 0; index < 6; index += 1) {
      seed.push(
        await schema.addField(
          scope,
          table.table.id,
          { name: `S${String(index)}`, type: 'select' },
          ctx(),
        ),
      );
    }
    const [a, b, c, d, e, f] = seed;
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined ||
      e === undefined ||
      f === undefined
    ) {
      throw new Error('seed');
    }
    await schema.deleteField(scope, f.id, ctx());
    const results = await Promise.allSettled([
      schema.addField(
        scope,
        table.table.id,
        { name: 'N1', type: 'text', uniqueValues: true },
        ctx(),
      ),
      schema.addField(scope, table.table.id, { name: 'N2', type: 'user' }, ctx()),
      schema.renameField(scope, a.id, 'A renamed', ctx()),
      schema.updateFieldOptions(scope, b.id, { options: { multiple: true } }, ctx()),
      schema.deleteField(scope, c.id, ctx()),
      schema.deleteField(scope, d.id, ctx()),
      schema.restoreField(scope, f.id, ctx()),
      schema.updateFieldOptions(scope, e.id, { required: true }, ctx()),
      schema.addField(scope, table.table.id, { name: 'N3', type: 'checkbox' }, ctx()),
      schema.renameTable(scope, table.table.id, 'Mixed renamed', ctx()),
    ]);
    expectSuccessOrLocked(results);
    await expectConsistent(schema, scope, table.table.id);
  });

  it('answers SCHEMA_LOCKED after the bounded retries while another transaction holds the table lock', async () => {
    const impatient = new SchemaService(db, {
      maxFieldsPerTable: 500,
      lockTimeoutMs: 150,
      maxAttempts: 3,
      sleep: () => Promise.resolve(),
    });
    const table = await newTable('Held advisory');
    const holder = await holdLock('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      schemaLockKey(table.table.id),
    ]);
    try {
      const started = Date.now();
      const error = await impatient
        .addField(scope, table.table.id, { name: 'Blocked', type: 'text' }, ctx())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'SCHEMA_LOCKED', status: 409 });
      expect(isAppError(error) ? error.params : undefined).toMatchObject({
        attempts: 3,
        sqlstate: '55P03',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 150);
    } finally {
      await holder.release();
    }
    expect(await activeFieldCount(table)).toBe(1);
    await expectConsistent(schema, scope, table.table.id);
  });

  it('times out ALTER TABLE behind a long reader (lock_timeout), while meta-only changes proceed', async () => {
    const impatient = new SchemaService(db, {
      maxFieldsPerTable: 500,
      lockTimeoutMs: 150,
      maxAttempts: 2,
      sleep: () => Promise.resolve(),
    });
    const table = await newTable('Long reader');
    const reader = await holdLock(`SELECT count(*) FROM data.${table.table.db_table_name}`);
    try {
      await expect(
        impatient.addField(scope, table.table.id, { name: 'Blocked', type: 'number' }, ctx()),
      ).rejects.toMatchObject({ code: 'SCHEMA_LOCKED' });
      // Renaming touches meta only: no lock on the data table is needed.
      const renamed = await impatient.renameField(scope, table.primaryField.id, 'Title', ctx());
      expect(renamed.name).toBe('Title');
    } finally {
      await reader.release();
    }
    await expectConsistent(schema, scope, table.table.id);
  });

  it('succeeds on a later attempt once the blocking transaction ends', async () => {
    const table = await newTable('Retry wins');
    const reader = await holdLock(`SELECT count(*) FROM data.${table.table.db_table_name}`);
    let sleeps = 0;
    const retrying = new SchemaService(db, {
      maxFieldsPerTable: 500,
      lockTimeoutMs: 150,
      maxAttempts: 3,
      // The blocker ends while the service waits before its second attempt.
      sleep: async () => {
        sleeps += 1;
        await reader.release();
      },
    });
    try {
      const field = await retrying.addField(
        scope,
        table.table.id,
        { name: 'Late', type: 'text' },
        ctx(),
      );
      expect(field.name).toBe('Late');
      expect(sleeps).toBe(1);
    } finally {
      await reader.release();
    }
    await expectConsistent(schema, scope, table.table.id);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.events WHERE type = 'field.created' AND entity_id IN (
        SELECT id FROM meta.fields WHERE table_id = ${table.table.id}
      )
    `.execute(db.kysely);
    // The failed attempt left no event behind.
    expect(rows[0]?.n).toBe(1);
  });

  it('two concurrent option PATCHes adding different options keep both (merged under the lock)', async () => {
    const table = await newTable('Options race');
    const field = await schema.addField(
      scope,
      table.table.id,
      {
        name: 'Status',
        type: 'select',
        options: { options: [{ id: 'opt_Existing00000001', name: 'E' }] },
      },
      ctx(),
    );
    // Both requests read the field before either writes (the API's permission check).
    const seen = field.options;
    const holder = await holdLock('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      schemaLockKey(table.table.id),
    ]);
    const patch = (name: string, extra: Record<string, unknown>) =>
      schema.updateField(
        scope,
        field.id,
        {
          optionsPatch: {
            options: [{ id: 'opt_Existing00000001', name: 'E' }, { name }],
            ...extra,
          },
          optionsBase: seen,
        },
        ctx(),
      );
    const both = Promise.all([patch('X', {}), patch('Y', { default_value: null })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await holder.release();
    await both;

    const stored = await db.kysely
      .selectFrom('meta.fields')
      .select('options')
      .where('id', '=', field.id)
      .executeTakeFirstOrThrow();
    const options = (stored.options as { options: { id: string; name: string }[] }).options;
    expect(options.map((option) => option.name).sort()).toEqual(['E', 'X', 'Y']);
    expect(new Set(options.map((option) => option.id)).size).toBe(3);
    // Nothing was considered removed: no option removal job was queued.
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs
       WHERE task_identifier = 'schema.remove_select_options'
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);
  });
});
