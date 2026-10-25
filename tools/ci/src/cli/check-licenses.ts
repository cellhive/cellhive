/**
 * Fails when an installed dependency has a license outside docs/SPEC.md §1A.
 *
 * Usage: node tools/ci/src/cli/check-licenses.ts [--report <pnpm-licenses.json>]
 * Without --report it runs `pnpm licenses list --json` for the whole workspace.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  checkLicenses,
  formatLicenseViolation,
  parseLicensePolicy,
  parsePnpmLicenseReport,
} from '../licenses.ts';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const policyPath = resolve(import.meta.dirname, '../../license-policy.json');

const { values } = parseArgs({ options: { report: { type: 'string' } } });

const rawReport =
  values.report === undefined
    ? execFileSync('pnpm', ['licenses', 'list', '--json', '--recursive'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
    : readFileSync(values.report, 'utf8');

const report = parsePnpmLicenseReport(JSON.parse(rawReport));
const policy = parseLicensePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
const violations = checkLicenses(report, policy);
const total = Object.values(report).reduce((sum, entries) => sum + entries.length, 0);

if (violations.length > 0) {
  process.stderr.write(
    `License check failed: ${String(violations.length)} of ${String(total)} packages\n` +
      violations.map((violation) => `  - ${formatLicenseViolation(violation)}\n`).join('') +
      'Allowed licenses and per-package exceptions: tools/ci/license-policy.json\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`License check passed: ${String(total)} packages\n`);
}
