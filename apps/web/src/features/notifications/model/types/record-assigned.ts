import {
  actorLabel,
  fieldList,
  hasWebhookSource,
  int,
  lines,
  NO_EXTRAS,
  quoted,
  strings,
  type ItemContext,
  type ItemView,
} from './shared';

import type { NotificationDto } from '@cellhive/contracts';

/**
 * `record.assigned` (T544, CONTRACTS §22.1): the viewer was added to a
 * `user` field with `notify_on_assign`.
 *
 * - One write (`entity_type = record`): "«actor» assigned you to «record» ·
 *   Owner"; the item opens the record.
 * - A bulk write (`entity_type = table`, grouped per `batch.id`): "«actor»
 *   assigned you 200 records in «table»"; the item opens the table and
 *   lists up to 20 of the records (`record_ids`) on demand — the board's
 *   "list in the popover" option: there is no URL filter on record ids.
 * - Writes of an incoming webhook's runs (T608, `data.source`): grouped per
 *   hook, table and minute like a bulk write; the body adds "Via an
 *   incoming webhook".
 *
 * Field names are the ones the viewer still reads now; none → no field part.
 */
export function describeRecordAssigned(item: NotificationDto, ctx: ItemContext): ItemView {
  const fields = fieldList(strings(item, 'field_ids'), ctx);
  const actor = actorLabel(item, ctx);
  const recordIds = strings(item, 'record_ids');
  if (item.entity.type === 'table') {
    const count = int(item, 'count') ?? recordIds.length;
    return {
      kind: 'assigned',
      title: ctx.t('item.assignedBulk', {
        actor,
        count,
        formatted: ctx.format.number(count),
        table: quoted(item.entity.title, ctx, 'item.aTable'),
      }),
      body: lines(
        fields === null ? null : ctx.t('item.assignedFields', { fields }),
        hasWebhookSource(item) ? ctx.t('item.viaWebhook') : null,
      ),
      ...NO_EXTRAS,
      records: recordIds.length === 0 || item.base === null ? null : { ids: recordIds, count },
    };
  }
  const record = quoted(item.entity.title, ctx, 'item.aRecord');
  return {
    kind: 'assigned',
    title:
      fields === null
        ? ctx.t('item.assigned', { actor, record })
        : ctx.t('item.assignedVia', { actor, record, fields }),
    body: null,
    ...NO_EXTRAS,
  };
}
