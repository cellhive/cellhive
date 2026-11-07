import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Id } from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import {
  startFakeOpenAiServer,
  type FakeOpenAiReply,
  type FakeOpenAiServer,
} from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { expect, inject } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { DEMO_BASE, DEMO_ORG, DEMO_PASSWORD, DEMO_USERS } from '../../src/seed/demo-fixture.js';
import { runSeed } from '../../src/seed/run.js';
import { Browser } from '../int/auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from '../int/database.js';
import {
  startTestApp,
  TEST_PUBLIC_URL,
  TEST_SESSION_SECRET,
  type TestApp,
} from '../int/support.js';

import { percentile, slugOf } from './scoring.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * The harness of the manual AI eval (BACKLOG T917; how to run it:
 * `test/ai-eval/README.md`). Never in CI: `S8_AI_EVAL=1` turns it on, and
 * it calls the provider of `S8_AI_BASE_URL` for real — or, with
 * `S8_AI_BASE_URL=fake`, an in-process fake provider that answers each case
 * with its scripted replies (correct, wrong or needing a repair), which
 * checks the kit itself end to end.
 *
 * Every suite runs on the demo data of `pnpm seed:demo` (CONTRACTS §9,
 * smaller tables) seeded into a fresh database with `DEMO_AI_*` pointing at
 * the provider (AI on, the allowlist entry of an internal host), then the
 * suite's settings (structured output, 120 s timeout, no daily limit, record
 * data on only where the feature needs it) and "Test connection". Each case
 * goes through the real route as the demo admin; per case the harness
 * records the verdict, the wall time, the tries (`ai.requested.attempts`:
 * 1 + repair rounds) and the tokens of the `ai.requested` audit entries.
 */

const env = process.env;

export const AI_EVAL = {
  on: env['S8_AI_EVAL'] === '1',
  fake: env['S8_AI_BASE_URL'] === 'fake',
  baseUrl: env['S8_AI_BASE_URL'] ?? '',
  model: env['S8_AI_MODEL'] ?? 'fake-model',
  apiKey: env['S8_AI_API_KEY'] === '' ? undefined : env['S8_AI_API_KEY'],
  output: env['S8_AI_OUTPUT'] ?? 'auto',
  /** Below this many passes out of 20 the suite fails (BACKLOG T917: 12, hosted 16). */
  passMark: Number(env['S8_AI_PASS_MARK'] ?? 12),
  /** A directory: one JSON report per suite and model. */
  report: env['S8_AI_REPORT'],
  /** Free text copied into the report (BACKLOG T917: name, quantization, hardware). */
  quantization: env['S8_AI_QUANT'] ?? null,
  hardware: env['S8_AI_HARDWARE'] ?? null,
} as const;

/** One minute per case is not enough for a slow local model: 20 cases may take half an hour. */
export const SUITE_TIMEOUT_MS = 60 * 60_000;
export const SETUP_TIMEOUT_MS = 300_000;

/** Smaller than CONTRACTS §9 (a fast seed), enough groups for every question. */
const TABLE_COUNTS = { customers: 40, tickets: 120, orders: 300 } as const;

export type DemoUser = 'u_admin' | 'u_sales1';

export interface EvalStack {
  readonly t: TestApp;
  readonly db: Db;
  /** The in-process provider of a validation run (`S8_AI_BASE_URL=fake`). */
  readonly fake: FakeOpenAiServer | null;
  readonly orgId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  /** Output rung found by "Test connection". */
  readonly rung: string | null;
  table(name: string): Id<'tbl'>;
  field(table: string, name: string): Id<'fld'>;
  option(table: string, field: string, name: string): string;
  view(table: string, name: string): Id<'viw'>;
  secret(name: string): Id<'sec'>;
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    user?: DemoUser,
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/** Seeds the demo data with `DEMO_AI_*` and starts the API on it. */
export async function startEval(options: {
  readonly suite: string;
  /** `allow_record_data` (automation drafts with AI steps). */
  readonly recordData: boolean;
}): Promise<EvalStack> {
  const fake = AI_EVAL.fake ? await startFakeOpenAiServer() : null;
  const baseUrl = fake?.baseUrl ?? AI_EVAL.baseUrl;
  if (baseUrl === '')
    throw new Error('Set S8_AI_BASE_URL (or S8_AI_BASE_URL=fake) and S8_AI_MODEL.');
  const database: TestDatabase = await createMigratedDatabase();
  const db = createTestDb(database.url);
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-ai-eval-'));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSeed(
    [],
    {
      NODE_ENV: 'development',
      PUBLIC_URL: TEST_PUBLIC_URL,
      DATABASE_URL: database.url,
      CACHE_URL: `${inject('cacheUrl')}/7`,
      // The test app's key: the AI key secret is sealed with it.
      APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: TEST_SESSION_SECRET,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storage,
      LOG_LEVEL: 'warn',
      DEMO_AI_BASE_URL: baseUrl,
      DEMO_AI_MODEL: AI_EVAL.model,
      ...(AI_EVAL.apiKey === undefined ? {} : { DEMO_AI_API_KEY: AI_EVAL.apiKey }),
    },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { tableCounts: TABLE_COUNTS },
  );
  if (code !== 0) throw new Error(`seed:demo failed:\n${err.join('\n')}`);
  const host = new URL(baseUrl).hostname;
  // `localhost` → 127.0.0.1, where Ollama, llama.cpp and the fake provider listen (not `::1`).
  const t = await startTestApp(
    { DATABASE_URL: database.url },
    host === 'localhost' ? { outboundLookup: () => Promise.resolve(['127.0.0.1']) } : {},
  );
  t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };

  const browsers = new Map<DemoUser, Browser>();
  const browserOf = async (user: DemoUser): Promise<Browser> => {
    let browser = browsers.get(user);
    if (browser === undefined) {
      const email = DEMO_USERS.find((item) => item.key === user)?.email ?? '';
      browser = new Browser(t.app);
      const signedIn = await browser.login(email, DEMO_PASSWORD);
      if (signedIn.statusCode !== 204) throw new Error(`cannot sign in as ${user}`);
      browsers.set(user, browser);
    }
    return browser;
  };
  const call: EvalStack['call'] = async (method, path, body, user = 'u_admin') =>
    (await browserOf(user)).request({
      method,
      url: `/api/v1${path}`,
      ...(body === undefined ? {} : { payload: body as object }),
    });

  // The demo ids by name.
  const org = await db.kysely
    .selectFrom('meta.organizations')
    .select('id')
    .where('name', '=', DEMO_ORG.name)
    .executeTakeFirstOrThrow();
  const base = await db.kysely
    .selectFrom('meta.bases')
    .select('id')
    .where('organization_id', '=', org.id)
    .where('name', '=', DEMO_BASE.name)
    .executeTakeFirstOrThrow();
  const tables = await db.kysely
    .selectFrom('meta.tables')
    .select(['id', 'name'])
    .where('base_id', '=', base.id)
    .where('deleted_at', 'is', null)
    .execute();
  const fields = await db.kysely
    .selectFrom('meta.fields')
    .select(['id', 'name', 'table_id', 'options'])
    .where(
      'table_id',
      'in',
      tables.map((table) => table.id),
    )
    .where('deleted_at', 'is', null)
    .execute();
  const views = await db.kysely
    .selectFrom('meta.views')
    .select(['id', 'name', 'table_id'])
    .where(
      'table_id',
      'in',
      tables.map((table) => table.id),
    )
    .execute();
  const secrets = await db.kysely
    .selectFrom('meta.secrets')
    .select(['id', 'name'])
    .where('organization_id', '=', org.id)
    .execute();
  const found = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`the demo data has no ${what}`);
    return value;
  };
  const table: EvalStack['table'] = (name) =>
    found(tables.find((item) => item.name === name)?.id, `table ${name}`);
  const fieldRow = (tableName: string, name: string) =>
    found(
      fields.find((item) => item.table_id === table(tableName) && item.name === name),
      `field ${tableName}.${name}`,
    );

  const stack: EvalStack = {
    t,
    db,
    fake,
    orgId: org.id,
    baseId: base.id,
    rung: null,
    table,
    field: (tableName, name) => fieldRow(tableName, name).id,
    option: (tableName, field, name) =>
      found(
        (
          fieldRow(tableName, field).options as { options?: { id: string; name: string }[] }
        ).options?.find((item) => item.name === name)?.id,
        `option ${field} = ${name}`,
      ),
    view: (tableName, name) =>
      found(
        views.find((item) => item.table_id === table(tableName) && item.name === name)?.id,
        `view ${name}`,
      ),
    secret: (name) => found(secrets.find((item) => item.name === name)?.id, `secret ${name}`),
    call,
    close: async () => {
      await t.close();
      await fake?.close();
      await db.destroy();
      await database.drop();
      await rm(storage, { recursive: true, force: true });
    },
  };

  const saved = await call('PUT', `/orgs/${org.id}/ai-settings`, {
    structured_output: AI_EVAL.output,
    request_timeout_seconds: 120,
    daily_token_limit: null,
    ...(options.recordData ? { allow_record_data: true, confirm: true } : {}),
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const tested = await call('POST', `/orgs/${org.id}/ai-settings/test`, {});
  expect(tested.statusCode, tested.body).toBe(200);
  const probe = tested.json<{
    ok: boolean;
    structured_output: string | null;
    latency_ms: number;
    error: unknown;
  }>();
  process.stdout.write(
    `\n[${options.suite}] ${host} · ${AI_EVAL.model} · Test connection: ` +
      `${probe.ok ? 'ok' : 'FAILED'}, rung ${String(probe.structured_output)}, ` +
      `${String(probe.latency_ms)} ms${probe.ok ? '' : ` ${JSON.stringify(probe.error)}`}\n`,
  );
  if (!probe.ok) throw new Error('"Test connection" failed: check the URL, the model and the key.');
  return { ...stack, rung: probe.structured_output };
}

/** One case of a suite. */
export interface EvalCase {
  /** The sentence, question or description typed by the user. */
  readonly prompt: string;
  /** The fake provider's answers in a validation run (one per call, repairs included). */
  readonly fake: readonly FakeOpenAiReply[];
  /** Whether those answers must score as a pass (default `true`). */
  readonly fakePasses?: boolean;
}

export interface CaseResult {
  readonly index: number;
  readonly prompt: string;
  readonly pass: boolean;
  readonly status: number;
  readonly code: string | null;
  readonly ms: number;
  /** Tries of the feature's call (1 + repair rounds), from `ai.requested`. */
  readonly tries: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly note: string | null;
}

export interface SuiteSummary {
  readonly suite: string;
  readonly passed: number;
  readonly total: number;
  readonly repairRounds: number;
  readonly casesRepaired: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Validation runs only: cases whose provider calls differ from their scripted replies. */
  readonly scriptMismatches: readonly number[];
  readonly results: readonly CaseResult[];
}

interface AuditRow {
  readonly after: {
    readonly attempts?: number;
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/**
 * Runs every case: scripts the fake provider (validation run), sends the
 * request, scores the answer with `check` (an exception counts as a fail),
 * reads the case's `ai.requested` entries; prints the table and writes the
 * JSON report.
 */
export async function runSuite<C extends EvalCase>(
  stack: EvalStack,
  suite: string,
  cases: readonly C[],
  send: (item: C) => Promise<LightMyRequestResponse>,
  check: (item: C, response: LightMyRequestResponse) => Promise<boolean> | boolean,
): Promise<SuiteSummary> {
  const results: CaseResult[] = [];
  const scriptMismatches: number[] = [];
  for (const [index, item] of cases.entries()) {
    const chatsBefore = stack.fake?.chatRequests().length ?? 0;
    if (stack.fake !== null) stack.fake.script(...item.fake);
    const since = (
      await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(stack.db.kysely)
    ).rows[0]?.now;
    const started = performance.now();
    const response = await send(item);
    const ms = Math.round(performance.now() - started);
    let pass = false;
    let note: string | null = null;
    try {
      pass = response.statusCode === 200 && (await check(item, response));
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    const audits = (
      await sql<AuditRow>`
        SELECT after FROM meta.audit_logs
         WHERE organization_id = ${stack.orgId} AND action = 'ai.requested'
           AND created_at >= ${since ?? new Date(0)}`.execute(stack.db.kysely)
    ).rows;
    if (
      stack.fake !== null &&
      stack.fake.chatRequests().length - chatsBefore !== item.fake.length
    ) {
      scriptMismatches.push(index + 1);
    }
    const sum = (key: 'prompt_tokens' | 'completion_tokens') =>
      audits.reduce((total, row) => total + (row.after[key] ?? 0), 0);
    let code: string | null = null;
    if (response.statusCode !== 200) {
      try {
        code = response.json<{ code?: string }>().code ?? null;
      } catch {
        code = null;
      }
    }
    results.push({
      index: index + 1,
      prompt: item.prompt,
      pass,
      status: response.statusCode,
      code,
      ms,
      tries: audits.reduce((total, row) => total + (row.after.attempts ?? 1), 0),
      promptTokens: sum('prompt_tokens'),
      completionTokens: sum('completion_tokens'),
      note: pass ? null : (note ?? response.body.slice(0, 1500)),
    });
  }
  const times = results.map((result) => result.ms);
  const summary: SuiteSummary = {
    suite,
    passed: results.filter((result) => result.pass).length,
    total: results.length,
    repairRounds: results.reduce((total, result) => total + Math.max(0, result.tries - 1), 0),
    casesRepaired: results.filter((result) => result.tries > 1).length,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    promptTokens: results.reduce((total, result) => total + result.promptTokens, 0),
    completionTokens: results.reduce((total, result) => total + result.completionTokens, 0),
    scriptMismatches,
    results,
  };
  await report(stack, summary);
  return summary;
}

const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);

async function report(stack: EvalStack, summary: SuiteSummary): Promise<void> {
  const lines = [
    '',
    `AI eval — ${summary.suite} — ${AI_EVAL.fake ? 'fake provider (validation)' : AI_EVAL.model}` +
      ` — rung ${String(stack.rung)}`,
    `  passed ${String(summary.passed)}/${String(summary.total)}` +
      ` · repair rounds ${String(summary.repairRounds)} (${String(summary.casesRepaired)} cases)` +
      ` · latency p50 ${seconds(summary.p50Ms)}, p95 ${seconds(summary.p95Ms)}` +
      ` · tokens ${String(summary.promptTokens)} prompt + ${String(summary.completionTokens)} completion`,
    ...summary.results.map(
      (result) =>
        `${result.pass ? 'PASS' : 'FAIL'} #${String(result.index).padStart(2)} ` +
        `${seconds(result.ms).padStart(7)} ${String(result.tries)} tr  ${result.prompt}` +
        (result.pass ? '' : `\n     ${String(result.status)} ${result.note ?? ''}`),
    ),
    '',
  ];
  process.stdout.write(lines.join('\n'));
  if (AI_EVAL.report === undefined || AI_EVAL.report === '') return;
  await mkdir(AI_EVAL.report, { recursive: true });
  const name = `${slugOf(summary.suite)}-${slugOf(AI_EVAL.fake ? 'fake' : AI_EVAL.model)}.json`;
  await writeFile(
    join(AI_EVAL.report, name),
    `${JSON.stringify(
      {
        ...summary,
        model: AI_EVAL.fake ? 'fake' : AI_EVAL.model,
        host: AI_EVAL.fake ? 'localhost' : new URL(AI_EVAL.baseUrl).host,
        structured_output: AI_EVAL.output,
        rung: stack.rung,
        quantization: AI_EVAL.quantization,
        hardware: AI_EVAL.hardware,
        at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/** The verdict of a suite: a validation run scores exactly its script, a real run the pass mark. */
export function expectVerdict(summary: SuiteSummary, cases: readonly EvalCase[]): void {
  if (AI_EVAL.fake) {
    expect(summary.scriptMismatches, 'cases whose calls differ from their script').toEqual([]);
    expect(summary.results.filter((result) => !result.pass).map((result) => result.index)).toEqual(
      cases.flatMap((item, index) => (item.fakePasses === false ? [index + 1] : [])),
    );
    // Every scripted reply after the first of a case is a repair round.
    expect(summary.repairRounds).toBe(
      cases.reduce((total, item) => total + Math.max(0, item.fake.length - 1), 0),
    );
    return;
  }
  expect(summary.passed).toBeGreaterThanOrEqual(AI_EVAL.passMark);
}
