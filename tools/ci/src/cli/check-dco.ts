/**
 * Fails when a commit in BASE..HEAD lacks a DCO sign-off matching its author.
 *
 * Usage: node tools/ci/src/cli/check-dco.ts [BASE..HEAD]
 * or set DCO_BASE and DCO_HEAD (HEAD defaults to "HEAD"). An empty or all-zero
 * base (first push of a branch) checks only the head commit.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { checkDco, formatDcoViolation, GIT_LOG_FORMAT, parseGitLog } from '../dco.ts';

const { positionals } = parseArgs({ allowPositionals: true });

function resolveRange(): string[] {
  const [range] = positionals;
  if (range !== undefined) return [range];
  const base = process.env['DCO_BASE']?.trim() ?? '';
  const head = process.env['DCO_HEAD']?.trim() || 'HEAD';
  if (base === '' || /^0+$/.test(base)) return ['-1', head];
  return [`${base}..${head}`];
}

const range = resolveRange();
const output = execFileSync('git', ['log', `--format=${GIT_LOG_FORMAT}`, ...range, '--'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const commits = parseGitLog(output);
const violations = checkDco(commits);

if (violations.length > 0) {
  process.stderr.write(
    `DCO check failed for ${String(violations.length)} of ${String(commits.length)} commits ` +
      `(${range.join(' ')}):\n` +
      violations.map((violation) => `  - ${formatDcoViolation(violation)}\n`).join('') +
      'Sign off with `git commit -s`; fix existing commits with ' +
      '`git rebase --signoff <base>`. See CONTRIBUTING.md.\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `DCO check passed: ${String(commits.length)} commits (${range.join(' ')})\n`,
  );
}
