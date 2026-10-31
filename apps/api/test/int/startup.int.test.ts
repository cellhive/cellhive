import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDb, emit } from '@cellhive/server-core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { TEST_PUBLIC_URL, TEST_SESSION_SECRET } from './support.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface RunResult {
  readonly code: number | null;
  readonly logs: Record<string, unknown>[];
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `src/main.ts` (through tsx) the way the container runs `dist/main.js`. */
function runMain(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts'],
      {
        cwd: API_ROOT,
        timeout: 60_000,
        // Only what the process needs: no developer `.env`, no inherited MODE.
        env: { PATH: process.env.PATH ?? '', ...env },
      },
      (error, stdout, stderr) => {
        const logs = stdout
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        resolve({
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          logs,
          stdout,
          stderr,
        });
      },
    );
  });
}

interface RunningMain {
  readonly logs: () => Record<string, unknown>[];
  waitForLog(msg: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Sends the signal and resolves with the exit code. */
  stop(signal: NodeJS.Signals): Promise<number | null>;
}

/** Starts `src/main.ts` as a long-running process (MODE=worker / all). */
function startMain(env: Record<string, string>): RunningMain {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: API_ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  const logs = () =>
    stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    logs,
    async waitForLog(msg, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const line = logs().find((entry) => entry.msg === msg);
        if (line !== undefined) return line;
        if (child.exitCode !== null || Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error(`'${msg}' was not logged; output:\n${stdout}\n${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    stop(signal) {
      child.kill(signal);
      return exited;
    },
  };
}

/**
 * A TCP port free right now (the OS picks it), for a process that listens on
 * all interfaces. `PORT` must be 1–65535, so the child cannot take port 0.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

/**
 * Starts a listening process on a free port and waits for `api listening`.
 * Another process may still take the port between the probe and the bind
 * (EADDRINUSE): then it starts again on a new port.
 */
async function startListening(
  env: Record<string, string>,
): Promise<{ main: RunningMain; port: number }> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const main = startMain({ ...env, PORT: String(port) });
    try {
      await main.waitForLog('api listening');
      return { main, port };
    } catch (error) {
      if (attempt >= 5 || !String(error).includes('EADDRINUSE')) throw error;
    }
  }
}

async function createDatabase(adminUrl: string): Promise<string> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe('process startup', () => {
  let storageRoot: string;

  function baseEnv(databaseUrl: string, mode: string): Record<string, string> {
    return {
      NODE_ENV: 'test',
      MODE: mode,
      PORT: '39999',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: databaseUrl,
      CACHE_URL: inject('cacheUrl'),
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storageRoot,
      LOG_LEVEL: 'info',
    };
  }

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'cellhive-startup-'));
  });

  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('MODE=migrate applies the meta migrations, exits 0, and is a no-op the second time', async () => {
    const databaseUrl = await createDatabase(inject('databaseUrl'));

    const first = await runMain(baseEnv(databaseUrl, 'migrate'));
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0001_initial' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0002_partition_retention' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0003_tables_fields' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0004_audit_log_indexes' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0005_idempotency_claim_id' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0006_password_reset_source' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0007_views' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0008_share_links' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0009_form_submissions' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0010_imports' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0011_link_fields' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0012_attachments' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0013_field_conversions' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0015_link_conversions' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0016_attachment_thumbnails' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0017_attachment_record_purges' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0018_form_uploads' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0019_form_covers' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0020_table_purges' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0021_fx_functions' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0022_computed_fields' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0023_fx_text_contain' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0024_computed_recompute_queue' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0025_fx_date_text_args' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0026_computed_tenant_fks' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0027_automations' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0030_computed_recompute_causation' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0031_automation_run_timing' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0032_automation_run_reruns' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0033_automation_time_triggers' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0034_button_fields' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0035_email_assets' }));
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0036_secrets' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0037_events_entity_index' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0038_notification_buffer' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0039_record_follows' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0040_user_channels' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0041_date_reminder_cursors' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0042_http_allowlist' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0043_incoming_webhooks' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0044_http_deliveries' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0045_webhook_actor_type' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0046_telegram_webhooks' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0047_secrets_http_kinds' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0048_automation_runs_event_index' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0049_api_tokens' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0050_user_identities_details' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0051_secrets_allowed_hosts' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0052_audit_logs_actor_action_idx' }),
    );
    expect(first.logs).toContainEqual(expect.objectContaining({ migration: '0054_ai_settings' }));
    expect(first.logs).toContainEqual(
      expect.objectContaining({ migration: '0055_canonical_time_zones' }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ msg: 'database is up to date', applied: 56 }),
    );
    expect(first.logs).toContainEqual(
      expect.objectContaining({ msg: 'job queue schema is up to date' }),
    );

    const second = await runMain(baseEnv(databaseUrl, 'migrate'));
    expect(second.code).toBe(0);
    expect(second.logs).toContainEqual(
      expect.objectContaining({ msg: 'database is up to date', applied: 0 }),
    );

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ plain: string }>(
        "SELECT meta.f_unaccent('Nguyễn Văn Ánh') AS plain",
      );
      expect(rows[0]?.plain).toBe('Nguyen Van Anh');
      // graphile-worker's schema is installed by the same step (ADR-06).
      const queue = await client.query<{ exists: boolean }>(
        "SELECT to_regprocedure('graphile_worker.add_job(text,json,text,timestamptz,integer,text,integer,text[],text)') IS NOT NULL AS exists",
      );
      expect(queue.rows[0]?.exists).toBe(true);
    } finally {
      await client.end();
    }
  });

  it('MODE=worker dispatches events and stops gracefully on SIGTERM', async () => {
    const databaseUrl = await createDatabase(inject('databaseUrl'));
    expect((await runMain(baseEnv(databaseUrl, 'migrate'))).code).toBe(0);
    const worker = startMain(baseEnv(databaseUrl, 'worker'));
    await worker.waitForLog('worker started');

    const db = createDb({ url: databaseUrl, poolMax: 1 });
    try {
      await db.kysely
        .insertInto('meta.organizations')
        .values({ id: 'org_StartupWorker001', name: 'Startup', slug: 'startup-worker' })
        .execute();
      const event = await db.withTx((tx) =>
        emit(tx, {
          type: 'org.updated',
          organizationId: 'org_StartupWorker001',
          entityId: 'org_StartupWorker001',
          actor: { type: 'system', id: null },
        }),
      );
      const line = await worker.waitForLog('event dispatched');
      expect(line).toMatchObject({ event_id: event.id, component: 'worker' });
    } finally {
      await db.destroy();
    }

    expect(await worker.stop('SIGTERM')).toBe(0);
    expect(worker.logs()).toContainEqual(expect.objectContaining({ msg: 'job runner stopped' }));
    expect(worker.logs()).toContainEqual(expect.objectContaining({ msg: 'shutdown complete' }));
  });

  it('MODE=all serves HTTP and runs the worker in one process', async () => {
    const databaseUrl = await createDatabase(inject('databaseUrl'));
    expect((await runMain(baseEnv(databaseUrl, 'migrate'))).code).toBe(0);
    const { main: all, port } = await startListening(baseEnv(databaseUrl, 'all'));
    await all.waitForLog('worker started');
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(response.status).toBe(200);
    expect(await all.stop('SIGTERM')).toBe(0);
    expect(all.logs()).toContainEqual(expect.objectContaining({ msg: 'job runner stopped' }));
  });

  it('refuses to start when an OIDC provider has no issuer, without printing its secret (T707)', async () => {
    const secret = 'oidc-startup-client-secret-canary';
    const result = await runMain({
      ...baseEnv(inject('databaseUrl'), 'api'),
      OIDC_PROVIDERS: 'keycloak',
      OIDC_KEYCLOAK_CLIENT_ID: 'cellhive',
      OIDC_KEYCLOAK_CLIENT_SECRET: secret,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OIDC_KEYCLOAK_ISSUER: is required');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.logs.some((line) => line.msg === 'api listening')).toBe(false);
  });

  describe('against postgres:17', () => {
    let postgres17: StartedPostgreSqlContainer;

    beforeAll(async () => {
      postgres17 = await new PostgreSqlContainer('postgres:17').start();
    });

    afterAll(async () => {
      await postgres17.stop();
    });

    it.each(['api', 'migrate', 'worker'])(
      'MODE=%s refuses to start with a clear error',
      async (mode) => {
        const result = await runMain(baseEnv(postgres17.getConnectionUri(), mode));
        expect(result.code).toBe(1);
        const fatal = result.logs.find((line) => line.level === 'fatal');
        expect(fatal?.msg).toMatch(
          /^PostgreSQL 17\.\d+.* is not supported: Cellhive requires PostgreSQL 18 or newer/,
        );
        expect(result.logs.some((line) => line.msg === 'api listening')).toBe(false);
      },
    );
  });
});
