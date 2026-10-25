// Appends new meta migrations to src/db/migrations.lock.json. Run through
// `pnpm --filter @cellhive/server-core migrations:lock` (builds first).
// Refuses when a locked migration changed or was deleted.
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { appendToMigrationLock, readMigrationChecksums } from '../dist/db/migration-lock.js';

const folder = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const lockPath = fileURLToPath(new URL('../src/db/migrations.lock.json', import.meta.url));

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const next = appendToMigrationLock(lock, await readMigrationChecksums(folder));
await writeFile(lockPath, `${JSON.stringify(next, null, 2)}\n`);
process.stdout.write(
  `${lockPath}: ${String(Object.keys(next.migrations).length)} migration(s) locked\n`,
);
