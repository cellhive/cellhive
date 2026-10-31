import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import { createServer, preview } from 'vite';

import { startFakeLlm } from './fake-llm';
import { startFakeOidc } from './fake-oidc';
import { E2E_API_PORT, E2E_STACK_ENV, E2E_WEB_PORT, E2E_WEB_URL } from './ports';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_MAIN = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));

function runToCompletion(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [API_MAIN], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`API migrations exited with code ${String(code)}`));
    });
  });
}

async function waitUntilUp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${String(child.exitCode)}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`API did not answer ${url} within 60 s`);
}

/**
 * Boots the E2E stack: PostgreSQL 18 + Valkey 8 (Testcontainers, no host
 * ports to clash with `pnpm dev:infra`), migrations, the built API
 * (`apps/api/dist`, MODE=all: API + worker, local file storage, the fake OIDC provider of
 * `fake-oidc.ts`, the fake AI provider of `fake-llm.ts`) and `vite preview` of the
 * built SPA proxying `/api` to it. Returns the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(API_MAIN) || !existsSync(join(WEB_DIR, 'dist', 'index.html'))) {
    throw new Error('Build first: `pnpm test:e2e` from the repository root builds api and web.');
  }
  const [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-'));
  // T715: an OIDC provider (HTTPS, self-signed) for the SSO specs; the API trusts its certificate.
  const idp = await startFakeOidc();
  // T912: an OpenAI-compatible provider on loopback; the worker fixture points each org at it.
  const closeLlm = await startFakeLlm();

  // A clean environment: nothing from the developer's shell or .env leaks in.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PORT: String(E2E_API_PORT),
    PUBLIC_URL: E2E_WEB_URL,
    DATABASE_URL: postgres.getConnectionUri(),
    CACHE_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
    APP_MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: storage,
    DEFAULT_LOCALE: 'en',
    DEFAULT_TIMEZONE: 'UTC',
    LOG_LEVEL: 'warn',
    ...idp.env,
  };
  await runToCompletion({ ...env, MODE: 'migrate' });
  // Specs that need data run the API seed scripts against the same stack (e2e/seed.ts).
  process.env[E2E_STACK_ENV] = JSON.stringify(env);
  // MODE=all: the worker runs in the API process, so background jobs (e.g.
  // removing deleted select options from records, T207) complete in E2E.
  const api = spawn(process.execPath, [API_MAIN], {
    env: { ...env, MODE: 'all' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitUntilUp(`http://127.0.0.1:${String(E2E_API_PORT)}/healthz`, api);

  process.env['VITE_API_TARGET'] = `http://127.0.0.1:${String(E2E_API_PORT)}`;
  const common = {
    root: WEB_DIR,
    configFile: join(WEB_DIR, 'vite.config.ts'),
    logLevel: 'warn',
  } as const;
  const listen = { host: '127.0.0.1', port: E2E_WEB_PORT, strictPort: true, open: false };
  // E2E_VITE_DEV=1: the dev server instead of the build, so every API response
  // is also checked against its contract schema (FRONTEND §3.1).
  const server =
    process.env['E2E_VITE_DEV'] === '1'
      ? await (await createServer({ ...common, server: listen })).listen()
      : await preview({ ...common, preview: listen });

  return async () => {
    await server.close();
    if (api.exitCode === null) {
      const exited = new Promise((resolve) => api.once('exit', resolve));
      api.kill('SIGTERM');
      await exited;
    }
    await Promise.all([postgres.stop(), valkey.stop(), idp.close(), closeLlm()]);
    await rm(storage, { recursive: true, force: true });
  };
}
