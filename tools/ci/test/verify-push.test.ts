import { execFileSync } from 'node:child_process';
import { matchesGlob, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { planSteps, RULES } from '../../verify-push.mjs';

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
