import { sql, type Kysely } from 'kysely';

/** Oldest supported server: PostgreSQL 18.0 (ADR-0019). */
export const MIN_SERVER_VERSION_NUM = 180_000;

/** Thrown at startup when the server is older than PostgreSQL 18. */
export class UnsupportedPostgresVersionError extends Error {
  readonly serverVersion: string;
  readonly serverVersionNum: number;

  constructor(serverVersion: string, serverVersionNum: number) {
    super(
      `PostgreSQL ${serverVersion} is not supported: Cellhive requires PostgreSQL 18 or newer ` +
        `(server_version_num ${String(serverVersionNum)} < ${String(MIN_SERVER_VERSION_NUM)}). ` +
        'Upgrade the database server (see docs/adr/0019-postgresql-18.md).',
    );
    this.name = 'UnsupportedPostgresVersionError';
    this.serverVersion = serverVersion;
    this.serverVersionNum = serverVersionNum;
  }
}

export interface PostgresVersion {
  /** e.g. `18.1 (Debian 18.1-1.pgdg13+2)` */
  readonly version: string;
  /** e.g. `180001` */
  readonly versionNum: number;
}

export async function readPostgresVersion<DB>(db: Kysely<DB>): Promise<PostgresVersion> {
  const { rows } = await sql<{ version: string; version_num: string }>`
    SELECT current_setting('server_version') AS version,
           current_setting('server_version_num') AS version_num
  `.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error('server version query returned no row');
  return { version: row.version, versionNum: Number.parseInt(row.version_num, 10) };
}

/**
 * Checks `server_version_num >= 180000` (SPEC §19, ADR-0019). Called once at
 * startup of every server process; throws `UnsupportedPostgresVersionError`
 * with a message meant for the operator.
 */
export async function assertSupportedPostgres<DB>(db: Kysely<DB>): Promise<PostgresVersion> {
  const version = await readPostgresVersion(db);
  if (!(version.versionNum >= MIN_SERVER_VERSION_NUM)) {
    throw new UnsupportedPostgresVersionError(version.version, version.versionNum);
  }
  return version;
}
