import { Buffer } from 'node:buffer';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveSecretKey, sealSecret } from '../../src/auth/index.js';
import { createMigrator, migrateToLatest, orgScope, type Db } from '../../src/db/index.js';
import { databaseSecretSource } from '../../src/http-out/index.js';
import { SecretsRepository } from '../../src/secrets/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_SecretHostsOrgA1';
const ORG_B = 'org_SecretHostsOrgB1';
const MASTER = Buffer.alloc(32, 7);
const KEY = deriveSecretKey(MASTER, 'org-secret');
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const DAY_MS = 24 * 3600_000;

/**
 * BACKLOG T701 (ADR-36 §4): migration 0051 on a database that already has
 * secrets, the CHECK it adds, the hosts read at delivery time without
 * unsealing, and tenant isolation of that read.
 */
describe('secret allowed hosts: migration 0051 and the delivery source (T701)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  let migratedAt: number;

  const insertSecret = (id: Id<'sec'>, kind: string, name: string, orgId: Id<'org'> = ORG_A) =>
    sql`
      INSERT INTO meta.secrets (id, organization_id, kind, name, ciphertext)
      VALUES (${id}, ${orgId}, ${kind}, ${name}, ${sealSecret(KEY, kind === 'telegram_bot' ? TOKEN : 'Bearer canary-legacy-value')})
    `.execute(db.kysely);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    const { error } = await createMigrator(db.kysely).migrateTo('0050_user_identities_details');
    expect(error).toBeUndefined();
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await insertSecret('sec_SecretHostsBot01', 'telegram_bot', 'Bot');
    await insertSecret('sec_SecretHostsHdr01', 'http_header', 'CRM');
    await insertSecret('sec_SecretHostsSig01', 'webhook_signing', 'Signing');
    await insertSecret('sec_SecretHostsHdrB1', 'http_header', 'CRM', ORG_B);
    migratedAt = Date.now();
    expect(await migrateToLatest(db.kysely)).toContain('0051_secrets_allowed_hosts');
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('gives existing HTTP secrets 30 days without a list; other kinds nothing', async () => {
    const rows = await db.kysely
      .selectFrom('meta.secrets')
      .select(['id', 'allowed_hosts', 'legacy_hosts_until'])
      .orderBy('id')
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('sec_SecretHostsBot01')).toMatchObject({
      allowed_hosts: [],
      legacy_hosts_until: null,
    });
    for (const id of ['sec_SecretHostsHdr01', 'sec_SecretHostsSig01', 'sec_SecretHostsHdrB1']) {
      const row = byId.get(id as Id<'sec'>);
      expect(row?.allowed_hosts).toEqual([]);
      const until = row?.legacy_hosts_until?.getTime() ?? 0;
      // `now()` of the migration's transaction + 30 days (clock of the container vs. this one).
      expect(Math.abs(until - (migratedAt + 30 * DAY_MS))).toBeLessThan(60_000);
    }
  });

  it('CHECK: an HTTP secret has a list or a deadline (exactly one); other kinds neither', async () => {
    const attempt = (set: ReturnType<typeof sql>, id: string) =>
      sql`UPDATE meta.secrets SET ${set} WHERE id = ${id}`.execute(db.kysely);
    const violation = { code: '23514' };
    // Both.
    await expect(
      attempt(sql`allowed_hosts = ARRAY['a.test']`, 'sec_SecretHostsHdr01'),
    ).rejects.toMatchObject(violation);
    // Neither.
    await expect(
      attempt(sql`legacy_hosts_until = NULL`, 'sec_SecretHostsHdr01'),
    ).rejects.toMatchObject(violation);
    // More than 20, or a NULL entry.
    await expect(
      attempt(
        sql`allowed_hosts = array_fill('a.test'::text, ARRAY[21]), legacy_hosts_until = NULL`,
        'sec_SecretHostsHdr01',
      ),
    ).rejects.toMatchObject(violation);
    await expect(
      attempt(
        sql`allowed_hosts = ARRAY[NULL::text], legacy_hosts_until = NULL`,
        'sec_SecretHostsHdr01',
      ),
    ).rejects.toMatchObject(violation);
    // A Telegram bot has neither.
    await expect(
      attempt(sql`allowed_hosts = ARRAY['a.test']`, 'sec_SecretHostsBot01'),
    ).rejects.toMatchObject(violation);
    await expect(
      attempt(sql`legacy_hosts_until = now()`, 'sec_SecretHostsBot01'),
    ).rejects.toMatchObject(violation);
    // Setting a list ends the transition period.
    await attempt(
      sql`allowed_hosts = ARRAY['api.crm.test'], legacy_hosts_until = NULL`,
      'sec_SecretHostsSig01',
    );
  });

  it('reads the hosts at delivery time without unsealing, inside the organization only', async () => {
    // Another master key: values cannot be unsealed, hosts are still read (no unseal needed).
    const wrongKey = databaseSecretSource(db, Buffer.alloc(32, 9));
    const auth = {
      secretId: 'sec_SecretHostsHdr01' as Id<'sec'>,
      purpose: 'auth',
      baseId: a.baseId,
    } as const;
    const policy = await wrongKey.hosts(orgScope(ORG_A), auth);
    expect(policy?.allowedHosts).toEqual([]);
    expect(policy?.legacyHostsUntil).toBeInstanceOf(Date);
    expect(await wrongKey.values(orgScope(ORG_A), auth)).toBeNull();

    const source = databaseSecretSource(db, MASTER);
    expect(
      await source.hosts(orgScope(ORG_A), {
        secretId: 'sec_SecretHostsSig01',
        purpose: 'signing',
        baseId: a.baseId,
      }),
    ).toEqual({ allowedHosts: ['api.crm.test'], legacyHostsUntil: null });
    // Wrong kind for the purpose.
    expect(await source.hosts(orgScope(ORG_A), { ...auth, purpose: 'signing' })).toBeNull();
    // Tenant isolation: the secret of A is unknown in B (with or without a base).
    expect(await source.hosts(orgScope(ORG_B), { ...auth, baseId: b.baseId })).toBeNull();
    expect(await source.hosts(orgScope(ORG_B), { ...auth, baseId: null })).toBeNull();
    expect(
      await new SecretsRepository(db).findUsable(
        orgScope(ORG_B),
        'sec_SecretHostsHdr01',
        b.baseId,
        'http_header',
      ),
    ).toBeUndefined();
    // B's own secret of the same name is B's, with its own deadline.
    expect(
      (
        await source.hosts(orgScope(ORG_B), {
          secretId: 'sec_SecretHostsHdrB1',
          purpose: 'auth',
          baseId: b.baseId,
        })
      )?.legacyHostsUntil,
    ).toBeInstanceOf(Date);
    // The list of A carries the columns, never a value.
    const [listed] = (await new SecretsRepository(db).list(orgScope(ORG_A))).filter(
      (row) => row.id === 'sec_SecretHostsSig01',
    );
    expect(listed).toMatchObject({ allowed_hosts: ['api.crm.test'], legacy_hosts_until: null });
    expect(listed).not.toHaveProperty('ciphertext');
  });
});
