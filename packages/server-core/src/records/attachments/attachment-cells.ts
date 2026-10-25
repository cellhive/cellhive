import { attachmentIdsOf, attachmentRefOf, type AttachmentRef } from '@cellhive/field-types';

import { AttachmentsRepository, type FormUploadSession } from './attachments.repository.js';

import type { Db } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { AttachmentRow, JsonValue } from '../../db/schema.js';
import type { Id, ProblemErrorItem } from '@cellhive/contracts';

/** Looks up an attachment usable in a cell of `fieldId` (see {@link AttachmentCells.lookup}). */
export type AttachmentLookup = (fieldId: Id<'fld'>, id: string) => AttachmentRef | undefined;

/** One attachment cell of a write, in storage form. `after` may be rewritten by `bind`. */
export interface AttachmentCellWrite {
  readonly recordId: Id<'rec'>;
  readonly fieldId: Id<'fld'>;
  /** Stored value before the write (`null` for a new record). */
  readonly before: JsonValue;
  /** Stored value the write sets. */
  after: JsonValue;
  /** `path` of an error about this cell (`records[i].fields.<key>`). */
  readonly path: string;
}

export interface BindContext {
  readonly tableId: Id<'tbl'>;
  /** The user behind the write (`null`: system, automation, anonymous): only they bind their uploads. */
  readonly writer: Id<'usr'> | null;
  readonly now: Date;
  /** Ids among `ids` of live records the caller can read (copy sources). */
  readonly readableRecordIds: (ids: readonly Id<'rec'>[]) => Promise<ReadonlySet<string>>;
  /**
   * A submission through a form link (T410): new files must be uploads of
   * this session (link + submit token), whoever the writer is; files of
   * other records are never copied.
   */
  readonly formUpload?: FormUploadSession | undefined;
}

const notFound = (path: string, id: string): ProblemErrorItem => ({
  path,
  code: 'ATTACHMENT_NOT_FOUND',
  message: 'No usable attachment with this id',
  params: { id },
});

function refOf(row: AttachmentRow): AttachmentRef {
  return { id: row.id, name: row.filename, size: Number(row.size), mime: row.mime };
}

function refsOf(value: JsonValue): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.map(attachmentRefOf).filter((ref): ref is AttachmentRef => ref !== null);
}

/**
 * A new upload the write may bind: through a form link (T410), an upload of
 * the submission's own session; otherwise the writer's own upload made as a
 * member (never one made through a form link).
 */
function ownsUpload(row: AttachmentRow, context: BindContext): boolean {
  const session = context.formUpload;
  if (session !== undefined) {
    return row.share_link_id === session.shareLinkId && row.upload_session === session.session;
  }
  return (
    context.writer !== null && row.created_by === context.writer && row.upload_session === null
  );
}

/**
 * Keeps `meta.attachments` in step with `attachment` cells written by
 * `RecordMutationService` (BACKLOG T406), in the mutation's transaction:
 *
 * - `lookup`: before values are converted, the ids a request names are
 *   loaded (and locked); only `ready` files of the same table and field
 *   resolve, everything else is `ATTACHMENT_NOT_FOUND` — another
 *   organization, table or field, an unfinished upload and a missing id are
 *   indistinguishable;
 * - `bind`, once the target records are known: a file new to a cell must be
 *   the caller's own upload not attached yet, a file detached from this
 *   same cell earlier (undo, history revert), or a file of another record
 *   the caller can read (paste, duplicate), which becomes a **new** row
 *   sharing the object (BACKLOG S4 open question #12) — its id in `after`
 *   is replaced. Files that leave a cell are marked detached (kept 30 days).
 */
export class AttachmentCells {
  private readonly repository: AttachmentsRepository;

  constructor(db: Db) {
    this.repository = new AttachmentsRepository(db);
  }

  /** Ids of every attachment a set of write values names. */
  static idsOf(values: Iterable<unknown>): string[] {
    const ids = new Set<string>();
    for (const value of values) for (const id of attachmentIdsOf(value)) ids.add(id);
    return [...ids];
  }

  async lookup(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ids: readonly string[],
  ): Promise<AttachmentLookup> {
    const rows = new Map(
      (await this.repository.lockByIds(scope, ids)).map((row) => [row.id as string, row]),
    );
    return (fieldId, id) => {
      const row = rows.get(id);
      if (row?.table_id !== tableId || row.field_id !== fieldId || row.status !== 'ready') {
        return undefined;
      }
      return refOf(row);
    };
  }

  /** Applies `writes`; returns the cells that name files the caller may not use. */
  async bind(
    scope: OrgScope,
    writes: readonly AttachmentCellWrite[],
    context: BindContext,
  ): Promise<ProblemErrorItem[]> {
    const added = writes.map((write) => {
      const before = new Set(refsOf(write.before).map((ref) => ref.id));
      return refsOf(write.after).filter((ref) => !before.has(ref.id));
    });
    const rows = new Map(
      (
        await this.repository.lockByIds(
          scope,
          added.flatMap((refs) => refs.map((ref) => ref.id)),
        )
      ).map((row) => [row.id as string, row]),
    );
    const usable = (row: AttachmentRow | undefined): row is AttachmentRow =>
      row?.table_id === context.tableId && row.status === 'ready';
    // Copy sources: attachments of other records, readable by the caller.
    const sources = new Set<Id<'rec'>>();
    writes.forEach((write, position) => {
      for (const ref of added[position] ?? []) {
        const row = rows.get(ref.id);
        if (usable(row) && row.record_id !== null && row.record_id !== write.recordId) {
          sources.add(row.record_id);
        }
      }
    });
    const readable = await context.readableRecordIds([...sources]);

    const issues: ProblemErrorItem[] = [];
    /** Files bound by this call: attaching one again copies it without another check. */
    const boundHere = new Set<string>();
    for (const [position, write] of writes.entries()) {
      const replacements = new Map<string, AttachmentRef>();
      const attach: Id<'att'>[] = [];
      for (const ref of added[position] ?? []) {
        const row = rows.get(ref.id);
        if (!usable(row) || row.field_id !== write.fieldId) {
          issues.push(notFound(write.path, ref.id));
          continue;
        }
        if (row.record_id === write.recordId && !boundHere.has(row.id)) {
          attach.push(row.id); // back into its own cell (undo, revert)
          continue;
        }
        const fresh = row.record_id === null && !boundHere.has(row.id);
        if (fresh) {
          if (!ownsUpload(row, context)) {
            issues.push(notFound(write.path, ref.id));
            continue;
          }
          attach.push(row.id);
          boundHere.add(row.id);
          continue;
        }
        const allowed =
          boundHere.has(row.id) ||
          (context.formUpload === undefined &&
            row.record_id !== null &&
            readable.has(row.record_id));
        if (!allowed) {
          issues.push(notFound(write.path, ref.id));
          continue;
        }
        const copy = await this.repository.copyTo(scope, row, {
          recordId: write.recordId,
          createdBy: context.writer,
        });
        replacements.set(row.id, refOf(copy));
      }
      if (issues.length > 0) continue;
      await this.repository.attach(scope, attach, write.recordId);
      for (const id of attach) {
        const row = rows.get(id);
        if (row !== undefined) rows.set(id, { ...row, record_id: write.recordId });
      }
      if (replacements.size > 0 && Array.isArray(write.after)) {
        write.after = write.after.map((entry) => {
          const ref = attachmentRefOf(entry);
          const replaced = ref === null ? undefined : replacements.get(ref.id);
          return replaced === undefined ? entry : { ...replaced };
        });
      }
      const kept = new Set(refsOf(write.after).map((ref) => ref.id));
      const removed = refsOf(write.before)
        .map((ref) => ref.id as Id<'att'>)
        .filter((id) => !kept.has(id));
      await this.repository.detach(scope, removed, write.recordId, context.now);
    }
    return issues;
  }
}
