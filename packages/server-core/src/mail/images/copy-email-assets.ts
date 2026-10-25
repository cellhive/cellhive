import type { EmailAssetsRepository } from './email-assets.repository.js';
import type { OrgScope } from '../../db/repository.js';
import type { EmailAssetRow } from '../../db/schema.js';
import type { StorageDriver } from '../../storage/storage-driver.js';
import type { Id } from '@cellhive/contracts';

/** Email images copied for a duplicated automation, not attached to it yet. */
export interface StagedEmailAssetCopies {
  /** Source asset id → id of its copy. */
  readonly mapping: ReadonlyMap<Id<'att'>, Id<'att'>>;
  /** The copies, in the order of the sources. */
  readonly ids: readonly Id<'att'>[];
  /**
   * Deletes the copies — each object, then the rows — when the duplicate
   * is not saved. Best effort: `false` when something could not be deleted
   * (the `attachments.cleanup` cron deletes it 24 hours later, since
   * nothing references a staged copy).
   */
  discard(): Promise<boolean>;
}

export type StageEmailAssetCopiesResult =
  | { readonly ok: true; readonly staged: StagedEmailAssetCopies }
  /** The object of a source is gone from storage: nothing was kept. */
  | { readonly ok: false; readonly missing: Id<'att'> };

export interface StageEmailAssetCopiesDeps {
  readonly assets: Pick<EmailAssetsRepository, 'insertCopy' | 'deleteByIds'>;
  readonly storage: Pick<StorageDriver, 'getStream' | 'putStream' | 'delete'>;
}

/**
 * Copies the email images `sources` (body images of the automation being
 * duplicated, BACKLOG T551) inside the same organization: for each one, a
 * new `ready` row under its own id and key (`insertCopy`, committed, of no
 * automation yet), then its object, streamed from the source's key through
 * the storage driver (never across organizations: both keys are
 * `{organization_id}/{id}` of the scope's organization).
 *
 * The row comes first so that whatever happens next — a storage error, the
 * duplicate's transaction failing, the process dying — the copy is a row
 * nothing references, which `attachments.cleanup` deletes with its object
 * 24 hours after its creation; the caller attaches the copies to the new
 * automation in the transaction that creates it (`attachCopies`) and calls
 * `discard` when that transaction fails. On a failure here, what was staged
 * is discarded before the error is rethrown.
 *
 * `scope` must not carry a transaction (the rows must survive a rollback of
 * the caller). Logs nothing.
 */
export async function stageEmailAssetCopies(
  deps: StageEmailAssetCopiesDeps,
  scope: OrgScope,
  input: { readonly sources: readonly EmailAssetRow[]; readonly createdBy: Id<'usr'> },
): Promise<StageEmailAssetCopiesResult> {
  const copies: EmailAssetRow[] = [];
  const mapping = new Map<Id<'att'>, Id<'att'>>();
  const discard = async (): Promise<boolean> => {
    let clean = true;
    for (const copy of copies) {
      try {
        await deps.storage.delete(copy.object_key);
        await deps.assets.deleteByIds(scope, [copy.id]);
      } catch {
        clean = false;
      }
    }
    return clean;
  };
  try {
    for (const source of input.sources) {
      if (mapping.has(source.id)) continue;
      const copy = await deps.assets.insertCopy(scope, source, input.createdBy);
      copies.push(copy);
      const stream = await deps.storage.getStream(source.object_key);
      if (stream === null) {
        await discard();
        return { ok: false, missing: source.id };
      }
      await deps.storage.putStream(copy.object_key, stream, {
        contentType: source.mime,
        contentLength: Number(source.size),
      });
      mapping.set(source.id, copy.id);
    }
  } catch (error) {
    await discard();
    throw error;
  }
  return {
    ok: true,
    staged: { mapping, ids: copies.map((copy) => copy.id), discard },
  };
}
