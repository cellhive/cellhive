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
 * `record.followed_changed` (T545, CONTRACTS §22.1): changes to a record the
 * viewer follows, grouped per record over a minute. "«actor» changed
 * Status, Note on «record»" — `actor` is the latest person behind the
 * changes; the others of `actor_ids` are counted ("and 2 others"); more
 * than one change adds "3 changes". Only fields the viewer reads are named
 * (`field_ids` is already filtered per recipient; a field hidden since is
 * left out).
 *
 * Writes of an incoming webhook's runs (T608, `entity_type = table`,
 * `record_count`): "«actor» changed Status on 3 records you follow in
 * «table»", the changes and "Via an incoming webhook" in the body, the
 * records (≤ 20 of `record_count`) listed on demand as for a bulk assignment.
 */
export function describeRecordFollowedChanged(item: NotificationDto, ctx: ItemContext): ItemView {
  const fields = fieldList(strings(item, 'field_ids'), ctx);
  const actor = actorLabel(item, ctx);
  const actorIds = strings(item, 'actor_ids');
  const latestIsListed = item.actor?.type === 'user' && actorIds.includes(item.actor.id) ? 1 : 0;
  const others = Math.max(0, actorIds.length - latestIsListed);
  const who =
    others === 0
      ? actor
      : ctx.t('item.actorAndOthers', {
          actor,
          count: others,
          formatted: ctx.format.number(others),
        });
  const changes = int(item, 'change_count') ?? 1;
  const changesText =
    changes > 1
      ? ctx.t('item.followedChanges', { count: changes, formatted: ctx.format.number(changes) })
      : null;
  if (item.entity.type === 'table') {
    const recordIds = strings(item, 'record_ids');
    const count = int(item, 'record_count') ?? recordIds.length;
    const params = {
      actor: who,
      fields,
      count,
      formatted: ctx.format.number(count),
      table: quoted(item.entity.title, ctx, 'item.aTable'),
    };
    return {
      kind: 'followed',
      title:
        fields === null
          ? ctx.t('item.followedChangedRecords', params)
          : ctx.t('item.followedChangedRecordsFields', params),
      body: lines(changesText, hasWebhookSource(item) ? ctx.t('item.viaWebhook') : null),
      ...NO_EXTRAS,
      records: recordIds.length === 0 || item.base === null ? null : { ids: recordIds, count },
    };
  }
  const record = quoted(item.entity.title, ctx, 'item.aRecord');
  return {
    kind: 'followed',
    title:
      fields === null
        ? ctx.t('item.followedChanged', { actor: who, record })
        : ctx.t('item.followedChangedFields', { actor: who, record, fields }),
    body: changesText,
    ...NO_EXTRAS,
  };
}
