import { newId } from '@cellhive/contracts';
import { SessionsRepository, UsersRepository, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMaintenanceCleanupTask } from '../../src/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

describe('maintenance.cleanup', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('purges expired sessions and keeps live ones', async () => {
    const now = new Date('2026-09-23T10:00:00Z');
    const user = await new UsersRepository(db).create({
      email: 'sessions@example.test',
      displayName: 'Sessions',
      passwordHash: null,
    });
    const sessions = new SessionsRepository(db);
    const session = (tokenHash: string, expiresAt: Date) =>
      sessions.create({
        id: newId('ses'),
        userId: user.id,
        tokenHash,
        expiresAt,
        ip: null,
        userAgent: null,
      });
    const expired = await session('expired', new Date(now.getTime() - 1000));
    const expiredLongAgo = await session('expired-long-ago', new Date('2025-01-01T00:00:00Z'));
    const live = await session('live', new Date(now.getTime() + 60_000));

    const captured = captureLogger();
    const task = createMaintenanceCleanupTask({ db, logger: captured.logger, now: () => now });
    await task({}, {} as JobHelpers);

    const left = await db.kysely.selectFrom('meta.sessions').select('id').execute();
    expect(left.map((row) => row.id)).toEqual([live.id]);
    expect(left.map((row) => row.id)).not.toContain(expired.id);
    expect(left.map((row) => row.id)).not.toContain(expiredLongAgo.id);
    expect(captured.lines.at(-1)).toMatchObject({
      msg: 'expired operational rows purged',
      sessions: 2,
    });

    // Idempotent.
    await task({}, {} as JobHelpers);
    expect(captured.lines.at(-1)).toMatchObject({ sessions: 0 });
  });
});
