import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The system scan context (ADR-34 §1, BACKLOG T546) reads every live record
 * of a table with no read rule: only worker-side time scans may use it.
 * Outside its own files, only the time scan core and the S5b date reminders
 * may name it — never the API, the package exports or another module.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NAMES = /\bsystemScanAccess\b|\bSystemScanAccess\b|system-scan(?:\.js)?['"]/u;

const ALLOWED: readonly RegExp[] = [
  /^packages\/server-core\/src\/records\/record-query\.service\.ts$/u,
  /^packages\/server-core\/src\/records\/due\/system-scan\.ts$/u,
  /^packages\/server-core\/src\/time-scan\//u,
  /^packages\/server-core\/src\/notifications\/reminders\//u,
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx|mts|js|mjs)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

describe('system scan context lock (ADR-34 §1, T546)', () => {
  it('is named only by the record reader, the time scan core and date reminders', async () => {
    const roots: string[] = [];
    for (const group of ['apps', 'packages']) {
      for (const entry of await readdir(join(ROOT, group), { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(join(ROOT, group, entry.name, 'src'));
      }
    }
    const users: string[] = [];
    for (const root of roots) {
      for (const file of await sourceFiles(root)) {
        if (NAMES.test(await readFile(file, 'utf8'))) {
          users.push(relative(ROOT, file).split(sep).join('/'));
        }
      }
    }
    // The lock sees the real users (guards against a pattern that matches nothing).
    expect(users).toContain('packages/server-core/src/records/record-query.service.ts');
    expect(users).toContain('packages/server-core/src/time-scan/scan-core.ts');
    expect(users.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)))).toEqual([]);
  });

  it('is not exported by the records module or the package', async () => {
    for (const index of [
      'packages/server-core/src/records/index.ts',
      'packages/server-core/src/index.ts',
      'packages/server-core/src/time-scan/index.ts',
    ]) {
      const source = await readFile(join(ROOT, index), 'utf8');
      expect(source, index).not.toMatch(/system-scan/u);
    }
    const pkg = JSON.parse(
      await readFile(join(ROOT, 'packages/server-core/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports)).not.toContain('./time-scan');
  });
});
