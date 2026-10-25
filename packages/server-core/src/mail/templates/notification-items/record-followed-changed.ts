import { recordLinesBlocks, type AssignedRecordLine } from './record-assigned.js';
import { formatCount } from './shared.js';

import type { MailLocale } from '../../templates.js';
import type { Block } from '@cellhive/markdown';

/**
 * `record.followed_changed` in an email (T542, ADR-34 §2): a fixed sentence
 * with the number of changes gathered; the record shows as the item's record
 * (primary field only, when readable) — never which values changed. From
 * the writes of an incoming webhook (T608, ADR-35 §6, one notification per
 * hook, table and minute): "N records you follow were changed via a webhook",
 * then the records the recipient reads now (at most 20) and how many more.
 */
export interface RecordFollowedChangedEmailItem {
  readonly type: 'record.followed_changed';
  readonly changeCount: number;
  /** `data.source` is an incoming webhook (T608). */
  readonly viaWebhook?: boolean;
  /** `data.record_count` (webhook only). */
  readonly recordCount?: number;
  /** The records of `data.record_ids` the recipient reads now (webhook only). */
  readonly records?: readonly AssignedRecordLine[];
}

const TEXTS = {
  en: {
    one: 'A record you follow was changed',
    many: (count: string) => `A record you follow was changed (${count} changes)`,
    hookOne: (changes: string | null) =>
      changes === null
        ? 'A record you follow was changed via a webhook'
        : `A record you follow was changed via a webhook (${changes} changes)`,
    hookMany: (records: string, changes: string) =>
      `${records} records you follow were changed via a webhook (${changes} changes)`,
  },
  vi: {
    one: 'Bản ghi bạn theo dõi đã thay đổi',
    many: (count: string) => `Bản ghi bạn theo dõi đã thay đổi (${count} thay đổi)`,
    hookOne: (changes: string | null) =>
      changes === null
        ? 'Bản ghi bạn theo dõi đã thay đổi qua webhook'
        : `Bản ghi bạn theo dõi đã thay đổi qua webhook (${changes} thay đổi)`,
    hookMany: (records: string, changes: string) =>
      `${records} bản ghi bạn theo dõi đã thay đổi qua webhook (${changes} thay đổi)`,
  },
} as const satisfies Record<MailLocale, unknown>;

export function recordFollowedChangedHeadline(
  item: RecordFollowedChangedEmailItem,
  locale: MailLocale,
): string {
  const t = TEXTS[locale];
  const changes = formatCount(item.changeCount, locale);
  if (item.viaWebhook === true) {
    const records = item.recordCount ?? 1;
    return records <= 1
      ? t.hookOne(item.changeCount <= 1 ? null : changes)
      : t.hookMany(formatCount(records, locale), changes);
  }
  return item.changeCount <= 1 ? t.one : t.many(changes);
}

/** The records of the webhook variant (nothing for one record's changes). */
export function recordFollowedChangedBlocks(
  item: RecordFollowedChangedEmailItem,
  locale: MailLocale,
): Block[] {
  if (item.viaWebhook !== true || item.records === undefined) return [];
  return recordLinesBlocks(item.records, item.recordCount ?? item.records.length, locale);
}
