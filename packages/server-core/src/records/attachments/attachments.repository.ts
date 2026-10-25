import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { AttachmentRow, AttachmentThumbnailStatus } from '../../db/schema.js';

/** Storage key of a new upload: `{organization_id}/{attachment_id}` (SPEC §16). */
export function attachmentObjectKey(organizationId: Id<'org'>, id: Id<'att'>): string {
  return `${organizationId}/${id}`;
}

/**
 * Storage key of a thumbnail (BACKLOG T407): `{object_key}_t<size>`, i.e.
 * `{organization_id}/{attachment_id}_t<size>` of the original upload. Copies
 * of a cell share the object, hence its thumbnails.
 */
export function attachmentThumbnailKey(objectKey: string, size: number): string {
  return `${objectKey}_t${String(size)}`;
}

export interface CreateAttachmentInput {
  readonly id?: Id<'att'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  /** The uploader; `null` for an anonymous upload through a form link (T410). */
  readonly createdBy: Id<'usr'> | null;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  /** Uploads through a form link (T410): the link and the submit token session. */
  readonly formUpload?: FormUploadSession | undefined;
}

/**
 * The session of an upload through a form link (BACKLOG T410, S4 open
 * question #14): the link and a hash of the submit token's nonce. A
 * submission binds only files of its own session.
 */
export interface FormUploadSession {
  readonly shareLinkId: Id<'shl'>;
  readonly session: string;
}

/** What a form link session uploaded so far (its limits, T410). */
export interface FormUploadUsage {
  /** Files per field. */
  readonly files: ReadonlyMap<string, number>;
  /** Announced bytes of every file of the session. */
  readonly bytes: number;
}

/**
 * `meta.attachments` (migration 0012, BACKLOG T406). Every query is scoped by
 * `organization_id`: an attachment of another organization behaves exactly
 * like a missing one. Permission checks belong to the callers
 * (`AttachmentCells` for cell writes, the file service for uploads and
 * downloads).
 */
export class AttachmentsRepository
  extends TenantRepository<'attachments'>
  implements TenantRepositoryContract<AttachmentsRepository>
{
  constructor(db: Db) {
    super(db, 'attachments');
  }

  /** A new upload (`pending_upload`, not attached) stored under its own key. */
  async create(scope: OrgScope, input: CreateAttachmentInput): Promise<AttachmentRow> {
    const id = input.id ?? newId('att');
    return this.executor(scope)
      .insertInto('meta.attachments')
      .values({
        id,
        organization_id: scope.organizationId,
        base_id: input.baseId,
        table_id: input.tableId,
        field_id: input.fieldId,
        object_key: attachmentObjectKey(scope.organizationId, id),
        filename: input.filename,
        mime: input.mime,
        size: input.size,
        created_by: input.createdBy,
        share_link_id: input.formUpload?.shareLinkId ?? null,
        upload_session: input.formUpload?.session ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Files of a form link session (T410): count per field and announced
   * bytes of every upload it made (finished or not), for its limits.
   */
  async formUploadUsage(scope: OrgScope, upload: FormUploadSession): Promise<FormUploadUsage> {
    const rows = await this.executor(scope)
      .selectFrom('meta.attachments')
      .select(['field_id', sql<bigint>`count(*)`.as('n'), sql<bigint>`sum(size)`.as('bytes')])
      .where('organization_id', '=', scope.organizationId)
      .where('share_link_id', '=', upload.shareLinkId)
      .where('upload_session', '=', upload.session)
      .groupBy('field_id')
      .execute();
    return {
      files: new Map(rows.map((row) => [row.field_id as string, Number(row.n)])),
      bytes: rows.reduce((total, row) => total + Number(row.bytes), 0),
    };
  }

  async getById(scope: OrgScope, id: Id<'att'>): Promise<AttachmentRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.attachments')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Rows by id (any state), without locking: what a reader checks before using files. */
  async getByIds(scope: OrgScope, ids: readonly string[]): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.attachments')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids] as Id<'att'>[])
      .execute();
  }

  /** Rows by id, locked `FOR UPDATE` (in id order) when the scope has a transaction. */
  async lockByIds(scope: OrgScope, ids: readonly string[]): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    const query = this.executor(scope)
      .selectFrom('meta.attachments')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids] as Id<'att'>[])
      .orderBy('id');
    return scope.tx === undefined ? query.execute() : query.forUpdate().execute();
  }

  /**
   * `pending_upload` → `ready` with the size and SHA-256 `complete` checked;
   * `undefined` when the row is missing or not pending (a concurrent call won).
   */
  async markReady(
    scope: OrgScope,
    id: Id<'att'>,
    result: {
      readonly size: number;
      readonly sha256: string;
      /** `pending` when a `file.thumbnail` job is enqueued with it (T407). */
      readonly thumbnailStatus?: 'pending' | null;
    },
  ): Promise<AttachmentRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.attachments')
      .set({
        status: 'ready',
        size: result.size,
        sha256: result.sha256,
        thumbnail_status: result.thumbnailStatus ?? null,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('status', '=', 'pending_upload')
      .returningAll()
      .executeTakeFirst();
  }

  /** Puts files into the cell of `recordId` (new uploads, or files detached from it earlier). */
  async attach(scope: OrgScope, ids: readonly Id<'att'>[], recordId: Id<'rec'>): Promise<void> {
    if (ids.length === 0) return;
    await this.executor(scope)
      .updateTable('meta.attachments')
      .set({ record_id: recordId, detached_at: null })
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('record_purged_at', 'is', null)
      .execute();
  }

  /** Marks files removed from the cell of `recordId` (kept for undo, CONTRACTS §20). */
  async detach(
    scope: OrgScope,
    ids: readonly Id<'att'>[],
    recordId: Id<'rec'>,
    at: Date,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.executor(scope)
      .updateTable('meta.attachments')
      .set({ detached_at: at })
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .where('record_id', '=', recordId)
      .where('detached_at', 'is', null)
      .execute();
  }

  /**
   * Files of records of `tableId` permanently deleted (T408): marked
   * `record_purged_at` (and detached), so the next `attachments.cleanup`
   * deletes the rows, then each object nobody else references. Returns the
   * rows marked.
   */
  async markRecordsPurged(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    recordIds: readonly Id<'rec'>[],
    at: Date,
  ): Promise<number> {
    if (recordIds.length === 0) return 0;
    const result = await this.executor(scope)
      .updateTable('meta.attachments')
      .set({ record_purged_at: at, detached_at: sql<Date>`coalesce(detached_at, ${at})` })
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('record_id', 'in', [...recordIds])
      .where('record_purged_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Every file of a purged table (T461): marked `record_purged_at` (and
   * detached), so `attachments.cleanup` deletes the rows, then each object
   * no row of another table still references. Returns the rows marked.
   */
  async markTablePurged(scope: OrgScope, tableId: Id<'tbl'>, at: Date): Promise<number> {
    const result = await this.executor(scope)
      .updateTable('meta.attachments')
      .set({ record_purged_at: at, detached_at: sql<Date>`coalesce(detached_at, ${at})` })
      .where('organization_id', '=', scope.organizationId)
      .where('table_id', '=', tableId)
      .where('record_purged_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * A copy of `source` for another record of the same table and field
   * (BACKLOG S4 open question #12): a new id, the same object.
   */
  async copyTo(
    scope: OrgScope,
    source: AttachmentRow,
    target: { readonly recordId: Id<'rec'>; readonly createdBy: Id<'usr'> | null },
  ): Promise<AttachmentRow> {
    return this.executor(scope)
      .insertInto('meta.attachments')
      .values({
        id: newId('att'),
        organization_id: scope.organizationId,
        base_id: source.base_id,
        table_id: source.table_id,
        field_id: source.field_id,
        record_id: target.recordId,
        object_key: source.object_key,
        filename: source.filename,
        mime: source.mime,
        size: Number(source.size),
        sha256: source.sha256,
        status: source.status,
        // The thumbnails belong to the shared object (T407).
        thumbnail_status: source.thumbnail_status,
        thumbnail_started_at: source.thumbnail_started_at,
        created_by: target.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Sets the thumbnail state of every row sharing `objectKey` (copies,
   * BACKLOG T407), only where the current state is one of `from` when
   * given. `running` records `startedAt`; other states clear it. Returns the
   * number of rows changed.
   */
  async setThumbnailStatus(
    scope: OrgScope,
    objectKey: string,
    status: AttachmentThumbnailStatus,
    options: {
      readonly from?: readonly AttachmentThumbnailStatus[];
      readonly startedAt?: Date;
    } = {},
  ): Promise<number> {
    let query = this.executor(scope)
      .updateTable('meta.attachments')
      .set({
        thumbnail_status: status,
        thumbnail_started_at: status === 'running' ? (options.startedAt ?? new Date()) : null,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('object_key', '=', objectKey);
    if (options.from !== undefined) {
      if (options.from.length === 0) return 0;
      query = query.where('thumbnail_status', 'in', [...options.from]);
    }
    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Thumbnails of the organization being rendered now (distinct objects in
   * `running` started after `since`): the count of the per-organization cap
   * of `file.thumbnail` (ADR-18). Older `running` rows are renders a worker
   * crash interrupted; they do not hold a slot.
   */
  async countRunningThumbnails(scope: OrgScope, since: Date): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.attachments')
      .select(sql<bigint>`count(DISTINCT object_key)`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('thumbnail_status', '=', 'running')
      .where('thumbnail_started_at', '>', since)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Among `ids`, the rows the cleanup may delete, locked `FOR UPDATE`: never
   * attached and created before `unattachedBefore`, detached before
   * `detachedBefore`, of a purged record (T408) or of a purged field (same rule as
   * `listExpiredAttachments`, re-checked under the lock).
   */
  async lockExpired(
    scope: OrgScope,
    ids: readonly Id<'att'>[],
    cutoffs: { readonly unattachedBefore: Date; readonly detachedBefore: Date },
  ): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    return this.executor(scope)
      .selectFrom('meta.attachments as a')
      .selectAll('a')
      .where('a.organization_id', '=', scope.organizationId)
      .where('a.id', 'in', [...ids])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('a.record_id', 'is', null),
            eb('a.created_at', '<', cutoffs.unattachedBefore),
          ]),
          eb('a.detached_at', '<', cutoffs.detachedBefore),
          eb('a.record_purged_at', 'is not', null),
          eb.exists(
            eb
              .selectFrom('meta.fields as f')
              .select('f.id')
              .whereRef('f.id', '=', 'a.field_id')
              .where('f.organization_id', '=', scope.organizationId)
              .where('f.purged_at', 'is not', null),
          ),
        ]),
      )
      .orderBy('a.id')
      .forUpdate('a')
      .execute();
  }

  /** Rows referencing `objectKey` other than `excluding` (reference count of a shared object). */
  async countOtherReferences(
    scope: OrgScope,
    objectKey: string,
    excluding: readonly Id<'att'>[],
  ): Promise<number> {
    let query = this.executor(scope)
      .selectFrom('meta.attachments')
      .select(sql<bigint>`count(*)`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('object_key', '=', objectKey);
    if (excluding.length > 0) query = query.where('id', 'not in', [...excluding]);
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async deleteByIds(scope: OrgScope, ids: readonly Id<'att'>[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.executor(scope)
      .deleteFrom('meta.attachments')
      .where('organization_id', '=', scope.organizationId)
      .where('id', 'in', [...ids])
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
