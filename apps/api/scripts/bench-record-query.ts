/**
 * Bench of `POST /api/v1/tables/:id/records/query` over real HTTP (SPEC §21:
 * query with filter + sort, limit 200, p95 < 500 ms) on the `pnpm
 * seed:bench` data. Starts the API in-process on a random local port with
 * the usual environment, signs in as the bench owner and reports
 * p50/p95/p99 per scenario. Development only:
 *
 *   pnpm seed:bench && pnpm --filter @cellhive/api bench:records [--runs 50] [--concurrency 4]
 *
 * The rate limits are lifted for the run (they would cap a sequential
 * client at 20 requests/s per base).
 */
import process from 'node:process';

import {
  BasesRepository,
  loadConfig,
  OrganizationsRepository,
  orgScope,
  TablesRepository,
  UsersRepository,
  WorkspacesRepository,
  type Db,
} from '@cellhive/server-core';
import { destination, pino } from 'pino';

import { createApp } from '../src/app.factory.js';
import { rootLoggerOptions } from '../src/common/logging/root-logger.js';
import { ApiRateLimits } from '../src/common/rate-limit/api-rate-limits.js';
import { DB } from '../src/common/tokens.js';
import { BENCH_EMAIL, BENCH_PASSWORD } from '../src/seed/bench-seed.js';
import { BENCH_TABLE_NAME } from '../src/seed/bench-table.js';

import type { AddressInfo } from 'node:net';

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} expects a positive integer`);
  return value;
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

interface Scenario {
  readonly name: string;
  readonly body: object;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'filter + sort, limit 200, first page',
    body: {
      filter: {
        logic: 'and',
        conditions: [
          ['Trạng thái', 'intersects', ['Mới', 'Đang xử lý']],
          ['Số tiền', '>=', 5_000_000],
        ],
      },
      sort: [{ field: 'Hạn', direction: 'asc' }],
      limit: 200,
    },
  },
  {
    name: 'filter + sort desc on number, limit 200',
    body: {
      filter: { logic: 'and', conditions: [['Khu vực', '==', 'Miền Nam']] },
      sort: [{ field: 'Số tiền', direction: 'desc' }],
      limit: 200,
    },
  },
  {
    name: 'search (unaccented) + sort, limit 200',
    body: { search: 'nguyen', sort: [{ field: 'Điểm', direction: 'desc' }], limit: 200 },
  },
  {
    name: 'filter + sort, limit 200, offset 20 000',
    body: {
      filter: { logic: 'and', conditions: [['Đã thanh toán', '==', true]] },
      sort: [{ field: 'Hạn', direction: 'asc' }],
      offset: 20_000,
      limit: 200,
    },
  },
];

async function main(): Promise<void> {
  const runs = numberArgument('--runs', 50);
  const concurrency = numberArgument('--concurrency', 4);
  const config = loadConfig(process.env);
  const logger = pino({ ...rootLoggerOptions('warn'), base: { service: 'bench' } }, destination(2));
  const app = await createApp(config, { logger });
  const limits = app.get(ApiRateLimits);
  limits.perPrincipal = { limit: 1_000_000, windowSeconds: 1 };
  limits.perBase = { limit: 1_000_000, windowSeconds: 1 };
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.getHttpServer().address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  try {
    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: BENCH_EMAIL, password: BENCH_PASSWORD }),
    });
    if (login.status !== 204)
      throw new Error(`sign-in failed (${String(login.status)}); run seed:bench`);
    const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '');
    const csrf = cookies.find((cookie) => cookie.includes('csrf'))?.split('=')[1] ?? '';
    const headers = {
      'content-type': 'application/json',
      cookie: cookies.join('; '),
      'x-csrf-token': csrf,
    };

    const db = app.get<Db>(DB);
    const tableId = await findBenchTable(db);
    const url = `${origin}/api/v1/tables/${tableId}/records/query`;
    const once = async (body: object): Promise<{ ms: number; total: string }> => {
      const started = performance.now();
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const json = (await response.json()) as { total?: number; total_estimate?: number };
      const ms = performance.now() - started;
      if (response.status !== 200) throw new Error(`HTTP ${String(response.status)}`);
      const total =
        json.total === undefined ? `~${String(json.total_estimate)}` : String(json.total);
      return { ms, total };
    };

    process.stdout.write(
      `records/query bench: ${String(runs)} sequential runs + ${String(runs * 2)} at concurrency ${String(concurrency)}\n`,
    );
    for (const scenario of SCENARIOS) {
      for (let i = 0; i < 3; i += 1) await once(scenario.body); // warm-up
      const sequential: number[] = [];
      let total = '';
      for (let i = 0; i < runs; i += 1) {
        const result = await once(scenario.body);
        sequential.push(result.ms);
        total = result.total;
      }
      const parallel: number[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < runs * 2) {
            next += 1;
            parallel.push((await once(scenario.body)).ms);
          }
        }),
      );
      const fmt = (samples: number[]) =>
        [50, 95, 99].map((p) => `p${String(p)} ${percentile(samples, p).toFixed(0)} ms`).join(', ');
      process.stdout.write(
        `- ${scenario.name} (matches: ${total})\n    sequential: ${fmt(sequential)}\n    c=${String(concurrency)}:        ${fmt(parallel)}\n`,
      );
    }
  } finally {
    await app.close();
  }
}

/** The bench table of the bench owner's organization (see `seed/bench-seed.ts`). */
async function findBenchTable(db: Db): Promise<string> {
  const owner = await new UsersRepository(db).findByEmail(BENCH_EMAIL);
  if (owner === undefined) throw new Error('no bench owner; run pnpm seed:bench');
  for (const membership of await new OrganizationsRepository(db).listMembershipsOfUser(owner.id)) {
    const scope = orgScope(membership.organizationId);
    const workspaces = await new WorkspacesRepository(db).list(scope, { offset: 0, limit: 100 });
    for (const workspace of workspaces.items) {
      for (const base of await new BasesRepository(db).listByWorkspace(scope, workspace.id)) {
        const table = (await new TablesRepository(db).listByBase(scope, base.id)).find(
          (item) => item.name === BENCH_TABLE_NAME,
        );
        if (table !== undefined) return table.id;
      }
    }
  }
  throw new Error('no bench table; run pnpm seed:bench');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `bench: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
