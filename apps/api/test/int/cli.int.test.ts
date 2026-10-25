import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { newId, type Id } from '@cellhive/contracts';
import {
  ApiTokensRepository,
  generateApiToken,
  JOB_QUEUE_SCHEMA,
  orgScope,
  UserIdentitiesRepository,
  type Db,
  type Env,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runCli } from '../../src/cli/run.js';

import { Browser, seedOrg, seedUser, uniqueIp } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { startTestApp, TEST_PUBLIC_URL, TEST_SESSION_SECRET, type TestApp } from './support.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LINK = new RegExp(`^${TEST_PUBLIC_URL}/reset/([A-Za-z0-9_-]{43})$`);

function env(databaseUrl: string): Env {
  return {
    NODE_ENV: 'test',
    PUBLIC_URL: TEST_PUBLIC_URL,
    DATABASE_URL: databaseUrl,
    CACHE_URL: inject('cacheUrl'),
    APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: TEST_SESSION_SECRET,
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: '/tmp/cellhive-cli-test',
    LOG_LEVEL: 'warn',
  };
}

interface CliRun {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function cli(databaseUrl: string, ...argv: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, env(databaseUrl), {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tokenOf(line: string | undefined): string {
  const token = LINK.exec(line ?? '')?.[1];
  if (token === undefined) throw new Error(`not a reset link: ${String(line)}`);
  return token;
}

describe('cellhive CLI', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('prints usage for --help and fails with 2 on bad usage (before connecting)', async () => {
    const help = await cli('postgres://unused/db', '--help');
    expect(help.code).toBe(0);
    expect(help.out.join('\n')).toContain('user reset-password --email');
    const missing = await cli('postgres://unused/db', 'user', 'reset-password');
    expect(missing.code).toBe(2);
    expect(missing.err.join('\n')).toContain('--email is required');
    const unknown = await cli('postgres://unused/db', 'frobnicate');
    expect(unknown.code).toBe(2);
    const badEmail = await cli('postgres://unused/db', 'setup', '--email', 'nope', '--org', 'X');
    expect(badEmail.code).toBe(2);
  });

  it('setup: creates user + org + owner and prints a set-password link; refuses twice', async () => {
    const run = await cli(
      database.url,
      'setup',
      '--email',
      'root@example.test',
      '--org',
      'Công ty Đông Á',
      '--locale',
      'vi',
    );
    expect(run.code).toBe(0);
    expect(run.out).toHaveLength(1);
    const token = tokenOf(run.out[0]);

    const user = await db.kysely
      .selectFrom('meta.users')
      .selectAll()
      .where('email', '=', 'root@example.test')
      .executeTakeFirstOrThrow();
    expect(user.password_hash).toBeNull();
    const org = await db.kysely
      .selectFrom('meta.organizations')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(org).toMatchObject({ slug: 'cong-ty-dong-a' });
    expect(org.settings).toMatchObject({ locale: 'vi' });
    const membership = await db.kysely
      .selectFrom('meta.org_members')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(membership).toMatchObject({ organization_id: org.id, user_id: user.id, role: 'owner' });
    const reset = await db.kysely
      .selectFrom('meta.password_resets')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(reset.token_hash).toBe(sha256(token));

    const audit = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['action', 'organization_id', 'actor_type', 'actor_id'])
      .orderBy('action')
      .execute();
    expect(audit).toEqual([
      {
        action: 'auth.password_reset_requested',
        organization_id: null,
        actor_type: 'system',
        actor_id: null,
      },
      { action: 'org.created', organization_id: org.id, actor_type: 'system', actor_id: null },
      { action: 'org_member.added', organization_id: org.id, actor_type: 'system', actor_id: null },
      { action: 'setup.completed', organization_id: org.id, actor_type: 'system', actor_id: null },
    ]);

    // The printed link sets the first password; then the owner can sign in.
    const redeemed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/auth/password-reset/${token}`,
      payload: { password: 'First-Owner-Password-1' },
      remoteAddress: uniqueIp(),
    });
    expect(redeemed.statusCode).toBe(204);
    const login = await new Browser(t.app).login('root@example.test', 'First-Owner-Password-1');
    expect(login.statusCode).toBe(204);

    const again = await cli(database.url, 'setup', '--email', 'b@example.test', '--org', 'B');
    expect(again.code).toBe(1);
    expect(again.err.join('\n')).toContain('already set up');
  });

  it('user reset-password: prints a link, audits with actor system and organization_id NULL', async () => {
    const target = await seedUser(db, {});
    const run = await cli(database.url, 'user', 'reset-password', '--email', target.email);
    expect(run.code).toBe(0);
    const token = tokenOf(run.out[0]);
    expect(run.err.join('\n')).toContain('valid until');

    const entry = await db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('action', '=', 'auth.password_reset_requested')
      .where('entity_id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ organization_id: null, actor_type: 'system', actor_id: null });
    expect(JSON.stringify(entry)).not.toContain(token);
    const link = await db.kysely
      .selectFrom('meta.password_resets')
      .select(['source', 'created_by'])
      .where('user_id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(link).toEqual({ source: 'cli', created_by: null });

    const unknown = await cli(database.url, 'user', 'reset-password', '--email', 'no@example.test');
    expect(unknown.code).toBe(1);
    expect(unknown.err.join('\n')).toContain('No user');
  });

  it('user reset-password: revokes every API token of the user in every org by default, --keep-tokens keeps them (T802)', async () => {
    const orgA = await seedOrg(db, 'Tokens A');
    const orgB = await seedOrg(db, 'Tokens B');
    const target = await seedUser(db, {
      memberships: [
        { orgId: orgA, role: 'member' },
        { orgId: orgB, role: 'admin' },
      ],
    });
    const tokens = new ApiTokensRepository(db);
    const tokenIn = async (orgId: Id<'org'>): Promise<Id<'tok'>> => {
      const { prefix, hash } = generateApiToken();
      const row = await tokens.create(orgScope(orgId), {
        id: newId('tok'),
        user_id: target.id,
        name: 'CI',
        token_prefix: prefix,
        token_hash: hash,
        scopes: ['records:read'],
        base_ids: null,
        expires_at: null,
      });
      return row.id;
    };
    const revokedAt = async (orgId: Id<'org'>, id: Id<'tok'>) =>
      (await tokens.findById(orgScope(orgId), id))?.revoked_at ?? null;

    // --keep-tokens: nothing revoked, the request audit says 0.
    const kept = [await tokenIn(orgA), await tokenIn(orgB)];
    const keep = await cli(
      database.url,
      'user',
      'reset-password',
      '--email',
      target.email,
      '--keep-tokens',
    );
    expect(keep.code).toBe(0);
    expect(keep.err.join('\n')).toContain('kept');
    expect(await revokedAt(orgA, kept[0] as Id<'tok'>)).toBeNull();
    expect(await revokedAt(orgB, kept[1] as Id<'tok'>)).toBeNull();

    // Default: both orgs, one bulk audit per org, one event per token.
    const extra = await tokenIn(orgA);
    const run = await cli(database.url, 'user', 'reset-password', '--email', target.email);
    expect(run.code).toBe(0);
    expect(run.err.join('\n')).toContain('Revoked 3 API token(s)');
    for (const [orgId, id] of [
      [orgA, kept[0]],
      [orgA, extra],
      [orgB, kept[1]],
    ] as const) {
      expect(await revokedAt(orgId, id as Id<'tok'>)).toBeInstanceOf(Date);
    }
    const audits = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['organization_id', 'actor_type', 'entity_type', 'entity_id', 'after'])
      .where('action', '=', 'api_token.revoked')
      .where('entity_id', '=', target.id)
      .orderBy('organization_id')
      .execute();
    expect(audits).toHaveLength(2);
    const byOrg = new Map(audits.map((entry) => [entry.organization_id, entry]));
    expect(byOrg.get(orgA)).toMatchObject({
      actor_type: 'system',
      entity_type: 'user',
      after: { reason: 'password_reset', count: 2 },
    });
    expect(byOrg.get(orgB)).toMatchObject({ after: { count: 1, token_ids: [kept[1]] } });
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['organization_id', 'entity_id'])
      .where('type', '=', 'api_token.revoked')
      .where('entity_id', 'in', [kept[0], kept[1], extra] as Id<'tok'>[])
      .execute();
    expect(events).toHaveLength(3);
    const requested = await db.kysely
      .selectFrom('meta.audit_logs')
      .select('after')
      .where('action', '=', 'auth.password_reset_requested')
      .where('entity_id', '=', target.id)
      .orderBy('created_at')
      .execute();
    expect(
      requested.map((entry) => (entry.after as { revoked_tokens?: number }).revoked_tokens),
    ).toEqual([0, 3]);

    // A second run writes nothing more: revoked tokens keep their revoked_at.
    const before = await revokedAt(orgA, extra);
    const again = await cli(database.url, 'user', 'reset-password', '--email', target.email);
    expect(again.err.join('\n')).toContain('Revoked 0 API token(s)');
    expect(await revokedAt(orgA, extra)).toEqual(before);
  });

  it('user reset-password: break-glass for an OIDC-only user — sets a first password, identity kept (T708)', async () => {
    const target = await seedUser(db, { password: null });
    await new UserIdentitiesRepository(db).create({
      userId: target.id,
      provider: 'gone',
      subject: 'sub-gone',
      email: target.email,
    });
    const run = await cli(database.url, 'user', 'reset-password', '--email', target.email);
    expect(run.code).toBe(0);
    const redeemed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/auth/password-reset/${tokenOf(run.out[0])}`,
      payload: { password: 'Break-Glass-Password-1' },
      remoteAddress: uniqueIp(),
    });
    expect(redeemed.statusCode).toBe(204);
    expect(
      (await new Browser(t.app).login(target.email, 'Break-Glass-Password-1')).statusCode,
    ).toBe(204);
    expect(await new UserIdentitiesRepository(db).listByUser(target.id)).toHaveLength(1);
  });

  it('org create: with an existing owner, and with a new owner who gets a link', async () => {
    const existing = await seedUser(db, {});
    const first = await cli(
      database.url,
      'org',
      'create',
      '--name',
      'Gamma',
      '--owner-email',
      existing.email,
    );
    expect(first.code).toBe(0);
    expect(first.out).toHaveLength(1);
    const orgId = first.out[0] ?? '';
    const role = await db.kysely
      .selectFrom('meta.org_members')
      .select('role')
      .where('organization_id', '=', orgId as `org_${string}`)
      .where('user_id', '=', existing.id)
      .executeTakeFirstOrThrow();
    expect(role.role).toBe('owner');
    const event = await db.kysely
      .selectFrom('meta.events')
      .select(['type', 'actor_type'])
      .where('organization_id', '=', orgId as `org_${string}`)
      .where('type', '=', 'org.created')
      .executeTakeFirstOrThrow();
    expect(event.actor_type).toBe('system');

    const second = await cli(
      database.url,
      'org',
      'create',
      '--name',
      'Gamma',
      '--owner-email',
      'new-owner@example.test',
    );
    expect(second.code).toBe(0);
    expect(second.out).toHaveLength(2);
    tokenOf(second.out[1]);
    const orgs = await db.kysely
      .selectFrom('meta.organizations')
      .select('slug')
      .where('name', '=', 'Gamma')
      .execute();
    expect(new Set(orgs.map((org) => org.slug)).size).toBe(2);
  });

  it('jobs unlock-stale: releases locks older than the threshold only', async () => {
    const schema = sql.id(JOB_QUEUE_SCHEMA);
    const addJob = async (): Promise<bigint> => {
      const { rows } = await sql<{ id: bigint }>`
        SELECT (${schema}.add_job('events.dispatch', '{}'::json)).id`.execute(db.kysely);
      return rows[0]?.id ?? -1n;
    };
    const deadJob = await addJob();
    const liveJob = await addJob();
    const jobs = sql.id(JOB_QUEUE_SCHEMA, '_private_jobs');
    await sql`UPDATE ${jobs} SET locked_by = 'worker-dead', locked_at = now() - interval '2 hours'
              WHERE id = ${deadJob}`.execute(db.kysely);
    await sql`UPDATE ${jobs} SET locked_by = 'worker-alive', locked_at = now()
              WHERE id = ${liveJob}`.execute(db.kysely);

    const dry = await cli(database.url, 'jobs', 'unlock-stale', '--dry-run');
    expect(dry).toMatchObject({ code: 0, out: ['worker-dead'] });

    const run = await cli(database.url, 'jobs', 'unlock-stale', '--older-than', '60');
    expect(run).toMatchObject({ code: 0, out: ['worker-dead'] });
    const after = await sql<{ id: bigint; locked_by: string | null }>`
      SELECT id, locked_by FROM ${jobs} WHERE id IN (${deadJob}, ${liveJob}) ORDER BY id`.execute(
      db.kysely,
    );
    expect(after.rows).toEqual([
      { id: deadJob, locked_by: null },
      { id: liveJob, locked_by: 'worker-alive' },
    ]);

    const none = await cli(database.url, 'jobs', 'unlock-stale');
    expect(none).toMatchObject({ code: 0, out: [] });
  });

  it('migrate: is a no-op on an up-to-date database', async () => {
    const run = await cli(database.url, 'migrate');
    expect(run.code).toBe(0);
    expect(run.err.join('\n')).toContain('0 migration(s) applied');
  });

  it('runs as a process (`node src/cli.ts` like `node dist/cli.js` in the image)', async () => {
    const target = await seedUser(db, {});
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', 'src/cli.ts', 'user', 'reset-password', '--email', target.email],
          {
            cwd: API_ROOT,
            timeout: 60_000,
            env: { PATH: process.env.PATH ?? '', ...env(database.url) },
          },
          (error, stdout, stderr) => {
            resolve({
              code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
              stdout,
              stderr,
            });
          },
        );
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(LINK);
    expect(result.stderr).toContain('Password reset link');
  });
});
