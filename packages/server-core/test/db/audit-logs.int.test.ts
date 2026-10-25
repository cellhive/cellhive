import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { jsonb, migrateToLatest, type Db } from '../../src/db/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';

const ORG_A = 'org_AuditOrgA0000001';
const ORG_B = 'org_AuditOrgB0000001';
const OWNER = 'usr_AuditOwner000001';
const ALICE = 'usr_AuditAlice000001';

interface Entry {
  readonly id: Id<'aud'>;
  readonly organization_id: Id<'org'> | null;
  readonly actor_id: string | null;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly user_agent: string | null;
}

const APPEND_ONLY = /meta\.audit_logs is append-only/;

describe('meta.audit_logs (ADR-23 §5)', () => {
  let database: TestDatabase;
  let db: Db;

  async function insert(entry: Partial<Omit<Entry, 'id'>> = {}): Promise<Id<'aud'>> {
    const id = newId('aud');
    await db.kysely
      .insertInto('meta.audit_logs')
      .values({
        id,
        organization_id: entry.organization_id === undefined ? ORG_A : entry.organization_id,
        actor_type: 'user',
        actor_id: entry.actor_id === undefined ? ALICE : entry.actor_id,
        action: entry.action ?? 'record.updated',
        entity_type: entry.entity_type ?? 'record',
        entity_id: entry.entity_id === undefined ? 'rec_AuditRecord00001' : entry.entity_id,
        before: jsonb({ fld_name: 'Nguyễn Văn Ánh' }),
        after: jsonb({ fld_name: 'Ánh' }),
        ip: entry.ip === undefined ? '203.0.113.7' : entry.ip,
        user_agent: entry.user_agent === undefined ? 'Mozilla/5.0' : entry.user_agent,
      })
      .execute();
    return id;
  }

  async function get(id: Id<'aud'>): Promise<Entry> {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select([
        'id',
        'organization_id',
        'actor_id',
        'action',
        'entity_type',
        'entity_id',
        'before',
        'after',
        'ip',
        'user_agent',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('append-only guard', () => {
    let id: Id<'aud'>;

    beforeEach(async () => {
      id = await insert();
    });

    it('accepts INSERT, including organization_id NULL (auth.* without org, CLI)', async () => {
      const anonymous = await insert({ organization_id: null, action: 'auth.login_failed' });
      expect((await get(anonymous)).organization_id).toBeNull();
    });

    it('rejects UPDATE', async () => {
      await expect(
        sql`UPDATE meta.audit_logs SET action = 'record.deleted' WHERE id = ${id}`.execute(
          db.kysely,
        ),
      ).rejects.toThrow(APPEND_ONLY);
      expect((await get(id)).action).toBe('record.updated');
    });

    it('rejects DELETE', async () => {
      await expect(
        sql`DELETE FROM meta.audit_logs WHERE id = ${id}`.execute(db.kysely),
      ).rejects.toThrow(APPEND_ONLY);
      await expect(get(id)).resolves.toMatchObject({ id });
    });

    it('rejects TRUNCATE of the table and of a partition', async () => {
      await expect(sql`TRUNCATE meta.audit_logs`.execute(db.kysely)).rejects.toThrow(APPEND_ONLY);
      const { rows } = await sql<{ partition: string }>`
        SELECT tableoid::regclass::text AS partition FROM meta.audit_logs WHERE id = ${id}
      `.execute(db.kysely);
      const partition = rows[0]?.partition ?? '';
      expect(partition).toMatch(/^meta\.audit_logs_p\d{6}$/);
      await expect(sql`TRUNCATE ${sql.table(partition)}`.execute(db.kysely)).rejects.toThrow(
        APPEND_ONLY,
      );
    });

    it('rejects DELETE on a partition directly', async () => {
      const { rows } = await sql<{ partition: string }>`
        SELECT tableoid::regclass::text AS partition FROM meta.audit_logs WHERE id = ${id}
      `.execute(db.kysely);
      await expect(
        sql`DELETE FROM ${sql.table(rows[0]?.partition ?? '')} WHERE id = ${id}`.execute(db.kysely),
      ).rejects.toThrow(APPEND_ONLY);
    });
  });

  describe('meta.audit_redact', () => {
    async function redactEntities(
      organizationId: string,
      requestedBy: string,
      entityType: string,
      entityIds: string[],
    ): Promise<bigint> {
      const { rows } = await sql<{ count: bigint }>`
        SELECT meta.audit_redact(${organizationId}, ${requestedBy}, ${entityType}, ${entityIds}::text[]) AS count
      `.execute(db.kysely);
      return rows[0]?.count ?? -1n;
    }

    it('redacts before/after of the given records in the organization only', async () => {
      const record = 'rec_RedactRecord0001';
      const target = await insert({ entity_id: record });
      const created = await insert({ entity_id: record, action: 'record.created' });
      const otherRecord = await insert({ entity_id: 'rec_RedactRecord0002' });
      const otherOrg = await insert({ organization_id: ORG_B, entity_id: record });
      const byRequester = await insert({ entity_id: record, actor_id: OWNER });
      const auditEntry = await insert({ entity_id: record, action: 'audit.viewed' });

      expect(await redactEntities(ORG_A, OWNER, 'record', [record])).toBe(2n);

      expect(await get(target)).toMatchObject({
        before: { redacted: true },
        after: { redacted: true },
        actor_id: ALICE,
        ip: '203.0.113.7',
      });
      expect((await get(created)).after).toEqual({ redacted: true });
      for (const untouched of [otherRecord, otherOrg, byRequester, auditEntry]) {
        expect((await get(untouched)).before).toEqual({ fld_name: 'Nguyễn Văn Ánh' });
      }
    });

    it('keeps NULL before/after as NULL', async () => {
      const record = 'rec_RedactRecord0003';
      const id = newId('aud');
      await db.kysely
        .insertInto('meta.audit_logs')
        .values({
          id,
          organization_id: ORG_A,
          actor_type: 'user',
          actor_id: ALICE,
          action: 'record.deleted',
          entity_type: 'record',
          entity_id: record,
        })
        .execute();
      expect(await redactEntities(ORG_A, OWNER, 'record', [record])).toBe(1n);
      expect(await get(id)).toMatchObject({ before: null, after: null });
    });

    it('user mode clears ip/user_agent of their actions and redacts entries about them', async () => {
      const bob = 'usr_AuditBob00000001';
      const action = await insert({ actor_id: bob, entity_id: 'rec_RedactRecord0004' });
      const aboutBob = await insert({ entity_type: 'user', entity_id: bob, actor_id: ALICE });
      const otherOrg = await insert({ organization_id: ORG_B, actor_id: bob });

      const { rows } = await sql<{ count: bigint }>`
        SELECT meta.audit_redact(${ORG_A}, ${OWNER}, p_user_id => ${bob}) AS count
      `.execute(db.kysely);
      expect(rows[0]?.count).toBe(2n);

      expect(await get(action)).toMatchObject({
        actor_id: bob,
        ip: null,
        user_agent: null,
        before: { fld_name: 'Nguyễn Văn Ánh' },
      });
      expect(await get(aboutBob)).toMatchObject({
        before: { redacted: true },
        after: { redacted: true },
      });
      expect(await get(otherOrg)).toMatchObject({ ip: '203.0.113.7', user_agent: 'Mozilla/5.0' });
    });

    it('validates its arguments', async () => {
      await expect(
        sql`SELECT meta.audit_redact(${ORG_A}, ${OWNER})`.execute(db.kysely),
      ).rejects.toThrow(/either an entity type with ids or a user id/);
      await expect(
        sql`SELECT meta.audit_redact(${ORG_A}, ${OWNER}, 'record', ARRAY[]::text[])`.execute(
          db.kysely,
        ),
      ).rejects.toThrow(/entity ids are required/);
      await expect(
        sql`SELECT meta.audit_redact(NULL, ${OWNER}, p_user_id => ${ALICE})`.execute(db.kysely),
      ).rejects.toThrow(/organization and requester are required/);
    });

    it('enables UPDATE only while it runs, not for the rest of the transaction', async () => {
      const record = 'rec_RedactRecord0005';
      const id = await insert({ entity_id: record });
      await expect(
        db.withTx(async (tx) => {
          await sql`SELECT meta.audit_redact(${ORG_A}, ${OWNER}, 'record', ARRAY[${record}]::text[])`.execute(
            tx,
          );
          const { rows } = await sql<{ value: string | null }>`
            SELECT current_setting('app.audit_redact', true) AS value
          `.execute(tx);
          expect(rows[0]?.value ?? '').not.toBe('on');
          await sql`UPDATE meta.audit_logs SET action = 'x' WHERE id = ${id}`.execute(tx);
        }),
      ).rejects.toThrow(APPEND_ONLY);
      // The whole transaction rolled back, redaction included.
      expect((await get(id)).before).toEqual({ fld_name: 'Nguyễn Văn Ánh' });
    });
  });
});
