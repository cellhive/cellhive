import { int, quoted, str, type ItemContext, type ItemView } from './shared';

import type { ItemKind } from '../items';
import type { NotificationDto } from '@cellhive/contracts';

type Status = 'succeeded' | 'failed' | 'cancelled';

const KIND: Record<Status, ItemKind> = {
  succeeded: 'importSucceeded',
  failed: 'importFailed',
  cancelled: 'importCancelled',
};

function statusOf(item: NotificationDto): Status {
  const status = str(item, 'status');
  return status === 'failed' || status === 'cancelled' ? status : 'succeeded';
}

/**
 * `import.finished` (T548, CONTRACTS §22.1, §19): "Import into «table»
 * finished / failed / was cancelled" (the table's name when the viewer
 * still sees it — the API has no title for jobs), the counts ("12 created
 * · 3 updated · 1 row failed") and, when rows failed on a finished import,
 * the error report (downloaded through `GET /jobs/:id`: only its creator,
 * within 24 hours — the panel says so when it is gone). Opens the table.
 */
export function describeImportFinished(item: NotificationDto, ctx: ItemContext): ItemView {
  const status = statusOf(item);
  const table = ctx.tableName === null ? null : quoted(ctx.tableName, ctx, 'item.aTable');
  const created = int(item, 'created') ?? 0;
  const updated = int(item, 'updated') ?? 0;
  const failed = int(item, 'failed_rows') ?? 0;
  const counts = [
    ctx.t('item.importCreated', { count: created, formatted: ctx.format.number(created) }),
    ctx.t('item.importUpdated', { count: updated, formatted: ctx.format.number(updated) }),
    ...(failed > 0
      ? [ctx.t('item.importFailedRows', { count: failed, formatted: ctx.format.number(failed) })]
      : []),
  ];
  const jobId = str(item, 'job_id');
  return {
    kind: KIND[status],
    title:
      table === null
        ? ctx.t(`item.import.${status}`)
        : ctx.t(`item.import.${status}Table`, { table }),
    body: counts.join(' · '),
    // The title says the status; the icon differs per status too.
    pill: null,
    records: null,
    report: status === 'succeeded' && failed > 0 && jobId !== null ? { jobId } : null,
  };
}
