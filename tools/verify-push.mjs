/**
 * Local gate before pushing to `main` (AGENTS.md "Workflow"): picks the checks the changed
 * files need, prints the plan, runs it and stops at the first red step. CI is unchanged.
 *
 * Usage: pnpm verify:push [--dry-run] [upstream]   (upstream defaults to origin/main)
 * Changed files = `git diff --name-only <upstream>...HEAD`, so commit before running it.
 * It also warns, without failing, about the version lines of `VERSIONED_DOCS`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
import { parseArgs } from 'node:util';

/** Root package.json scripts, in the order they run (cheap first). */
export const STEPS = [
  'lint',
  'format:check',
  'typecheck',
  'test',
  'build',
  'size',
  'test:int',
  'test:e2e',
];

const ALWAYS = new Set(['lint', 'format:check', 'typecheck', 'test']);

/**
 * A changed path matching one of `globs` adds `steps`. Globs use `path.matchesGlob`, where
 * `*` and `**` skip dotfiles, so a dotfile is listed by name.
 *
 * @type {{ steps: string[], globs: string[] }[]}
 */
export const RULES = [
  {
    // Bundle budgets (FRONTEND §11.1): the web app and every package it bundles.
    steps: ['build', 'size'],
    globs: [
      'apps/web/*',
      'apps/web/.size-limit.js',
      'apps/web/public/**',
      'apps/web/src/**',
      'packages/{ui,contracts,field-types,filter-dsl,formula-engine,markdown,permissions}/**',
    ],
  },
  {
    // The API, the worker and every package they import.
    steps: ['test:int'],
    globs: [
      'apps/{api,worker}/**',
      'packages/{server-core,permissions,filter-dsl,formula-engine,field-types,contracts,markdown}/**',
    ],
  },
  {
    // Shared semantics run the whole E2E suite, not only the related specs: auth/session,
    // realtime, share links, API tokens, permissions, secret rules, causation, rate limits,
    // shared UI (Dialog …), layout and app shell, demo seed and the E2E harness.
    steps: ['test:e2e'],
    globs: [
      // API and worker
      'apps/api/src/common/{auth,access,rate-limit}/**',
      'apps/api/src/modules/{auth,api-token,realtime,secret,share,share-link}/**',
      'apps/api/src/seed.ts',
      'apps/api/src/seed/**',
      'apps/worker/src/realtime.ts',
      'packages/server-core/src/{auth,api-tokens,realtime,share-links,secrets,events}/**',
      'packages/server-core/src/automation/causation/**',
      'packages/server-core/src/automation/dispatch/loop-guard.ts',
      'packages/server-core/src/automation/actions/*/secret-check.ts',
      'packages/server-core/src/webhooks/incoming/receive/causation.ts',
      'packages/server-core/src/db/repositories/sessions.repository.ts',
      'packages/contracts/src/{auth,realtime,api-token*,share*}.ts',
      'packages/permissions/**',
      // Web: shared UI, app shell and layout (entries, CSP of `vite preview`, global styles)
      'packages/ui/**',
      'apps/web/{index,share}.html',
      'apps/web/{vite.config,security-headers}.ts',
      'apps/web/src/{main,share-main}.tsx',
      'apps/web/src/app/**',
      'apps/web/src/styles/**',
      'apps/web/src/lib/api/{client,index}.ts',
      'apps/web/src/lib/{layout,navigation,permissions,realtime,session,share}/**',
      'apps/web/src/features/{auth,share}/**',
      // E2E harness
      'apps/web/playwright.config.ts',
      'apps/web/e2e/{fixtures,support,global-setup,seed,ports,fake-oidc}.ts',
    ],
  },
  {
    // A dependency change can break anything.
    steps: ['build', 'size', 'test:int', 'test:e2e'],
    globs: ['pnpm-lock.yaml'],
  },
];

/**
 * @param {readonly string[]} files paths changed since the upstream
 * @returns {{ step: string, files: string[] }[]} steps in run order, with the files that
 *   pulled each one in (empty for the steps that always run)
 */
export function planSteps(files) {
  /** @type {Map<string, Set<string>>} */
  const triggers = new Map();
  for (const rule of RULES) {
    const hits = files.filter((file) => rule.globs.some((glob) => matchesGlob(file, glob)));
    if (hits.length === 0) continue;
    for (const step of rule.steps) {
      const set = triggers.get(step) ?? new Set();
      for (const file of hits) set.add(file);
      triggers.set(step, set);
    }
  }
  return STEPS.filter((step) => ALWAYS.has(step) || triggers.has(step)).map((step) => ({
    step,
    files: [...(triggers.get(step) ?? [])],
  }));
}

/**
 * Docs whose line 3 is their version line (AGENTS.md "Workflow"): a change adds an entry
 * there in the same commit, and resolving a conflict on that line keeps every entry.
 */
export const VERSIONED_DOCS = ['docs/SPEC.md', 'docs/CONTRACTS.md', 'docs/FRONTEND.md'];

/**
 * An entry of a version line: `1.42 — 2026-11-08 (…)`, `Version: 1.64 (…)`, `Trước đó: 1.41
 * (…)`. Section references (`§11.1 (`, `F§4.10 (`) and `v1.7` are not entries.
 */
const VERSION_ENTRY = /(?:^|[^0-9§.v])(\d+\.\d+)(?= — \d{4}-\d{2}-\d{2}| \()/gu;

/**
 * @param {string} line a version line
 * @returns {string[]} the versions it names, once each, in order
 */
export function versionEntries(line) {
  return [...new Set([...line.matchAll(VERSION_ENTRY)].map((match) => match[1] ?? ''))];
}

/**
 * Warnings about the version lines of the changed docs; never a failure.
 *
 * @param {readonly string[]} files paths changed since the upstream
 * @param {(file: string) => { base: string | null, upstream: string | null, head: string | null }} line3
 *   line 3 of a doc at the merge base, at the upstream's tip and at HEAD (`null`: no such file)
 * @returns {string[]}
 */
export function versionLineWarnings(files, line3) {
  /** @type {string[]} */
  const warnings = [];
  for (const file of VERSIONED_DOCS) {
    if (!files.includes(file)) continue;
    const { base, upstream, head } = line3(file);
    if (head === null) continue;
    if (base !== null && base === head) {
      warnings.push(
        `${file} changed but its version line (line 3) did not: add an entry in the same commit.`,
      );
    }
    if (upstream === null) continue;
    const kept = new Set(versionEntries(head));
    const lost = versionEntries(upstream).filter((version) => !kept.has(version));
    if (lost.length > 0) {
      warnings.push(
        `${file}: line 3 lost ${lost.length === 1 ? 'the entry' : 'the entries'} ${lost.join(', ')} of the upstream: put ${lost.length === 1 ? 'it' : 'them'} back after yours.`,
      );
    }
  }
  return warnings;
}

/** Line 3 of `file` at `rev`, `null` when the file is not there. */
function lineThreeAt(/** @type {string} */ rev, /** @type {string} */ file) {
  try {
    const text = execFileSync('git', ['show', `${rev}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return text.split('\n')[2] ?? '';
  } catch {
    return null;
  }
}

/** @param {{ step: string, files: string[] }[]} plan */
function formatPlan(plan) {
  return plan
    .map(({ step, files }, index) => {
      const line = `  ${String(index + 1)}. pnpm ${step}`;
      if (files.length === 0) return line;
      const more = files.length > 3 ? ` (+${String(files.length - 3)} more)` : '';
      return `${line.padEnd(24)} ← ${files.slice(0, 3).join(', ')}${more}`;
    })
    .join('\n');
}

function main() {
  const { values, positionals } = parseArgs({
    options: { 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const upstream = positionals[0] ?? 'origin/main';
  const range = `${upstream}...HEAD`;
  let files;
  try {
    files = execFileSync('git', ['diff', '--name-only', '--no-renames', range], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file !== '');
  } catch {
    process.stderr.write(`verify:push: cannot diff ${range}; fetch it or pass another upstream.\n`);
    process.exitCode = 2;
    return;
  }

  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }) !== '') {
    process.stderr.write('verify:push: uncommitted changes are not in the plan; commit first.\n');
  }
  const plan = planSteps(files);
  process.stdout.write(
    `verify:push: ${String(files.length)} files changed in ${range}\n${formatPlan(plan)}\n`,
  );
  const base = execFileSync('git', ['merge-base', upstream, 'HEAD'], { encoding: 'utf8' }).trim();
  const warnings = versionLineWarnings(files, (file) => ({
    base: lineThreeAt(base, file),
    upstream: lineThreeAt(upstream, file),
    head: lineThreeAt('HEAD', file),
  }));
  for (const warning of warnings) process.stderr.write(`verify:push: warning: ${warning}\n`);
  if (values['dry-run']) return;

  for (const { step } of plan) {
    process.stdout.write(`\nverify:push: pnpm ${step}\n`);
    const { status } = spawnSync('pnpm', ['run', step], { stdio: 'inherit' });
    if (status !== 0) {
      process.stderr.write(`\nverify:push: pnpm ${step} failed; do not push.\n`);
      process.exitCode = status ?? 1;
      return;
    }
  }
  process.stdout.write(`\nverify:push: all ${String(plan.length)} steps green.\n`);
}

if (import.meta.main) main();
