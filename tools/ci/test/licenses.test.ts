import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkLicenses,
  parseLicensePolicy,
  parsePnpmLicenseReport,
  type LicenseViolation,
  type PnpmLicenseReport,
} from '../src/licenses.ts';

const policy = parseLicensePolicy(
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../license-policy.json'), 'utf8')),
);

/** Builds a one-package report the way pnpm groups it (by license string). */
function reportFor(name: string, license: string | undefined): PnpmLicenseReport {
  return { [license ?? 'Unknown']: [{ name, versions: ['1.0.0'], license }] };
}

describe('checkLicenses', () => {
  const cases: {
    title: string;
    name?: string;
    license: string | undefined;
    expected: LicenseViolation['reason'] | null;
  }[] = [
    { title: 'MIT passes', license: 'MIT', expected: null },
    { title: 'Apache-2.0 passes', license: 'Apache-2.0', expected: null },
    { title: 'id matching is case-insensitive', license: 'mit', expected: null },
    { title: 'GPL-2.0-only fails', license: 'GPL-2.0-only', expected: 'not-allowed' },
    { title: 'OR passes if one side is allowed', license: '(MIT OR GPL-2.0-only)', expected: null },
    {
      title: 'OR fails if no side is allowed',
      license: 'GPL-2.0-only OR SSPL-1.0',
      expected: 'not-allowed',
    },
    {
      title: 'AND fails if one side is not allowed',
      license: 'MIT AND GPL-2.0-only',
      expected: 'not-allowed',
    },
    { title: 'AND passes if all sides are allowed', license: '(MIT AND Zlib)', expected: null },
    { title: 'AND binds tighter than OR', license: 'GPL-2.0-only AND MIT OR ISC', expected: null },
    {
      title: 'parentheses override precedence',
      license: 'GPL-2.0-only AND (MIT OR ISC)',
      expected: 'not-allowed',
    },
    {
      title: 'nested parentheses',
      license: '((MIT OR GPL-2.0-only) AND (Apache-2.0 OR SSPL-1.0))',
      expected: null,
    },
    {
      title: 'WITH exception uses the base license',
      license: 'Apache-2.0 WITH LLVM-exception',
      expected: null,
    },
    {
      title: 'WITH exception on a disallowed base',
      license: 'GPL-2.0-only WITH Classpath-exception-2.0',
      expected: 'not-allowed',
    },
    { title: 'missing license fails', license: undefined, expected: 'missing' },
    { title: '"Unknown" license fails', license: 'Unknown', expected: 'missing' },
    { title: 'non-SPDX text fails', license: 'SEE LICENSE IN LICENSE.md', expected: 'unparsable' },
    { title: 'unbalanced parentheses fail', license: '(MIT OR ISC', expected: 'unparsable' },
    { title: 'UNLICENSED (proprietary) fails', license: 'UNLICENSED', expected: 'not-allowed' },
    {
      title: 'CC-BY-4.0 passes for caniuse-lite',
      name: 'caniuse-lite',
      license: 'CC-BY-4.0',
      expected: null,
    },
    {
      title: 'CC-BY-4.0 fails for other packages',
      name: 'some-lib',
      license: 'CC-BY-4.0',
      expected: 'not-allowed',
    },
    {
      title: 'OFL-1.1 fails without a font exception',
      name: 'some-font',
      license: 'OFL-1.1',
      expected: 'not-allowed',
    },
  ];

  it.each(cases)('$title', ({ name = 'pkg', license, expected }) => {
    const violations = checkLicenses(reportFor(name, license), policy);
    expect(violations.map((violation) => violation.reason)).toEqual(expected ? [expected] : []);
  });

  it('falls back to the group key when an entry has no license field', () => {
    const report: PnpmLicenseReport = { 'GPL-2.0-only': [{ name: 'a', versions: ['1.0.0'] }] };
    expect(checkLicenses(report, policy)).toEqual([
      { name: 'a', versions: ['1.0.0'], license: 'GPL-2.0-only', reason: 'not-allowed' },
    ]);
  });

  it('reports every offending package across groups', () => {
    const report = parsePnpmLicenseReport({
      MIT: [{ name: 'ok', versions: ['1.0.0'], license: 'MIT' }],
      'GPL-2.0-only': [{ name: 'b-bad', versions: ['2.0.0'], license: 'GPL-2.0-only' }],
      Unknown: [{ name: 'a-bad', versions: ['3.0.0'] }],
    });
    expect(checkLicenses(report, policy).map((violation) => violation.name)).toEqual([
      'a-bad',
      'b-bad',
    ]);
  });
});

describe('license policy file', () => {
  it('matches the allowlist in docs/SPEC.md §1A', () => {
    expect(policy.allowed).toEqual([
      'MIT',
      'MIT-0',
      'ISC',
      'BSD-2-Clause',
      'BSD-3-Clause',
      '0BSD',
      'Apache-2.0',
      'MPL-2.0',
      'LGPL-2.1-or-later',
      'LGPL-3.0-or-later',
      'GPL-3.0-or-later',
      'AGPL-3.0-only',
      'AGPL-3.0-or-later',
      'Python-2.0',
      'BlueOak-1.0.0',
      'Zlib',
      'Unlicense',
      'CC0-1.0',
    ]);
    expect(policy.exceptions.map((exception) => exception.license)).toEqual([
      'CC-BY-4.0',
      'OFL-1.1',
    ]);
  });
});

describe('parsePnpmLicenseReport', () => {
  it.each([
    { title: 'non-object', input: [] },
    { title: 'group that is not an array', input: { MIT: {} } },
    { title: 'entry without a name', input: { MIT: [{ versions: ['1.0.0'] }] } },
  ])('rejects $title', ({ input }) => {
    expect(() => parsePnpmLicenseReport(input)).toThrow(TypeError);
  });
});
