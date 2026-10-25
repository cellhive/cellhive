import {
  ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES,
  ATTACHMENT_THUMBNAIL_SIZES,
  attachmentHasThumbnail,
  idOf,
} from '@cellhive/contracts';
import {
  acquireOrgSlot,
  AttachmentsRepository,
  attachmentThumbnailKey,
  deferrableJob,
  orgScope,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';
import { z } from 'zod';

import { readAtMost, renderThumbnails } from '../thumbnails/render-thumbnails.js';

import type { Task } from 'graphile-worker';
import type { Logger } from 'pino';

/** Thumbnails rendered at once per organization (ADR-18 `acquireOrgSlot`). */
export const FILE_THUMBNAIL_ORG_CAP = 2;
/** Lock kind of the per-organization cap. */
export const FILE_THUMBNAIL_SLOT_KIND = 'file.thumbnail';
/**
 * A `running` render older than this does not hold a slot: its worker
 * stopped (a render never takes this long, libvips gives up after 30 s).
 */
export const FILE_THUMBNAIL_STALE_MS = 2 * 60 * 1000;

const payloadSchema = z.object({
  organization_id: idOf('org'),
  attachment_id: idOf('att'),
});

export interface FileThumbnailDeps {
  readonly db: Db;
  readonly storage: Pick<StorageDriver, 'getStream' | 'put' | 'delete'>;
  readonly logger: Logger;
  readonly now?: () => Date;
  /** Sizes rendered; default `ATTACHMENT_THUMBNAIL_SIZES`. */
  readonly sizes?: readonly number[];
}

/**
 * `file.thumbnail` (BACKLOG T407, CONTRACTS §12.2, §20): enqueued by
 * `POST /files/uploads/:id/complete` for PNG, JPEG, GIF and WebP files up to
 * 50 MB. At most `FILE_THUMBNAIL_ORG_CAP` renders of one organization run at
 * a time (others are deferred, ADR-18), so a burst of uploads never holds
 * the workers of another organization.
 *
 * Reads the object, renders one WebP per size with `sharp`
 * (`renderThumbnails`: decompression-bomb guard, raster formats only) and
 * stores them as `{object_key}_t<size>` from the server; every row sharing
 * the object (copies) becomes `ready`. An image that cannot be rendered is
 * `skipped` and the attachment stays `ready` (no retry); a storage error is
 * retried by graphile-worker (`failed` meanwhile). A job for a file already
 * rendered, skipped or gone completes without work. Logs carry ids, sizes
 * and durations — never file names, keys or URLs.
 */
export function createFileThumbnailTask(deps: FileThumbnailDeps): Task<'file.thumbnail'> {
  const repository = new AttachmentsRepository(deps.db);
  const sizes = deps.sizes ?? ATTACHMENT_THUMBNAIL_SIZES;
  const now = deps.now ?? (() => new Date());
  return async (payload, helpers) => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.error({ job_id: helpers.job.id }, 'file.thumbnail: malformed payload, skipped');
      return;
    }
    const data = parsed.data;
    const scope = orgScope(data.organization_id);
    const context = { org_id: data.organization_id, attachment_id: data.attachment_id };
    const job = await deferrableJob(helpers);

    const claim = await deps.db.withTx(async (tx) => {
      const txScope = orgScope(data.organization_id, tx);
      const row = await repository.getById(txScope, data.attachment_id);
      if (
        row?.status !== 'ready' ||
        !attachmentHasThumbnail(row.mime, Number(row.size)) ||
        (row.thumbnail_status !== 'pending' &&
          row.thumbnail_status !== 'running' &&
          row.thumbnail_status !== 'failed')
      ) {
        return { state: 'skip' as const };
      }
      const started = now();
      const slot = await acquireOrgSlot(tx, {
        orgId: data.organization_id,
        kind: FILE_THUMBNAIL_SLOT_KIND,
        cap: FILE_THUMBNAIL_ORG_CAP,
        countRunning: (lockTx, orgId) =>
          repository.countRunningThumbnails(
            orgScope(orgId, lockTx),
            new Date(started.getTime() - FILE_THUMBNAIL_STALE_MS),
          ),
        job,
      });
      if (!slot.acquired) return { state: 'deferred' as const };
      await repository.setThumbnailStatus(txScope, row.object_key, 'running', {
        startedAt: started,
      });
      return { state: 'run' as const, objectKey: row.object_key };
    });
    if (claim.state !== 'run') {
      deps.logger.debug({ ...context, state: claim.state }, 'file.thumbnail: not run now');
      return;
    }

    const started = Date.now();
    const { objectKey } = claim;
    try {
      const stream = await deps.storage.getStream(objectKey);
      if (stream === null) {
        // The file was deleted meanwhile (cleanup): nothing to render.
        await repository.setThumbnailStatus(scope, objectKey, 'skipped');
        deps.logger.info({ ...context, reason: 'missing' }, 'file.thumbnail skipped');
        return;
      }
      const input = await readAtMost(stream, ATTACHMENT_THUMBNAIL_MAX_INPUT_BYTES);
      const rendered =
        input === null
          ? ({ ok: false, reason: 'too_large' } as const)
          : await renderThumbnails(input, sizes);
      if (!rendered.ok) {
        await repository.setThumbnailStatus(scope, objectKey, 'skipped');
        deps.logger.info(
          { ...context, reason: rendered.reason, duration_ms: Date.now() - started },
          'file.thumbnail skipped',
        );
        return;
      }
      for (const thumbnail of rendered.thumbnails) {
        await deps.storage.put(attachmentThumbnailKey(objectKey, thumbnail.size), thumbnail.data, {
          contentType: 'image/webp',
        });
      }
      if ((await repository.setThumbnailStatus(scope, objectKey, 'ready')) === 0) {
        // Every row of the object was deleted meanwhile (cleanup): no orphans.
        for (const thumbnail of rendered.thumbnails) {
          await deps.storage.delete(attachmentThumbnailKey(objectKey, thumbnail.size));
        }
        deps.logger.info({ ...context, reason: 'deleted' }, 'file.thumbnail skipped');
        return;
      }
      deps.logger.info(
        {
          ...context,
          sizes: rendered.thumbnails.map((thumbnail) => thumbnail.size),
          bytes: rendered.thumbnails.reduce((sum, thumbnail) => sum + thumbnail.data.length, 0),
          input_bytes: input?.length ?? 0,
          duration_ms: Date.now() - started,
        },
        'file.thumbnail rendered',
      );
    } catch (error) {
      // Storage or database trouble: graphile-worker retries the job.
      await repository.setThumbnailStatus(scope, objectKey, 'failed');
      // Only the error's name and code: storage messages may hold the object key.
      deps.logger.warn(
        {
          ...context,
          error: error instanceof Error ? error.name : 'unknown',
          code: (error as { code?: unknown } | null)?.code,
          attempts: helpers.job.attempts,
        },
        'file.thumbnail failed',
      );
      throw error;
    }
  };
}
