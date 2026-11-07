import { execFileSync } from 'node:child_process';
import { matchesGlob, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { planSteps, RULES, versionEntries, versionLineWarnings } from '../../verify-push.mjs';

const ALWAYS = ['lint', 'format:check', 'typecheck', 'test'];

describe('planSteps', () => {
  const cases: { title: string; files: string[]; extra: string[] }[] = [
    { title: 'empty diff', files: [], extra: [] },
    { title: 'docs only', files: ['docs/SPEC.md', 'AGENTS.md'], extra: [] },
    {
      title: 'this tool and the root scripts',
      files: ['tools/verify-push.mjs', 'tools/ci/test/verify-push.test.ts', 'package.json'],
      extra: [],
    },
    {
      title: 'a web feature',
      files: ['apps/web/src/features/grid/GridView.tsx'],
      extra: ['build', 'size'],
    },
    { title: 'the bundle budgets', files: ['apps/web/.size-limit.js'], extra: ['build', 'size'] },
    { title: 'one E2E spec', files: ['apps/web/e2e/t819-s7-qa.spec.ts'], extra: [] },
    { title: 'the E2E fixtures', files: ['apps/web/e2e/fixtures.ts'], extra: ['test:e2e'] },
    {
      title: 'an API module',
      files: ['apps/api/src/modules/record/record.service.ts'],
      extra: ['test:int'],
    },
    {
      title: 'a worker task',
      files: ['apps/worker/src/tasks/audit-export.ts'],
      extra: ['test:int'],
    },
    {
      title: 'server-core records',
      files: ['packages/server-core/src/records/dashboard-aggregate/aggregate.ts'],
      extra: ['test:int'],
    },
    {
      title: 'contracts',
      files: ['packages/contracts/src/records.ts'],
      extra: ['build', 'size', 'test:int'],
    },
    {
      title: 'formula engine (bundled and on the server)',
      files: ['packages/formula-engine/src/catalogue/text.ts'],
      extra: ['build', 'size', 'test:int'],
    },
    {
      title: 'session semantics',
      files: ['apps/api/src/common/auth/session.service.ts'],
      extra: ['test:int', 'test:e2e'],
    },
    {
      title: 'secret host rule',
      files: ['packages/server-core/src/secrets/allowed-hosts.ts'],
      extra: ['test:int', 'test:e2e'],
    },
    {
      title: 'secret check of an automation action',
      files: ['packages/server-core/src/automation/actions/send-telegram/secret-check.ts'],
      extra: ['test:int', 'test:e2e'],
    },
    {
      title: 'causation',
      files: ['packages/server-core/src/automation/causation/token.ts'],
      extra: ['test:int', 'test:e2e'],
    },
    {
      title: 'automation dispatch outside the loop guard',
      files: ['packages/server-core/src/automation/dispatch/dispatcher.ts'],
      extra: ['test:int'],
    },
    {
      title: 'realtime contract',
      files: ['packages/contracts/src/realtime.ts'],
      extra: ['build', 'size', 'test:int', 'test:e2e'],
    },
    {
      title: 'CSP of vite preview',
      files: ['apps/web/security-headers.ts'],
      extra: ['build', 'size', 'test:e2e'],
    },
    {
      title: 'a feature API module (not the shared client)',
      files: ['apps/web/src/lib/api/dashboards.ts'],
      extra: ['build', 'size'],
    },
    {
      title: 'shared Dialog',
      files: ['packages/ui/src/components/dialog.tsx'],
      extra: ['build', 'size', 'test:e2e'],
    },
    {
      title: 'app shell',
      files: ['apps/web/src/app/layouts/AppShell.tsx'],
      extra: ['build', 'size', 'test:e2e'],
    },
    {
      title: 'realtime client',
      files: ['apps/web/src/lib/realtime/socket.ts'],
      extra: ['build', 'size', 'test:e2e'],
    },
    {
      title: 'permissions package',
      files: ['packages/permissions/src/access.ts'],
      extra: ['build', 'size', 'test:int', 'test:e2e'],
    },
    {
      title: 'lockfile',
      files: ['pnpm-lock.yaml'],
      extra: ['build', 'size', 'test:int', 'test:e2e'],
    },
    {
      title: 'mixed diff keeps the run order',
      files: [
        'apps/api/src/modules/share/share.service.ts',
        'docs/FRONTEND.md',
        'apps/web/src/a.ts',
      ],
      extra: ['build', 'size', 'test:int', 'test:e2e'],
    },
  ];

  it.each(cases)('$title', ({ files, extra }) => {
    expect(planSteps(files).map(({ step }) => step)).toEqual([...ALWAYS, ...extra]);
  });

  it('names the files that pulled each step in', () => {
    const plan = planSteps(['docs/SPEC.md', 'apps/api/src/main.ts', 'apps/worker/src/main.ts']);
    expect(plan.find(({ step }) => step === 'test:int')?.files).toEqual([
      'apps/api/src/main.ts',
      'apps/worker/src/main.ts',
    ]);
    expect(plan.find(({ step }) => step === 'lint')?.files).toEqual([]);
  });
});

describe('versionEntries', () => {
  it.each([
    {
      title: 'FRONTEND / CONTRACTS style',
      line: 'Version 1.42 — 2026-11-08 (T1000 — §11.1 trần 150 KB). Trước đó 1.41 — 2026-11-07 (T1002 — §4.10, C§1.4). Trước đó: 1.4 — 2026-09-28 (T468: F§4.8); 1.3 — 2026-09-28 (T466).',
      entries: ['1.42', '1.41', '1.4', '1.3'],
    },
    {
      title: 'SPEC style (no dates on the newer entries)',
      line: 'Version: 1.64 (T919 — §22 dòng S8). 1.63 (T911 — §11.4). Trước đó 1.49 (T819). Trước đó 1.47 — 2026-10-24 (T721).',
      entries: ['1.64', '1.63', '1.49', '1.47'],
    },
    {
      title: 'section references and versions of other docs are not entries',
      line: 'Version 2.23 — 2026-11-07 (T1002 — §29.5 (key), F§11.1 (size), đi kèm SPEC v1.7 (xem)).',
      entries: ['2.23'],
    },
    {
      title: 'an entry named twice counts once',
      line: 'Version 1.42 — 2026-11-08 (T1000). Trước đó 1.41 — 2026-11-07 (T1002). Version 1.41 — 2026-11-07 (T1002).',
      entries: ['1.42', '1.41'],
    },
  ])('$title', ({ line, entries }) => {
    expect(versionEntries(line)).toEqual(entries);
  });
});

describe('versionLineWarnings', () => {
  const OLD =
    'Version 1.41 — 2026-11-07 (T1002 — §4.10). Trước đó 1.40 — 2026-11-07 (T919 — §11.2).';
  const NEW = `Version 1.42 — 2026-11-08 (T1000 — §11.1). Trước đó ${OLD.slice('Version '.length)}`;
  type Lines = { base: string | null; upstream: string | null; head: string | null };
  const same = (line: string): Lines => ({ base: line, upstream: line, head: line });
  const cases: { title: string; files: string[]; lines: Record<string, Lines>; warns: RegExp[] }[] =
    [
      {
        title: 'SPEC changed, line 3 not changed → warning',
        files: ['docs/SPEC.md'],
        lines: { 'docs/SPEC.md': same('Version: 1.64 (T919 — §22).') },
        warns: [/^docs\/SPEC\.md changed but its version line \(line 3\) did not/u],
      },
      {
        title: 'FRONTEND changed with a new entry first → no warning',
        files: ['docs/FRONTEND.md', 'apps/web/src/a.ts'],
        lines: { 'docs/FRONTEND.md': { base: OLD, upstream: OLD, head: NEW } },
        warns: [],
      },
      {
        title: 'other files only → no warning, even with the docs unchanged',
        files: ['AGENTS.md', 'docs/BACKLOG.md', 'README.md'],
        lines: { 'docs/SPEC.md': same('Version: 1.64 (T919).') },
        warns: [],
      },
      {
        title: 'a conflict resolution dropped an entry of the upstream → warning naming it',
        files: ['docs/FRONTEND.md'],
        lines: {
          'docs/FRONTEND.md': {
            base: 'Version 1.40 — 2026-11-07 (T919).',
            upstream: OLD,
            head: 'Version 1.42 — 2026-11-08 (T1000). Trước đó 1.40 — 2026-11-07 (T919).',
          },
        },
        warns: [/^docs\/FRONTEND\.md: line 3 lost the entry 1\.41 of the upstream/u],
      },
      {
        title: 'unchanged and lost entries both reported, per file',
        files: ['docs/CONTRACTS.md', 'docs/SPEC.md'],
        lines: {
          'docs/CONTRACTS.md': {
            base: 'Version 2.22 — 2026-11-07 (T919).',
            upstream: 'Version 2.23 — 2026-11-07 (T1002). Trước đó 2.22 — 2026-11-07 (T919).',
            head: 'Version 2.22 — 2026-11-07 (T919).',
          },
          'docs/SPEC.md': same('Version: 1.64 (T919).'),
        },
        // In the order of VERSIONED_DOCS.
        warns: [
          /^docs\/SPEC\.md changed but its version line/u,
          /^docs\/CONTRACTS\.md changed but its version line/u,
          /^docs\/CONTRACTS\.md: line 3 lost the entry 2\.23/u,
        ],
      },
      {
        title: 'prefix and duplicates may change: same entries → no warning',
        files: ['docs/FRONTEND.md'],
        lines: {
          'docs/FRONTEND.md': {
            base: 'Version 1.41 — 2026-11-07 (T1002). Version 1.41 — 2026-11-07 (T1002). Version 1.40 — 2026-11-07 (T919).',
            upstream:
              'Version 1.41 — 2026-11-07 (T1002). Version 1.41 — 2026-11-07 (T1002). Version 1.40 — 2026-11-07 (T919).',
            head: 'Version 1.43 — 2026-11-08 (T1001). Trước đó 1.41 — 2026-11-07 (T1002). Trước đó 1.40 — 2026-11-07 (T919).',
          },
        },
        warns: [],
      },
      {
        title: 'a new doc (no upstream copy) → no warning',
        files: ['docs/CONTRACTS.md'],
        lines: {
          'docs/CONTRACTS.md': {
            base: null,
            upstream: null,
            head: 'Version 1.0 — 2026-11-08 (T1).',
          },
        },
        warns: [],
      },
      {
        title: 'a deleted doc → no warning',
        files: ['docs/SPEC.md'],
        lines: {
          'docs/SPEC.md': {
            base: 'Version: 1.64 (T919).',
            upstream: 'Version: 1.64 (T919).',
            head: null,
          },
        },
        warns: [],
      },
    ];

  it.each(cases)('$title', ({ files, lines, warns }) => {
    const none: Lines = { base: null, upstream: null, head: null };
    const warnings = versionLineWarnings(files, (file) => lines[file] ?? none);
    expect(warnings).toHaveLength(warns.length);
    warns.forEach((pattern, index) => {
      expect(warnings[index]).toMatch(pattern);
    });
  });
});

describe('RULES', () => {
  // A renamed directory must not silently drop a step from the gate.
  it('every glob matches a tracked file', () => {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    }).split('\n');
    const stale = RULES.flatMap(({ globs }) => globs).filter(
      (glob) => !tracked.some((file) => matchesGlob(file, glob)),
    );
    expect(stale).toEqual([]);
  });
});
