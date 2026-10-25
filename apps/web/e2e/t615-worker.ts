/**
 * The worker of the T615 milestone stack, as a process of its own so the
 * spec can kill it (`SIGKILL`) between the two phases of the HTTP outbox —
 * run with `node` (types stripped), never imported by a spec.
 *
 * Environment: the stack's (`DATABASE_URL`, `CACHE_URL`, …) plus
 * `T615_WORKER`, JSON `{ telegramBaseUrl, hosts }`: the fake Bot API and the
 * test-only DNS of the outbox (`hosts`: name → addresses; any other name is
 * refused like an unknown host). Like the production worker: its own pool
 * (`application_name = e2e-t615-worker`), the Valkey pacers of outbound
 * HTTP and Telegram, realtime through Valkey. Logs JSON lines on stdout
 * (`event dispatched` carries the loop guard outcomes); prints `ready` once
 * started and stops gracefully on `SIGTERM`.
 */
import { createRequire } from 'node:module';

interface Settings {
  readonly telegramBaseUrl: string;
  readonly hosts: Record<string, string[]>;
}

const settings = JSON.parse(process.env['T615_WORKER'] ?? '{}') as Settings;
const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));
const requireFromWorker = createRequire(new URL('../../worker/package.json', import.meta.url));

const core = (await import(
  new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
)) as Record<string, (...args: never[]) => unknown> & {
  ValkeyRealtimeBus: new (client: unknown, onError: (err: unknown) => void) => unknown;
  JOB_STATEMENT_TIMEOUT_MS: number;
};
const build = (await import(new URL('../../worker/dist/index.js', import.meta.url).href)) as {
  createWorker: (
    config: unknown,
    options: Record<string, unknown>,
  ) => Promise<{ close: () => Promise<void> }>;
  buildTaskList: (deps: Record<string, unknown>) => unknown;
};
const { pino } = requireFromApi('pino') as {
  pino: (options: Record<string, unknown>) => unknown;
};
const { Redis } = requireFromWorker('ioredis') as {
  Redis: new (url: string, options: Record<string, unknown>) => { quit: () => Promise<unknown> };
};

const loadConfig = core['loadConfig'] as unknown as (env: NodeJS.ProcessEnv) => {
  database: { url: string; poolMax: number };
  cache: { url: string };
};
const config = loadConfig({ ...process.env, MODE: 'worker' });
const logger = pino({ level: 'info', base: { service: 'e2e-t615-worker' } });
const createDb = core['createDb'] as unknown as (options: Record<string, unknown>) => {
  destroy: () => Promise<void>;
};
const db = createDb({
  url: config.database.url,
  poolMax: config.database.poolMax,
  applicationName: 'e2e-t615-worker',
  statementTimeoutMs: core.JOB_STATEMENT_TIMEOUT_MS,
});
const cache = new Redis(config.cache.url, { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
const realtime = new core.ValkeyRealtimeBus(cache, () => undefined);
(core['attachRealtimePublisher'] as unknown as (db: unknown, bus: unknown) => void)(db, realtime);
const quota = (core['valkeyQuotaClient'] as unknown as (client: unknown) => unknown)(cache);
const keyPrefix = 'ob:';
const taskList = build.buildTaskList({
  config,
  db,
  logger,
  realtime,
  telegramClient: { baseUrl: settings.telegramBaseUrl },
  telegramPacers: (
    core['createValkeyTelegramPacers'] as unknown as (q: unknown, o: unknown) => unknown
  )(quota, { keyPrefix }),
  hostPacer: (core['createValkeyHostPacer'] as unknown as (q: unknown, o: unknown) => unknown)(
    quota,
    { keyPrefix },
  ),
  httpDelivery: {
    lookup: (host: string) => {
      const addresses = settings.hosts[host];
      return addresses === undefined
        ? Promise.reject(Object.assign(new Error(`unknown host ${host}`), { code: 'ENOTFOUND' }))
        : Promise.resolve(addresses);
    },
  },
  notificationEmailBatchMs: 500,
  notificationTelegramBatchMs: 300,
});
const worker = await build.createWorker(config, { logger, taskList, pollIntervalMs: 100 });
process.stdout.write('ready\n');

process.once('SIGTERM', () => {
  void (async () => {
    await worker.close();
    await db.destroy();
    await cache.quit();
    process.exit(0);
  })();
});
