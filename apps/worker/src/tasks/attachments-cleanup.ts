import {
  ATTACHMENT_DETACHED_RETENTION_DAYS,
  ATTACHMENT_THUMBNAIL_SIZES,
  ATTACHMENT_UNATTACHED_TTL_HOURS,
  EMAIL_ASSET_UNUSED_TTL_HOURS,
  FORM_COVER_UNUSED_TTL_HOURS,
  type Id,
} from '@cellhive/contracts';
import {
  uploadStagingKey,
  AttachmentsRepository,
  attachmentThumbnailKey,
  EmailAssetsRepository,
  FormCoversRepository,
  listExpiredAttachments,
  listExpiredEmailAssets,
  listExpiredFormCovers,
  orgScope,
  withTxScope,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Attachment rows handled per batch. */
export const ATTACHMENT_CLEANUP_BATCH = 200;

const HOUR_MS = 60 * 60 * 1000;

export interface AttachmentsCleanupDeps {
  readonly db: Db;
  readonly storage: Pick<StorageDriver, 'delete'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/**
 * `attachments.cleanup` (hourly cron, CONTRACTS §20; BACKLOG T406): deletes
 * uploads never written to a cell after 24 hours, files removed from their
 * cell after 30 days, and files of purged fields. Per organization and
 * batch, in one transaction: the rows are locked and re-checked, each
 * object is deleted once no other row shares it (copies, BACKLOG S4 #12),
 * with its thumbnails (T407: every size, whether rendered or not — deleting
 * a missing object succeeds), then the rows. A storage failure rolls the batch back for the next run
 * (deleting an object twice is harmless). Storage keys come from meta only.
 * Then (T419) form covers no form view names, 24 hours after their upload
 * (row and object, re-checked under the row lock), and (T534) email images
 * no signature or automation body references, 24 hours after their upload.
 * Logs counts only.
 */
export function createAttachmentsCleanupTask(
  deps: AttachmentsCleanupDeps,
): Task<'attachments.cleanup'> {
  const batchSize = deps.batchSize ?? ATTACHMENT_CLEANUP_BATCH;
  const repository = new AttachmentsRepository(deps.db);
  const covers = new FormCoversRepository(deps.db);
  const emailAssets = new EmailAssetsRepository(deps.db);
  return async () => {
    const started = Date.now();
    const now = deps.now?.() ?? new Date();
    const unattachedBefore = new Date(now.getTime() - ATTACHMENT_UNATTACHED_TTL_HOURS * HOUR_MS);
    const detachedBefore = new Date(
      now.getTime() - ATTACHMENT_DETACHED_RETENTION_DAYS * 24 * HOUR_MS,
    );
    let rows = 0;
    let objects = 0;
    const seen = new Set<string>();
    for (;;) {
      const expired = (
        await listExpiredAttachments(deps.db.kysely, {
          unattachedBefore,
          detachedBefore,
          limit: batchSize,
        })
      ).filter((item) => !seen.has(item.id));
      if (expired.length === 0) break;
      const byOrg = new Map<Id<'org'>, Id<'att'>[]>();
      for (const item of expired) {
        seen.add(item.id);
        byOrg.set(item.organizationId, [...(byOrg.get(item.organizationId) ?? []), item.id]);
      }
      for (const [organizationId, ids] of byOrg) {
        const result = await deps.db.withTx(async (tx) => {
          const scope = withTxScope(orgScope(organizationId), tx);
          // Re-checked under the row locks: a file may have been attached meanwhile.
          const locked = await repository.lockExpired(scope, ids, {
            unattachedBefore,
            detachedBefore,
          });
          const doomed = locked.map((row) => row.id);
          let deletedObjects = 0;
          for (const key of new Set(locked.map((row) => row.object_key))) {
            if ((await repository.countOtherReferences(scope, key, doomed)) === 0) {
              await deps.storage.delete(key);
              // A never-completed upload, or a PUT URL replayed after `complete`.
              await deps.storage.delete(uploadStagingKey(key));
              for (const size of ATTACHMENT_THUMBNAIL_SIZES) {
                await deps.storage.delete(attachmentThumbnailKey(key, size));
              }
              deletedObjects += 1;
            }
          }
          return { rows: await repository.deleteByIds(scope, doomed), objects: deletedObjects };
        });
        rows += result.rows;
        objects += result.objects;
      }
      if (expired.length < batchSize) break;
    }
    const coverRows = await deleteUnusedCovers(
      deps,
      covers,
      new Date(now.getTime() - FORM_COVER_UNUSED_TTL_HOURS * HOUR_MS),
      batchSize,
    );
    const emailAssetRows = await deleteUnusedEmailAssets(
      deps,
      emailAssets,
      new Date(now.getTime() - EMAIL_ASSET_UNUSED_TTL_HOURS * HOUR_MS),
      batchSize,
    );
    deps.logger.info(
      {
        rows,
        objects,
        covers: coverRows,
        email_assets: emailAssetRows,
        duration_ms: Date.now() - started,
      },
      'expired attachments deleted',
    );
  };
}

/**
 * Email images (T534) nothing references any more — no signature, no
 * automation body says `asset:<id>` — uploaded before `createdBefore`: per
 * organization and batch, locked and re-checked (a signature may have
 * started using one meanwhile), the object deleted, then the row. Returns
 * the rows deleted.
 */
async function deleteUnusedEmailAssets(
  deps: AttachmentsCleanupDeps,
  assets: EmailAssetsRepository,
  createdBefore: Date,
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  const seen = new Set<string>();
  for (;;) {
    const expired = (
      await listExpiredEmailAssets(deps.db.kysely, { createdBefore, limit: batchSize })
    ).filter((item) => !seen.has(item.id));
    if (expired.length === 0) break;
    const byOrg = new Map<Id<'org'>, Id<'att'>[]>();
    for (const item of expired) {
      seen.add(item.id);
      byOrg.set(item.organizationId, [...(byOrg.get(item.organizationId) ?? []), item.id]);
    }
    for (const [organizationId, ids] of byOrg) {
      deleted += await deps.db.withTx(async (tx) => {
        const scope = withTxScope(orgScope(organizationId), tx);
        const locked = await assets.lockUnreferenced(scope, ids, createdBefore);
        for (const row of locked) {
          await deps.storage.delete(row.object_key);
          await deps.storage.delete(uploadStagingKey(row.object_key));
        }
        return assets.deleteByIds(
          scope,
          locked.map((row) => row.id),
        );
      });
    }
    if (expired.length < batchSize) break;
  }
  return deleted;
}

/**
 * Form covers (T419) no form view names, uploaded before `createdBefore`:
 * per organization and batch, locked and re-checked (a view may have named
 * one meanwhile), the object deleted, then the row. Returns the rows deleted.
 */
async function deleteUnusedCovers(
  deps: AttachmentsCleanupDeps,
  covers: FormCoversRepository,
  createdBefore: Date,
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  const seen = new Set<string>();
  for (;;) {
    const expired = (
      await listExpiredFormCovers(deps.db.kysely, { createdBefore, limit: batchSize })
    ).filter((item) => !seen.has(item.id));
    if (expired.length === 0) break;
    const byOrg = new Map<Id<'org'>, Id<'att'>[]>();
    for (const item of expired) {
      seen.add(item.id);
      byOrg.set(item.organizationId, [...(byOrg.get(item.organizationId) ?? []), item.id]);
    }
    for (const [organizationId, ids] of byOrg) {
      deleted += await deps.db.withTx(async (tx) => {
        const scope = withTxScope(orgScope(organizationId), tx);
        const locked = await covers.lockUnused(scope, ids, createdBefore);
        for (const row of locked) {
          await deps.storage.delete(row.object_key);
          await deps.storage.delete(uploadStagingKey(row.object_key));
        }
        return covers.deleteByIds(
          scope,
          locked.map((row) => row.id),
        );
      });
    }
    if (expired.length < batchSize) break;
  }
  return deleted;
}
