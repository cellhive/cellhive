import { newId, type Id } from '@cellhive/contracts';
import { systemRoleConfig } from '@cellhive/permissions';
import {
  BaseRolesRepository,
  BasesRepository,
  EventsNotSettleableError,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  settleEventsWithoutAutomations,
  systemAuditContext,
  UsersRepository,
  WorkspacesRepository,
  type AppConfig,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';

import { PasswordHasher } from '../common/auth/password/password-hasher.js';
import { APP_CONFIG, DB } from '../common/tokens.js';
import { OrganizationProvisioner } from '../modules/setup/org-provisioning.js';

import { seedBenchAutomations } from './bench-automations.js';
import { BENCH_ROWS, seedBenchTable, type BenchTableResult } from './bench-table.js';

import type { INestApplicationContext } from '@nestjs/common';

/** Development-only credentials of the bench owner. Never used in production. */
export const BENCH_EMAIL = 'bench@bench.cellhive.local';
export const BENCH_PASSWORD = 'Cellhive-bench-2026';
const BENCH_ORG = 'Cellhive Bench';
const BENCH_MEMBERS = 4;
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const LOCALE = 'vi';

export interface BenchSeedResult extends BenchTableResult {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly email: string;
  readonly password: string;
  /** Events of the new records marked dispatched (BACKLOG T519; 0 when nothing was pending). */
  readonly settledEvents: number;
  /** Bench automations created by this run (BACKLOG T519; off). */
  readonly automations: number;
}

/**
 * `pnpm seed:bench`: an organization "Cellhive Bench" owned by
 * `bench@bench.cellhive.local` (password `Cellhive-bench-2026`, dev only)
 * with four members, a workspace and a base holding the 200 000-row table
 * of `seedBenchTable`, the pending events of its records settled and three
 * automations (off, `seedBenchAutomations`; BACKLOG T519). Idempotent: an
 * existing bench owner is reused.
 */
export async function seedBench(
  app: INestApplicationContext,
  options: { readonly rows?: number; readonly onProgress?: (done: number, total: number) => void },
): Promise<BenchSeedResult> {
  const config = app.get<AppConfig>(APP_CONFIG);
  if (config.nodeEnv === 'production') {
    throw new Error('seed:bench refuses to run with NODE_ENV=production');
  }
  const db = app.get<Db>(DB);
  const users = new UsersRepository(db);
  const organizations = new OrganizationsRepository(db);
  const orgMembers = new OrgMembersRepository(db);

  let owner = await users.findByEmail(BENCH_EMAIL);
  let organizationId: Id<'org'>;
  let baseId: Id<'bse'>;
  const memberIds: Id<'usr'>[] = [];
  if (owner === undefined) {
    const hash = await app.get(PasswordHasher).hash(BENCH_PASSWORD);
    ({ organizationId, baseId } = await db.withTx(async (tx) => {
      const created = await users.create(
        { email: BENCH_EMAIL, displayName: 'Bench Owner', passwordHash: hash },
        tx,
      );
      const organization = await new OrganizationProvisioner(organizations, orgMembers).create(tx, {
        name: BENCH_ORG,
        ownerId: created.id,
        settings: { locale: LOCALE, timezone: TIME_ZONE, currency: config.defaults.currency },
        context: systemAuditContext(),
      });
      const scope = orgScope(organization.id, tx);
      for (let index = 1; index <= BENCH_MEMBERS; index += 1) {
        const member = await users.create(
          {
            email: `member${String(index)}@bench.cellhive.local`,
            displayName: `Nhân viên ${String(index)}`,
            passwordHash: null,
          },
          tx,
        );
        await orgMembers.add(scope, member.id, 'member');
      }
      const workspace = await new WorkspacesRepository(db).create(scope, {
        id: newId('wsp'),
        name: 'Bench',
        slug: 'bench',
      });
      const base = await new BasesRepository(db).create(scope, {
        workspaceId: workspace.id,
        ownerId: created.id,
        name: 'Bench',
      });
      const roles = new BaseRolesRepository(db);
      const presets = [
        ['admin', 'Admin'],
        ['editor', 'Editor'],
        ['reader', 'Reader'],
      ] as const;
      for (const [position, [preset, name]] of presets.entries()) {
        await roles.create(scope, {
          baseId: base.id,
          name,
          kind: `system_${preset}`,
          config: systemRoleConfig(preset, { tables: [] }) as unknown as JsonObject,
          position,
        });
      }
      return { organizationId: organization.id, baseId: base.id };
    }));
    owner = await users.findByEmail(BENCH_EMAIL);
    if (owner === undefined) throw new Error('bench owner vanished');
  } else {
    const membership = (await organizations.listMembershipsOfUser(owner.id)).find(
      (item) => item.name === BENCH_ORG && item.role === 'owner',
    );
    if (membership === undefined) throw new Error(`${BENCH_EMAIL} exists without "${BENCH_ORG}"`);
    organizationId = membership.organizationId;
    const scope = orgScope(organizationId);
    const workspace = (
      await new WorkspacesRepository(db).list(scope, { offset: 0, limit: 100 })
    ).items.find((item) => item.slug === 'bench');
    const base =
      workspace === undefined
        ? undefined
        : (await new BasesRepository(db).listByWorkspace(scope, workspace.id)).find(
            (item) => item.name === 'Bench',
          );
    if (base === undefined) throw new Error('the bench base is missing');
    baseId = base.id;
  }

  for (const member of await orgMembers.list(orgScope(organizationId))) {
    memberIds.push(member.user_id);
  }

  const table = await seedBenchTable(app, {
    organizationId,
    baseId,
    ownerId: owner.id,
    userIds: memberIds,
    timeZone: TIME_ZONE,
    locale: LOCALE,
    rows: options.rows ?? BENCH_ROWS,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  // BACKLOG T519: the 200 000 records leave as many `events.dispatch` jobs;
  // without any automation they start nothing, so they are settled at once.
  // A bench organization that already has automations keeps its queue.
  let settledEvents = 0;
  try {
    settledEvents = (await settleEventsWithoutAutomations(db, orgScope(organizationId))).events;
  } catch (error) {
    if (!(error instanceof EventsNotSettleableError)) throw error;
  }
  const automations = await seedBenchAutomations(app, {
    organizationId,
    baseId,
    tableId: table.tableId,
    ownerId: owner.id,
  });
  return {
    ...table,
    organizationId,
    baseId,
    email: BENCH_EMAIL,
    password: BENCH_PASSWORD,
    settledEvents,
    automations,
  };
}
