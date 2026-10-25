import { newId, type Id } from '@cellhive/contracts';
import { resolveBaseAccess } from '@cellhive/permissions';
import {
  DashboardsRepository,
  FieldsRepository,
  MAX_RECORDS_PER_MUTATION,
  TablesRepository,
  type AuditContext,
  type OrgScope,
  type RecordAccessContext,
  type Db,
  type RecordMutationService,
} from '@cellhive/server-core';
import { base as baseLocale, en, Faker, vi } from '@faker-js/faker';

import { MetaBaseSchemaLoader } from '../common/access/base-schema-meta.js';

/** Fixed faker seed: the generated values are the same on every run (CONTRACTS §9). */
export const SEED_FAKER_SEED = 20_260_923;

const SEED_USER_AGENT = 'cellhive-seed';

/** Vietnamese faker (English then base as fallbacks) with a fixed seed. */
export function seededFaker(seed: number = SEED_FAKER_SEED): Faker {
  const faker = new Faker({ locale: [vi, en, baseLocale] });
  faker.seed(seed);
  return faker;
}

/**
 * Audit context of one seed step, acting as `userId` (like a request of that
 * user); its own request id groups the step's audit entries (ADR-23).
 */
export function seedAuditContext(userId: Id<'usr'>): AuditContext {
  const requestId = newId('req');
  return {
    actor: { type: 'user', id: userId },
    via: null,
    batch_id: requestId,
    request_id: requestId,
    ip: null,
    user_agent: SEED_USER_AGENT,
  };
}

/**
 * Record access of an organization owner in `baseId` (full access,
 * SPEC §14.1), resolved from the base's current tables and fields.
 */
export async function ownerAccessContext(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
  ownerId: Id<'usr'>,
  settings: { readonly timeZone: string; readonly locale: string },
): Promise<RecordAccessContext> {
  const schema = await new MetaBaseSchemaLoader(
    new TablesRepository(db),
    new FieldsRepository(db),
    new DashboardsRepository(db),
  ).load(scope, baseId);
  const resolved = resolveBaseAccess({
    principal: {
      userId: ownerId,
      groupIds: [],
      orgRole: 'owner',
      workspaceRole: null,
      isBaseOwner: false,
    },
    roles: [],
    assignments: [],
    schema,
  });
  if (resolved === null) throw new Error('an organization owner always has access');
  return {
    baseId,
    resolved,
    userId: ownerId,
    groupMemberUserIds: [],
    timeZone: settings.timeZone,
    locale: settings.locale,
    typecastLocale: settings.locale,
  };
}

export interface BatchInsertInput {
  readonly records: RecordMutationService;
  readonly scope: OrgScope;
  readonly tableId: Id<'tbl'>;
  readonly access: RecordAccessContext;
  readonly actorId: Id<'usr'>;
  readonly count: number;
  /** Cell values of row `index`, keyed by field name. */
  readonly row: (index: number) => Record<string, unknown>;
  readonly batchSize?: number;
  readonly onBatch?: (done: number) => void;
}

/**
 * Creates `count` records through `RecordMutationService` (AGENTS.md
 * rule 1), 1 000 per transaction, so every record gets its event, audit
 * entry and permission checks like an API request.
 */
export async function insertInBatches(input: BatchInsertInput): Promise<Id<'rec'>[]> {
  const batchSize = Math.min(input.batchSize ?? MAX_RECORDS_PER_MUTATION, MAX_RECORDS_PER_MUTATION);
  const ids: Id<'rec'>[] = [];
  for (let start = 0; start < input.count; start += batchSize) {
    const end = Math.min(start + batchSize, input.count);
    const rows = [];
    for (let index = start; index < end; index += 1) rows.push({ fields: input.row(index) });
    const result = await input.records.create(
      input.scope,
      input.tableId,
      input.access,
      { field_key_type: 'name', records: rows },
      seedAuditContext(input.actorId),
    );
    ids.push(...result.records.map((record) => record.id));
    input.onBatch?.(end);
  }
  return ids;
}
