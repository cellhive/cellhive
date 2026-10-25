import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  afterCommit,
  BasesRepository,
  migrateToLatest,
  orgScope,
  type Db,
  type Tx,
} from '../../src/db/index.js';
import { JobsRepository } from '../../src/jobs/index.js';
import { attachRealtimePublisher, type RealtimeEnvelope } from '../../src/realtime/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_RealtimeOrgA0001';
const ORG_B: Id<'org'> = 'org_RealtimeOrgB0001';

/**
 * T209: `afterCommit` and the repositories that publish on the realtime
 * bus (`permission.changed` from `BasesRepository`, `job.progress` from
 * `JobsRepository`) only once their transaction has committed.
 */
describe('realtime publishing after commit', () => {
  let database: TestDatabase;
  let db: Db;
  let bases: BasesRepository;
  let jobs: JobsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  const published: RealtimeEnvelope[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
    bases = new BasesRepository(db);
    jobs = new JobsRepository(db);
  });

  beforeEach(() => {
    published.length = 0;
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('afterCommit', () => {
    it('runs hooks in order once the transaction committed', async () => {
      const calls: string[] = [];
      await db.withTx((tx) => {
        afterCommit(tx, () => {
          calls.push('first');
        });
        afterCommit(tx, () => {
          throw new Error('ignored');
        });
        afterCommit(tx, async () => {
          await Promise.resolve();
          calls.push('third');
        });
        expect(calls).toEqual([]);
        return Promise.resolve();
      });
      expect(calls).toEqual(['first', 'third']);
    });

    it('drops hooks on rollback', async () => {
      const calls: string[] = [];
      await expect(
        db.withTx((tx) => {
          afterCommit(tx, () => {
            calls.push('never');
          });
          return Promise.reject(new Error('rollback'));
        }),
      ).rejects.toThrow('rollback');
      expect(calls).toEqual([]);
    });

    it('refuses a transaction that is not open', async () => {
      let closed: Tx | undefined;
      await db.withTx((tx) => {
        closed = tx;
        return Promise.resolve();
      });
      expect(() => {
        afterCommit(closed as Tx, () => undefined);
      }).toThrow(TypeError);
    });
  });

  describe('BasesRepository', () => {
    it('publishes the bumped bases of its own organization after commit', async () => {
      await db.withTx(async (tx) => {
        await bases.bumpPermissionVersion(orgScope(ORG_A, tx), { all: true });
        expect(published).toEqual([]);
      });
      expect(published).toEqual([
        { v: 1, type: 'permission.changed', organization_id: ORG_A, base_ids: [a.baseId] },
      ]);
    });

    it('publishes at once outside a transaction, per workspace too', async () => {
      await bases.bumpPermissionVersion(orgScope(ORG_B), { workspaceIds: [b.workspaceId] });
      expect(published).toEqual([
        { v: 1, type: 'permission.changed', organization_id: ORG_B, base_ids: [b.baseId] },
      ]);
    });

    it('publishes nothing when nothing changed or on rollback', async () => {
      // A base of another organization is not touched.
      expect(await bases.bumpPermissionVersion(orgScope(ORG_A), { baseIds: [b.baseId] })).toBe(0);
      await expect(
        db.withTx(async (tx) => {
          await bases.bumpPermissionVersion(orgScope(ORG_A, tx), { baseIds: [a.baseId] });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(published).toEqual([]);
    });

    it('publishes when a base moves to or from the trash or changes owner', async () => {
      const scope = orgScope(ORG_A);
      await bases.update(scope, a.baseId, { name: 'Renamed' });
      expect(published).toEqual([]);
      await bases.update(scope, a.baseId, { ownerId: a.userId });
      await bases.softDelete(scope, a.baseId);
      await bases.restore(scope, a.baseId);
      await bases.transferOwnership(scope, a.userId, a.userId);
      expect(published.map((envelope) => envelope.type)).toEqual([
        'permission.changed',
        'permission.changed',
        'permission.changed',
        'permission.changed',
      ]);
      expect(new Set(published.map((envelope) => envelope.organization_id))).toEqual(
        new Set([ORG_A]),
      );
    });
  });

  describe('JobsRepository', () => {
    it('tells the creator about each state change, after commit', async () => {
      const scope = orgScope(ORG_A);
      const job = await db.withTx(async (tx) => {
        const created = await jobs.create(orgScope(ORG_A, tx), {
          type: 'audit.export',
          createdBy: a.userId,
        });
        expect(published).toEqual([]);
        return created;
      });
      await jobs.markRunning(scope, job.id);
      await jobs.setProgress(scope, job.id, 0.5);
      // Not running any more: no row changed, nothing published.
      await jobs.markSucceeded(scope, job.id, { rows: 1 });
      await jobs.setProgress(scope, job.id, 0.9);
      expect(published).toEqual(
        [
          ['queued', 0],
          ['running', 0],
          ['running', 0.5],
          ['succeeded', 1],
        ].map(([status, progress]) => ({
          v: 1,
          type: 'job.progress',
          organization_id: ORG_A,
          user_id: a.userId,
          job_id: job.id,
          progress,
          status,
        })),
      );
    });

    it('publishes nothing for system jobs or other organizations', async () => {
      const job = await jobs.create(orgScope(ORG_A), { type: 'audit.export', createdBy: null });
      await jobs.markRunning(orgScope(ORG_A), job.id);
      const mine = await jobs.create(orgScope(ORG_A), {
        type: 'audit.export',
        createdBy: a.userId,
      });
      published.length = 0;
      expect(await jobs.markCancelled(orgScope(ORG_B), mine.id)).toBeUndefined();
      expect(published).toEqual([]);
    });
  });
});
