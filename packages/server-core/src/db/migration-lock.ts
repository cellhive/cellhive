import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * `migrations.lock.json` pins the SHA-256 of every merged migration source so
 * that editing one fails CI (AGENTS.md rule 9: forward-only, never edit a
 * merged migration). New migrations are appended with
 * `pnpm --filter @cellhive/server-core migrations:lock`.
 */
export interface MigrationLockFile {
  readonly $comment?: string;
  readonly migrations: Readonly<Record<string, string>>;
}

export interface MigrationLockDiff {
  /** Locked migrations whose source changed. */
  readonly changed: readonly string[];
  /** Locked migrations whose file is gone. */
  readonly deleted: readonly string[];
  /** Migration files not in the lock yet. */
  readonly unlocked: readonly string[];
}

export const MIGRATION_LOCK_COMMENT =
  'SHA-256 of each merged meta migration. Never edit an entry: add a new migration instead. ' +
  'Append new ones with `pnpm --filter @cellhive/server-core migrations:lock`.';

/** Line endings are normalised so a checkout with CRLF gives the same hash. */
export function checksumMigrationSource(source: string): string {
  return createHash('sha256').update(source.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/** Checksums of the migration sources (`*.ts`, not `*.d.ts`) in `folder`, by name. */
export async function readMigrationChecksums(folder: string): Promise<Record<string, string>> {
  const files = (await readdir(folder))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .sort();
  const checksums: Record<string, string> = {};
  for (const file of files) {
    const source = await readFile(path.join(folder, file), 'utf8');
    checksums[file.slice(0, -'.ts'.length)] = checksumMigrationSource(source);
  }
  return checksums;
}

export function diffMigrationLock(
  locked: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): MigrationLockDiff {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [name, checksum] of Object.entries(locked)) {
    const current = actual[name];
    if (current === undefined) deleted.push(name);
    else if (current !== checksum) changed.push(name);
  }
  const unlocked = Object.keys(actual).filter((name) => !Object.hasOwn(locked, name));
  return { changed: changed.sort(), deleted: deleted.sort(), unlocked: unlocked.sort() };
}

/**
 * Adds unlocked migrations to the lock. Refuses when a locked migration
 * changed or disappeared: that must be fixed by reverting the edit.
 */
export function appendToMigrationLock(
  lock: MigrationLockFile,
  actual: Readonly<Record<string, string>>,
): MigrationLockFile {
  const diff = diffMigrationLock(lock.migrations, actual);
  if (diff.changed.length > 0 || diff.deleted.length > 0) {
    throw new Error(
      `Merged migrations must not change. Changed: [${diff.changed.join(', ')}], ` +
        `deleted: [${diff.deleted.join(', ')}]. Revert them and add a new migration instead.`,
    );
  }
  const migrations: Record<string, string> = { ...lock.migrations };
  for (const name of diff.unlocked) {
    const checksum = actual[name];
    if (checksum !== undefined) migrations[name] = checksum;
  }
  return { $comment: MIGRATION_LOCK_COMMENT, migrations };
}
