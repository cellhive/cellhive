/**
 * Bench of `GET /api/v1/tables/:id/export` over real HTTP (BACKLOG T307:
 * 200 000 records × 30 fields; CSV first byte < 2 s, done < 60 s, API RSS
 * growth < 150 MB; XLSX done < 180 s) on the `pnpm seed:bench` data. Starts
 * the API in-process on a random local port, signs in as the bench owner
 * and, per scenario, reports time to first byte, total time, size, peak RSS
 * growth of the process (from a baseline taken after a full GC: the script
 * runs with `--expose-gc`; without it the first run also counts the heap
 * left over from startup, +364 MiB instead of +132 MiB in T319) and the
 * longest event-loop block. Finally checks that a client going away
 * mid-export stops the reads. Development only:
 *
 *   pnpm seed:bench && pnpm --filter @cellhive/api bench:export
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

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
import { sql } from 'kysely';
import { destination, pino } from 'pino';

import { createApp } from '../src/app.factory.js';
import { rootLoggerOptions } from '../src/common/logging/root-logger.js';
import { ApiRateLimits } from '../src/common/rate-limit/api-rate-limits.js';
import { DB } from '../src/common/tokens.js';
import { BENCH_EMAIL, BENCH_PASSWORD } from '../src/seed/bench-seed.js';
import { BENCH_TABLE_NAME } from '../src/seed/bench-table.js';

import type { AddressInfo } from 'node:net';

const MB = 1024 * 1024;

interface Measure {
  readonly firstByteMs: number;
  readonly totalMs: number;
  readonly bytes: number;
  readonly rssGrowthMb: number;
  readonly maxBlockMs: number;
  readonly p99BlockMs: number;
}

async function measure(url: string, headers: Record<string, string>): Promise<Measure> {
  globalThis.gc?.();
  await sleep(200);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const started = performance.now();
  let firstByteMs = 0;
  let bytes = 0;
  try {
    const response = await fetch(url, { headers });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`HTTP ${String(response.status)}: ${await response.text()}`);
    }
    for await (const chunk of response.body) {
      if (bytes === 0) firstByteMs = performance.now() - started;
      bytes += (chunk as Uint8Array).byteLength;
    }
  } finally {
    clearInterval(sampler);
    loop.disable();
  }
  return {
    firstByteMs,
    totalMs: performance.now() - started,
    bytes,
    rssGrowthMb: (peak - baseline) / MB,
    maxBlockMs: loop.max / 1e6,
    p99BlockMs: loop.percentile(99) / 1e6,
  };
}

async function main(): Promise<void> {
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
    if (login.status !== 204) throw new Error(`sign-in failed (${String(login.status)})`);
    const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '');
    const csrf = cookies.find((cookie) => cookie.includes('csrf'))?.split('=')[1] ?? '';
    const headers = { cookie: cookies.join('; '), 'x-csrf-token': csrf };
    const db = app.get<Db>(DB);
    const tableId = await findBenchTable(db);

    // A view sorted on two fields (text, then number desc): every batch sorts.
    const fields = (await (
      await fetch(`${origin}/api/v1/tables/${tableId}/fields?limit=100`, { headers })
    ).json()) as { items: { id: string; name: string; type: string }[] };
    const byType = (type: string) => fields.items.find((field) => field.type === type)?.id;
    const created = await fetch(`${origin}/api/v1/tables/${tableId}/views`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `Bench export ${String(Date.now())}`,
        type: 'grid',
        is_personal: true,
        config: {
          sort: [
            { field: fields.items.find((f) => f.type === 'select')?.id, direction: 'asc' },
            { field: byType('number'), direction: 'desc' },
          ],
        },
      }),
    });
    if (created.status !== 201) throw new Error(`view: HTTP ${String(created.status)}`);
    const viewId = ((await created.json()) as { id: string }).id;

    const url = (query: string) => `${origin}/api/v1/tables/${tableId}/export?${query}`;
    const scenarios: [string, string][] = [
      ['CSV, whole table (__auto)', 'format=csv'],
      ['XLSX, whole table (__auto)', 'format=xlsx'],
      ['CSV, view sorted by select + number', `format=csv&view_id=${viewId}`],
      // Again, once the process is warm (the first run also pays JIT, pools, caches).
      ['CSV, whole table (__auto), warm', 'format=csv'],
      ['XLSX, whole table (__auto), warm', 'format=xlsx'],
    ];
    process.stdout.write('table export bench (200k × 30 unless seeded otherwise)\n');
    for (const [name, query] of scenarios) {
      const m = await measure(url(query), headers);
      process.stdout.write(
        `- ${name}: first byte ${m.firstByteMs.toFixed(0)} ms, done ${(m.totalMs / 1000).toFixed(1)} s, ` +
          `${(m.bytes / MB).toFixed(1)} MiB, RSS +${m.rssGrowthMb.toFixed(0)} MiB, ` +
          `event loop max ${m.maxBlockMs.toFixed(0)} ms (p99 ${m.p99BlockMs.toFixed(0)} ms)\n`,
      );
    }

    // A client that goes away: the export stops and the user's slot frees.
    const abort = new AbortController();
    const response = await fetch(url('format=csv'), { headers, signal: abort.signal });
    const reader = response.body?.getReader();
    let received = 0;
    while (received < 2 * MB) {
      const part = await reader?.read();
      if (part === undefined || part.done) break;
      received += (part.value as Uint8Array).byteLength;
    }
    abort.abort();
    await sleep(500);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE application_name LIKE 'cellhive-stream:%' AND state = 'active'
    `.execute(db.kysely);
    const again = await fetch(url('format=csv'), { headers });
    await again.body?.cancel();
    process.stdout.write(
      `- disconnect after ${(received / MB).toFixed(1)} MiB: active stream statements after 0.5 s = ` +
        `${rows[0]?.n ?? '?'}, next export → HTTP ${String(again.status)}\n`,
    );
    await fetch(`${origin}/api/v1/views/${viewId}`, {
      method: 'DELETE',
      headers,
    });
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
