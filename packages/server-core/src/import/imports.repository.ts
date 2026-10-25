import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../db/repository.js';

import type { Db } from '../db/create-db.js';
import type { ImportFileFormat, ImportRow, JsonObject } from '../db/schema.js';

export interface CreateImportInput {
  readonly id?: Id<'imp'>;
  readonly baseId: Id<'bse'>;
  readonly createdBy: Id<'usr'>;
  readonly filename: string;
  readonly format: ImportFileFormat;
  readonly size: number;
  readonly options: JsonObject;
  readonly expiresAt: Date;
}

/** Which upload a user may use: theirs, in this base, unused and not expired. */
export interface OwnedUploadRef {
  readonly id: Id<'imp'>;
  readonly baseId: Id<'bse'>;
  readonly userId: Id<'usr'>;
}

/**
 * `meta.imports` (migration 0010, BACKLOG T308): temporary uploads of the
 * CSV/XLSX import. Every query is scoped by `organization_id`: an upload of
 * another organization behaves exactly like a missing one. Permission
 * checks belong to the callers.
 */
export class ImportsRepository
  extends TenantRepository<'imports'>
  implements TenantRepositoryContract<ImportsRepository>
{
  constructor(db: Db) {
    super(db, 'imports');
  }

  async create(scope: OrgScope, input: CreateImportInput): Promise<ImportRow> {
    return this.executor(scope)
      .insertInto('meta.imports')
      .values({
        id: input.id ?? newId('imp'),
        organization_id: scope.organizationId,
        base_id: input.baseId,
        created_by: input.createdBy,
        filename: input.filename,
        format: input.format,
        size: input.size,
        options: input.options,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getById(scope: OrgScope, id: Id<'imp'>): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.imports')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The caller's own upload in the base, not used by an import and not expired. */
  async getUsable(scope: OrgScope, ref: OwnedUploadRef): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.imports')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', ref.id)
      .where('base_id', '=', ref.baseId)
      .where('created_by', '=', ref.userId)
      .where('job_id', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
  }

  /** The upload an import job used (`undefined` when none, or after cleanup). */
  async getByJob(scope: OrgScope, jobId: Id<'job'>): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.imports')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('job_id', '=', jobId)
      .executeTakeFirst();
  }

  /** Replaces the stored parse options (after a preview). */
  async setOptions(
    scope: OrgScope,
    id: Id<'imp'>,
    options: JsonObject,
  ): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.imports')
      .set({ options })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Merges keys into the stored options (e.g. the table an import created). */
  async mergeOptions(
    scope: OrgScope,
    id: Id<'imp'>,
    patch: JsonObject,
  ): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.imports')
      .set({ options: sql<JsonObject>`options || ${JSON.stringify(patch)}::jsonb` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Marks the upload as used by `jobId`, once: `undefined` when it is
   * missing, expired or already used (concurrent starts race here).
   */
  async claim(
    scope: OrgScope,
    ref: OwnedUploadRef,
    jobId: Id<'job'>,
  ): Promise<ImportRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.imports')
      .set({ job_id: jobId })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', ref.id)
      .where('base_id', '=', ref.baseId)
      .where('created_by', '=', ref.userId)
      .where('job_id', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returningAll()
      .executeTakeFirst();
  }

  async delete(scope: OrgScope, id: Id<'imp'>): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.imports')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
