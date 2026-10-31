import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import {
  PERF_ATTACHMENT,
  PERF_PROFILE,
  withinBudget,
  type PerfAttachment,
  type PerfMetric,
  type PerfProfile,
} from './perf-results';

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

/**
 * Playwright reporter of `pnpm test:e2e:perf` (BACKLOG T801): writes the numbers
 * the `@perf` specs record (`perf-results.ts`) and the machine they ran on to
 * `perf-results.json` (`E2E_PERF_RESULTS` overrides the path, relative to
 * `apps/web`), and appends a Markdown table to `$GITHUB_STEP_SUMMARY` when
 * set (the nightly `perf` workflow), with the bounds of both budget profiles
 * (`ci-runner`, `product`; the active one is asserted and decides the bold).
 */

interface PerfTestResult {
  file: string;
  title: string;
  status: TestResult['status'];
  retry: number;
  /** 0-based run of `--repeat-each` (`perf.yml` input `repeat`): one entry per run. */
  repeat_index: number;
  duration_ms: number;
  metrics: Record<string, PerfMetric>;
  details?: unknown;
  error?: string;
}

const FIRST_LINE = /^[^\n]*/u;

export default class PerfReporter implements Reporter {
  private readonly tests: PerfTestResult[] = [];
  private browser: string | null = null;
  private rootDir = process.cwd();
  private readonly startedAt = new Date();

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const metrics: Record<string, PerfMetric> = {};
    const details: unknown[] = [];
    for (const attachment of result.attachments) {
      if (attachment.name !== PERF_ATTACHMENT || attachment.body === undefined) continue;
      const body = JSON.parse(attachment.body.toString('utf8')) as PerfAttachment;
      this.browser = body.browser;
      Object.assign(metrics, body.metrics);
      if (body.details !== undefined) details.push(body.details);
    }
    const message = result.error?.message;
    const error = message === undefined ? undefined : stripVTControlCharacters(message);
    this.tests.push({
      file: path.relative(this.rootDir, test.location.file),
      title: test.titlePath().slice(3).join(' › ') || test.title,
      status: result.status,
      retry: result.retry,
      repeat_index: test.repeatEachIndex,
      duration_ms: Math.round(result.duration),
      metrics,
      ...(details.length === 0 ? {} : { details: details.length === 1 ? details[0] : details }),
      ...(error === undefined ? {} : { error: FIRST_LINE.exec(error)?.[0] ?? error }),
    });
  }

  onEnd(result: FullResult): void {
    const out = path.resolve(process.env['E2E_PERF_RESULTS'] ?? 'perf-results.json');
    const machine: Machine = {
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpus: os.availableParallelism(),
      ...cpuInfo(),
      memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
      browser: this.browser,
      runner: process.env['RUNNER_NAME'] ?? null,
      runner_image:
        process.env['ImageOS'] === undefined
          ? null
          : `${process.env['ImageOS']} ${process.env['ImageVersion'] ?? ''}`.trim(),
    };
    const report = {
      status: result.status,
      started_at: this.startedAt.toISOString(),
      duration_ms: Math.round(result.duration),
      commit: process.env['GITHUB_SHA'] ?? null,
      profile: PERF_PROFILE,
      machine,
      repeat: Math.max(1, ...this.tests.map((test) => test.repeat_index + 1)),
      tests: this.tests,
    };
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`[perf] results written to ${out}\n`);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '') appendFileSync(summary, markdown(report));
  }

  printsToStdio(): boolean {
    return false;
  }
}

interface CpuInfo {
  /** Model name (`/proc/cpuinfo` `model name`, else Node's `os.cpus()`). */
  cpu_model: string | null;
  /** Family to tell runners apart at a glance: `AMD EPYC`, `Intel Xeon`, `Apple M4`… */
  cpu_family: string | null;
  /** Physical cores (`/proc/cpuinfo` core ids, `sysctl hw.physicalcpu` on macOS). */
  cpu_cores: number | null;
  /** Logical CPUs (threads) the OS reports. */
  cpu_threads: number;
}

const CPU_FAMILIES: readonly RegExp[] = [
  /AMD EPYC/u,
  /AMD Ryzen/u,
  /Intel\(R\) Xeon\(R\)|Intel Xeon/u,
  /Intel\(R\) Core\(TM\)|Intel Core/u,
  /Apple M\d+/u,
];

/** `Intel(R) Xeon(R) …` → `Intel Xeon`; unknown models → null. */
function cpuFamily(model: string | null): string | null {
  if (model === null) return null;
  for (const family of CPU_FAMILIES) {
    const match = family.exec(model);
    if (match !== null) return match[0].replace(/\(R\)|\(TM\)/gu, '');
  }
  return null;
}

/**
 * The runner's CPU, so that runs on different hosted-runner hardware (AMD EPYC
 * 7763 vs Intel Xeon 6973P-C, 1.3–1.4× apart on first data, BACKLOG T818) are
 * never compared as if they were the same machine.
 */
function cpuInfo(): CpuInfo {
  const threads = os.cpus().length;
  let model = os.cpus()[0]?.model.trim() ?? null;
  let cores: number | null = null;
  try {
    if (os.platform() === 'linux') {
      const text = readFileSync('/proc/cpuinfo', 'utf8');
      model = /^model name\s*:\s*(.+)$/mu.exec(text)?.[1]?.trim() ?? model;
      const ids = new Set<string>();
      for (const block of text.split(/\n\s*\n/u)) {
        const physical = /^physical id\s*:\s*(\d+)/mu.exec(block)?.[1];
        const core = /^core id\s*:\s*(\d+)/mu.exec(block)?.[1];
        if (core !== undefined) ids.add(`${physical ?? '0'}:${core}`);
      }
      cores = ids.size === 0 ? null : ids.size;
    } else if (os.platform() === 'darwin') {
      cores = Number(execFileSync('sysctl', ['-n', 'hw.physicalcpu'], { encoding: 'utf8' }));
    }
  } catch {
    // Machine info is best effort: the numbers matter more.
  }
  return {
    cpu_model: model,
    cpu_family: cpuFamily(model),
    cpu_cores: cores !== null && Number.isFinite(cores) ? cores : null,
    cpu_threads: threads,
  };
}

interface Machine extends CpuInfo {
  platform: string;
  arch: string;
  cpus: number;
  memory_gb: number;
  node: string;
  browser: string | null;
  runner: string | null;
  runner_image: string | null;
}

const PROFILES: readonly PerfProfile[] = ['ci-runner', 'product'];

/** `< 1500 ms` / `≤ 1750 ms` / `record only` (FRONTEND §11.1). */
function bound(metric: PerfMetric, profile: PerfProfile): string {
  const value = metric.budgets?.[profile];
  if (value === undefined) return '';
  if (value === null) return 'record only';
  return `${profile === 'product' ? '<' : '≤'} ${String(value)} ${metric.unit}`;
}

function markdown(report: {
  status: string;
  commit: string | null;
  profile: PerfProfile;
  machine: Machine;
  repeat: number;
  tests: readonly PerfTestResult[];
}): string {
  const m = report.machine;
  const cores = m.cpu_cores === null ? '?' : String(m.cpu_cores);
  const runs = report.repeat > 1;
  const lines = [
    `## Perf (\`@perf\`, FRONTEND §11.1): ${report.status} · profile \`${report.profile}\``,
    '',
    `**CPU: ${m.cpu_family ?? 'unknown family'}** — ${m.cpu_model ?? '?'} · ${cores} cores / ${String(m.cpu_threads)} threads (${String(m.cpus)} usable)`,
    '',
    `Commit \`${report.commit ?? 'local'}\` · ${String(m.memory_gb)} GB RAM · ${m.platform} ${m.arch} · ${m.runner_image ?? 'no runner image'} · Chromium ${m.browser ?? '?'}${runs ? ` · ${String(report.repeat)} runs per test` : ''}`,
    '',
    `Bold: over the asserted \`${report.profile}\` budget. Runner bounds are regression gates of this 2-core runner; product bounds are the user-facing targets.`,
    '',
    `| Spec | Test |${runs ? ' Run |' : ''} Metric | Value | ${PROFILES.map((profile) => `Budget \`${profile}\`${profile === report.profile ? ' (asserted)' : ''}`).join(' | ')} | Test status |`,
    `|---|---|${runs ? '---:|' : ''}---|---:|---:|---:|---|`,
  ];
  for (const test of report.tests) {
    const entries = Object.entries(test.metrics);
    const status = test.retry === 0 ? test.status : `${test.status} (retry ${String(test.retry)})`;
    const run = runs ? ` ${String(test.repeat_index + 1)} |` : '';
    if (entries.length === 0) {
      lines.push(`| ${test.file} | ${test.title} |${run} — | — | — | — | ${status} |`);
      continue;
    }
    for (const [name, metric] of entries) {
      const over =
        metric.budget !== undefined && !withinBudget(metric.value, metric.budget, report.profile);
      const value = `${String(metric.value)} ${metric.unit}`;
      const budgets = PROFILES.map((profile) => bound(metric, profile)).join(' | ');
      lines.push(
        `| ${test.file} | ${test.title} |${run} ${name} | ${over ? `**${value}**` : value} | ${budgets} | ${status} |`,
      );
    }
  }
  return `${lines.join('\n')}\n\n`;
}
