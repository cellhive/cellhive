import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  appendToMigrationLock,
  checksumMigrationSource,
  diffMigrationLock,
  readMigrationChecksums,
  type MigrationLockFile,
} from '../../src/db/migration-lock.js';
import { MIGRATION_NAME_PATTERN } from '../../src/db/migrator.js';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const LOCK = fileURLToPath(new URL('../../src/db/migrations.lock.json', import.meta.url));

async function readLock(): Promise<MigrationLockFile> {
  return JSON.parse(await readFile(LOCK, 'utf8')) as MigrationLockFile;
}

describe('migrations.lock.json (forward-only, AGENTS.md rule 9)', () => {
  it('matches every migration file exactly: merged migrations were not edited', async () => {
    const diff = diffMigrationLock(
      (await readLock()).migrations,
      await readMigrationChecksums(MIGRATIONS),
    );
    expect(
      diff,
      'A locked migration changed or was deleted: revert it and add a new migration. ' +
        'A new migration is not locked yet: run `pnpm --filter @cellhive/server-core migrations:lock`.',
    ).toEqual({ changed: [], deleted: [], unlocked: [] });
  });

  it('names migrations NNNN_name with consecutive numbers from 0001', async () => {
    const names = (await readdir(MIGRATIONS))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.slice(0, -3))
      .sort();
    expect(names.length).toBeGreaterThan(0);
    names.forEach((name, index) => {
      expect(name).toMatch(MIGRATION_NAME_PATTERN);
      expect(name.slice(0, 4)).toBe(String(index + 1).padStart(4, '0'));
    });
  });
});

describe('checksumMigrationSource', () => {
  it('is a SHA-256 hex digest', () => {
    expect(checksumMigrationSource('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('ignores CRLF vs LF but nothing else', () => {
    expect(checksumMigrationSource('a\r\nb\n')).toBe(checksumMigrationSource('a\nb\n'));
    expect(checksumMigrationSource('a\nb\n')).not.toBe(checksumMigrationSource('a\nb \n'));
  });
});

describe('diffMigrationLock', () => {
  const cases: {
    name: string;
    locked: Record<string, string>;
    actual: Record<string, string>;
    expected: ReturnType<typeof diffMigrationLock>;
  }[] = [
    {
      name: 'identical',
      locked: { '0001_a': 'x' },
      actual: { '0001_a': 'x' },
      expected: { changed: [], deleted: [], unlocked: [] },
    },
    {
      name: 'edited migration',
      locked: { '0001_a': 'x', '0002_b': 'y' },
      actual: { '0001_a': 'x', '0002_b': 'z' },
      expected: { changed: ['0002_b'], deleted: [], unlocked: [] },
    },
    {
      name: 'deleted migration',
      locked: { '0001_a': 'x', '0002_b': 'y' },
      actual: { '0001_a': 'x' },
      expected: { changed: [], deleted: ['0002_b'], unlocked: [] },
    },
    {
      name: 'new migration',
      locked: { '0001_a': 'x' },
      actual: { '0001_a': 'x', '0002_b': 'y' },
      expected: { changed: [], deleted: [], unlocked: ['0002_b'] },
    },
  ];

  it.each(cases)('$name', ({ locked, actual, expected }) => {
    expect(diffMigrationLock(locked, actual)).toEqual(expected);
  });
});

describe('appendToMigrationLock', () => {
  it('adds new migrations and keeps existing entries', () => {
    const next = appendToMigrationLock(
      { migrations: { '0001_a': 'x' } },
      { '0001_a': 'x', '0002_b': 'y' },
    );
    expect(next.migrations).toEqual({ '0001_a': 'x', '0002_b': 'y' });
  });

  it('refuses to re-lock an edited or deleted migration', () => {
    expect(() =>
      appendToMigrationLock({ migrations: { '0001_a': 'x' } }, { '0001_a': 'changed' }),
    ).toThrow(/must not change/);
    expect(() => appendToMigrationLock({ migrations: { '0001_a': 'x' } }, {})).toThrow(
      /deleted: \[0001_a\]/,
    );
  });
});
