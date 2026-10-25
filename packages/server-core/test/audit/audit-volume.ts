import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { orgScope, type Db, type OrgScope, type Tx } from '../../src/db/index.js';

import type { Database } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

/**
 * Synthetic audit volume for the viewer's query plans and bench (T709),
 * written straight into `meta.audit_logs` with one `INSERT … SELECT`.
 */

/** Actor `i` (0-based) of an organization: `usr_<org suffix><i>`, 20 characters. */
export function actorOf(orgId: Id<'org'>, i: number): Id<'usr'> {
  return `usr_${orgId.slice(4, 14)}${String(i).padStart(6, '0')}`;
}

/** Share of each action (per mille) in the synthetic volume. */
export const VOLUME_ACTIONS: readonly (readonly [action: string, perMille: number])[] = [
  ['record.updated', 700],
  ['record.created', 100],
  ['record.deleted', 50],
  ['field.updated', 30],
  ['view.updated', 20],
  ['role.updated', 20],
  ['auth.login', 20],
  ['table.updated', 20],
  ['automation.run.succeeded', 20],
  ['audit.viewed', 20],
];

/** Monthly partitions from `monthsBack` months ago through next month. */
export async function createPartitions(db: Db, monthsBack: number): Promise<void> {
  await sql`
    SELECT meta.create_monthly_partition(
      'audit_logs',
      (date_trunc('month', now() AT TIME ZONE 'UTC') + m * interval '1 month')::date)
      FROM generate_series(${-monthsBack}::int, 1) AS m
  `.execute(db.kysely);
}

/**
 * `count` entries of `orgId` spread evenly over the last `days` days, by
 * `actors` user actors, in two bases (`baseIds`), actions per
 * `VOLUME_ACTIONS`, about 0.5 KB each.
 */
export async function insertAuditVolume(
  db: Db,
  input: {
    readonly orgId: Id<'org'>;
    readonly count: number;
    readonly actors: number;
    readonly days: number;
    readonly baseIds: readonly [Id<'bse'>, Id<'bse'>];
  },
): Promise<void> {
  const cases = sql.join(
    VOLUME_ACTIONS.map(([action], i) => {
      const upTo = VOLUME_ACTIONS.slice(0, i + 1).reduce((sum, [, share]) => sum + share, 0);
      return sql`WHEN (g::bigint * 7919) % 1000 < ${upTo} THEN ${action}`;
    }),
    sql` `,
  );
  const chunk = 200_000;
  for (let start = 0; start < input.count; start += chunk) {
    const end = Math.min(input.count, start + chunk);
    await sql`
      INSERT INTO meta.audit_logs
        (id, organization_id, base_id, table_id, actor_type, actor_id, action, entity_type,
         entity_id, batch_id, request_id, before, after, ip, user_agent, created_at)
      SELECT 'aud_' || substr(md5(${input.orgId} || g::text), 1, 16),
             ${input.orgId},
             CASE WHEN g % 2 = 0 THEN ${input.baseIds[0]} ELSE ${input.baseIds[1]} END,
             'tbl_' || substr(md5(${input.orgId} || (g % 20)::text), 1, 16),
             'user',
             'usr_' || substr(${input.orgId}, 5, 10) || lpad((g % ${input.actors})::text, 6, '0'),
             CASE ${cases} END,
             'record',
             'rec_' || substr(md5(${input.orgId} || (g % 50000)::text), 1, 16),
             'req_' || substr(md5(${input.orgId} || (g / 10)::text), 1, 16),
             'req_' || substr(md5(${input.orgId} || (g / 10)::text), 1, 16),
             jsonb_build_object('fld_' || substr(md5((g % 30)::text), 1, 16), g % 1000,
                                'fld_' || substr(md5((g % 7)::text), 1, 16), repeat('x', 120)),
             jsonb_build_object('fld_' || substr(md5((g % 30)::text), 1, 16), g % 997,
                                'fld_' || substr(md5((g % 7)::text), 1, 16), repeat('y', 120)),
             '203.0.113.7'::inet,
             'Mozilla/5.0 (bench) Cellhive/1.0',
             now() - (${input.days} * interval '1 day') * (g::double precision / ${input.count})
        FROM generate_series(${start}::int, ${end - 1}::int) AS g
    `.execute(db.kysely);
  }
}

export interface CapturedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/**
 * Runs `call` with a scope whose executor records the statements it runs,
 * so that a test can `EXPLAIN` exactly what a repository sent.
 */
export async function captureQueries(
  url: string,
  orgId: Id<'org'>,
  call: (scope: OrgScope) => Promise<unknown>,
): Promise<CapturedQuery[]> {
  const captured: CapturedQuery[] = [];
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const kysely = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === 'query') {
        captured.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });
  try {
    // A plain Kysely instance behaves like a transaction for the repository.
    await call(orgScope(orgId, kysely as unknown as Tx));
  } finally {
    await kysely.destroy();
  }
  return captured;
}

/** A sequential scan reading at most this many rows (a nearly empty partition) is fine. */
const SEQ_SCAN_ROWS = 1_000;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly PlanNode[];
}

export interface PlanSummary {
  /** Parent (partitioned) indexes the plan scans. */
  readonly indexes: string[];
  /** Partitions of `meta.audit_logs` the plan reads. */
  readonly partitions: string[];
  /** Whether a sequential scan reads more than `SEQ_SCAN_ROWS` rows of an audit partition. */
  readonly seqScan: boolean;
  readonly executionMs: number;
}

/**
 * `EXPLAIN (ANALYZE, FORMAT JSON)` of a captured query (same text, same
 * parameters, so the same custom plan), summarised.
 */
export async function explain(db: Db, url: string, query: CapturedQuery): Promise<PlanSummary> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let result: [{ Plan: PlanNode; 'Execution Time': number }];
  try {
    const { rows } = await client.query<{ 'QUERY PLAN': typeof result }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`,
      [...query.parameters],
    );
    result = rows[0]?.['QUERY PLAN'] as typeof result;
  } finally {
    await client.end();
  }
  const [{ Plan: plan, 'Execution Time': executionMs }] = result;
  const indexNames = new Set<string>();
  const partitions = new Set<string>();
  let seqScan = false;
  const walk = (node: PlanNode) => {
    const relation = node['Relation Name'];
    if (relation?.startsWith('audit_logs_p') === true) {
      partitions.add(relation);
      const read = (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0);
      if (node['Node Type'] === 'Seq Scan' && read > SEQ_SCAN_ROWS) seqScan = true;
    }
    if (node['Index Name'] !== undefined && relation?.startsWith('audit_logs_p') === true) {
      indexNames.add(node['Index Name']);
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  const parents = new Set<string>();
  for (const name of indexNames) {
    const { rows: parent } = await sql<{ name: string }>`
      SELECT p.relname AS name
        FROM pg_inherits AS i
        JOIN pg_class AS c ON c.oid = i.inhrelid
        JOIN pg_class AS p ON p.oid = i.inhparent
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'meta' AND c.relname = ${name}
    `.execute(db.kysely);
    parents.add(parent[0]?.name ?? name);
  }
  return {
    indexes: [...parents].sort(),
    partitions: [...partitions].sort(),
    seqScan,
    executionMs,
  };
}
