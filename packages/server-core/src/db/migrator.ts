import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FileMigrationProvider,
  Migrator,
  type Migration,
  type MigrationProvider,
} from 'kysely/migration';

import type { Kysely } from 'kysely';

/**
 * Meta migrations live next to this module (`src/db/migrations/*.ts`,
 * compiled to `dist/db/migrations/*.js`), so the api, the worker, the CLI and
 * integration tests of every package run the same files.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Bookkeeping tables of the migrator, in `public` (not tenant data). */
export const MIGRATION_TABLE = 'app_migration';
export const MIGRATION_LOCK_TABLE = 'app_migration_lock';

/** `NNNN_snake_case`; the number fixes the order. */
export const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export class MigrationFailedError extends Error {
  readonly migrationName: string | undefined;

  constructor(migrationName: string | undefined, cause: unknown) {
    super(
      migrationName === undefined
        ? 'Migrations failed before any migration ran'
        : `Migration ${migrationName} failed; no migration of this run was applied`,
      { cause },
    );
    this.name = 'MigrationFailedError';
    this.migrationName = migrationName;
  }
}

/**
 * Loads `NNNN_name.{ts,js}` files. Rejects badly named files and modules that
 * do not export `up`, instead of silently skipping them.
 */
class MetaMigrationProvider implements MigrationProvider {
  readonly #files: FileMigrationProvider;
  readonly #rejected: string[] = [];

  constructor(folder: string) {
    this.#files = new FileMigrationProvider({
      fs,
      path,
      migrationFolder: folder,
      import: (file) => import(pathToFileURL(file).href) as Promise<unknown>,
      onFileIgnored: (file, reason) => {
        if (reason === 'NotMigration') this.#rejected.push(file);
      },
    });
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations = await this.#files.getMigrations();
    const badNames = Object.keys(migrations).filter((name) => !MIGRATION_NAME_PATTERN.test(name));
    if (this.#rejected.length > 0 || badNames.length > 0) {
      throw new Error(
        `Invalid migration files: ${[...this.#rejected, ...badNames].join(', ')} ` +
          '(expected NNNN_name exporting `up`)',
      );
    }
    return migrations;
  }
}

/**
 * Forward-only migrator: only `migrateToLatest` is used; `down` functions are
 * never written or run. A migration file must not change after it is merged
 * (checked by `migrations.lock.json`).
 */
export function createMigrator<DB>(db: Kysely<DB>, folder: string = MIGRATIONS_DIR): Migrator {
  return new Migrator({
    db,
    provider: new MetaMigrationProvider(folder),
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
    // A migration missing from the folder, or a new one sorted before an
    // applied one, is an error rather than being run out of order.
    allowUnorderedMigrations: false,
  });
}

/**
 * Applies every pending migration in one transaction (serialised across
 * processes by an advisory lock) and returns the names applied, in order.
 * Running it again is a no-op.
 */
export async function migrateToLatest<DB>(
  db: Kysely<DB>,
  folder: string = MIGRATIONS_DIR,
): Promise<readonly string[]> {
  const { error, results = [] } = await createMigrator(db, folder).migrateToLatest();
  if (error !== undefined) {
    const failed = results.find((result) => result.status === 'Error');
    throw new MigrationFailedError(failed?.migrationName, error);
  }
  return results
    .filter((result) => result.status === 'Success')
    .map((result) => result.migrationName);
}
