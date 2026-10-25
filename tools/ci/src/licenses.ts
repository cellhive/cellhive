import { parseSpdx, satisfies, SpdxParseError } from './spdx.ts';

/** One package entry as printed by `pnpm licenses list --json`. */
export interface PnpmLicenseEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license?: string | undefined;
}

/** Output of `pnpm licenses list --json`: entries grouped by license string. */
export type PnpmLicenseReport = Readonly<Record<string, readonly PnpmLicenseEntry[]>>;

export interface LicenseException {
  /** SPDX id that is allowed only for the listed packages. */
  readonly license: string;
  readonly reason: string;
  readonly packages: readonly string[];
}

export interface LicensePolicy {
  readonly allowed: readonly string[];
  readonly exceptions: readonly LicenseException[];
}

export interface LicenseViolation {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
  readonly reason: 'missing' | 'unparsable' | 'not-allowed';
}

/** Placeholders pnpm and npm use when a package declares no usable license. */
const MISSING_LICENSE = new Set(['', 'unknown', 'none']);

export function checkLicenses(
  report: PnpmLicenseReport,
  policy: LicensePolicy,
): LicenseViolation[] {
  const allowed = new Set(policy.allowed.map((id) => id.toLowerCase()));
  const violations: LicenseViolation[] = [];

  for (const [groupLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const license = (entry.license ?? groupLicense).trim();
      const violation = (reason: LicenseViolation['reason']): void => {
        violations.push({ name: entry.name, versions: entry.versions, license, reason });
      };

      if (MISSING_LICENSE.has(license.toLowerCase())) {
        violation('missing');
        continue;
      }

      let tree;
      try {
        tree = parseSpdx(license);
      } catch (error) {
        if (!(error instanceof SpdxParseError)) throw error;
        violation('unparsable');
        continue;
      }

      const packageExceptions = new Set(
        policy.exceptions
          .filter((exception) => exception.packages.includes(entry.name))
          .map((exception) => exception.license.toLowerCase()),
      );
      const isAllowed = (id: string): boolean => {
        const key = id.toLowerCase();
        return allowed.has(key) || packageExceptions.has(key);
      };

      if (!satisfies(tree, isAllowed)) violation('not-allowed');
    }
  }

  return violations.sort((a, b) => a.name.localeCompare(b.name));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Validates untrusted JSON from `pnpm licenses list --json`. */
export function parsePnpmLicenseReport(json: unknown): PnpmLicenseReport {
  if (!isObject(json)) throw new TypeError('License report must be a JSON object');
  const report: Record<string, PnpmLicenseEntry[]> = {};
  for (const [group, entries] of Object.entries(json)) {
    if (!Array.isArray(entries)) throw new TypeError(`License group "${group}" must be an array`);
    report[group] = entries.map((entry: unknown) => {
      if (!isObject(entry) || typeof entry['name'] !== 'string') {
        throw new TypeError(`License group "${group}" has an entry without a name`);
      }
      const license = entry['license'];
      const versions = entry['versions'];
      return {
        name: entry['name'],
        versions: isStringArray(versions) ? versions : [],
        license: typeof license === 'string' ? license : undefined,
      };
    });
  }
  return report;
}

/** Validates `license-policy.json`. */
export function parseLicensePolicy(json: unknown): LicensePolicy {
  if (!isObject(json) || !isStringArray(json['allowed']) || !Array.isArray(json['exceptions'])) {
    throw new TypeError('License policy needs "allowed" (string[]) and "exceptions" (array)');
  }
  const exceptions = json['exceptions'].map((item: unknown): LicenseException => {
    if (
      !isObject(item) ||
      typeof item['license'] !== 'string' ||
      typeof item['reason'] !== 'string' ||
      !isStringArray(item['packages'])
    ) {
      throw new TypeError('License exception needs "license", "reason" and "packages"');
    }
    return { license: item['license'], reason: item['reason'], packages: item['packages'] };
  });
  return { allowed: json['allowed'], exceptions };
}

export function formatLicenseViolation(violation: LicenseViolation): string {
  const what = `${violation.name}@${violation.versions.join(', ') || '?'}`;
  switch (violation.reason) {
    case 'missing':
      return `${what}: no license declared`;
    case 'unparsable':
      return `${what}: "${violation.license}" is not a valid SPDX expression`;
    case 'not-allowed':
      return `${what}: "${violation.license}" is not in the allowlist (docs/SPEC.md §1A)`;
  }
}
