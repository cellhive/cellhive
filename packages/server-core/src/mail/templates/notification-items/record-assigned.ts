import { formatCount, linkOr, nameOf, oneLine, quoted, text } from './shared.js';

import type { MailLocale } from '../../templates.js';
import type { Block } from '@cellhive/markdown';

/** One record of a `record.assigned` email: its primary field (when readable) and link. */
export interface AssignedRecordLine {
  /** Primary field as text; `null` = the recipient does not read it (shown untitled). */
  readonly title: string | null;
  readonly url: string | null;
}

/**
 * `record.assigned` in an email (T542, ADR-34 §2): "you were assigned N
 * records in «table»", then at most 20 records the recipient reads now
 * (primary field + link) and how many more, then the table link. From the
 * writes of an incoming webhook (T608, ADR-35 §6) the headline says so and
 * the records are listed even when there is one (the item is the table).
 */
export interface RecordAssignedEmailItem {
  readonly type: 'record.assigned';
  /** Records of the notification (`data.count`). */
  readonly count: number;
  /** Table name, when the recipient still reads the table. */
  readonly tableName: string | null;
  /** The records of `data.record_ids` the recipient reads now (at most 20). */
  readonly records: readonly AssignedRecordLine[];
  /** `data.source` is an incoming webhook (T608). */
  readonly viaWebhook?: boolean;
}

const TEXTS = {
  en: {
    one: (table: string | null) =>
      table === null
        ? 'You were assigned a record'
        : `You were assigned a record in ${quoted(table)}`,
    many: (count: string, table: string | null) =>
      table === null
        ? `You were assigned ${count} records`
        : `You were assigned ${count} records in ${quoted(table)}`,
    viaWebhook: (headline: string) => `${headline} via a webhook`,
    untitled: '(untitled record)',
    more: (count: string) => `And ${count} more`,
  },
  vi: {
    one: (table: string | null) =>
      table === null
        ? 'Bạn được gán một bản ghi'
        : `Bạn được gán một bản ghi trong ${quoted(table)}`,
    many: (count: string, table: string | null) =>
      table === null
        ? `Bạn được gán ${count} bản ghi`
        : `Bạn được gán ${count} bản ghi trong ${quoted(table)}`,
    viaWebhook: (headline: string) => `${headline} qua webhook`,
    untitled: '(bản ghi không có tiêu đề)',
    more: (count: string) => `Và ${count} bản ghi khác`,
  },
} as const satisfies Record<MailLocale, unknown>;

export function recordAssignedHeadline(item: RecordAssignedEmailItem, locale: MailLocale): string {
  const t = TEXTS[locale];
  const table = nameOf(item.tableName);
  const headline = item.count === 1 ? t.one(table) : t.many(formatCount(item.count, locale), table);
  return item.viaWebhook === true ? t.viaWebhook(headline) : headline;
}

/** The records list of a grouped assignment (a single one shows as the item's record). */
export function recordAssignedBlocks(item: RecordAssignedEmailItem, locale: MailLocale): Block[] {
  if (item.count === 1 && item.viaWebhook !== true) return [];
  return recordLinesBlocks(item.records, item.count, locale);
}

/**
 * At most 20 records (primary field + link) and "and N more" up to `total`:
 * the list of a grouped notification (`record.assigned`, and
 * `record.followed_changed` from a webhook — T608).
 */
export function recordLinesBlocks(
  records: readonly AssignedRecordLine[],
  total: number,
  locale: MailLocale,
): Block[] {
  const t = TEXTS[locale];
  const blocks: Block[] = [];
  if (records.length > 0) {
    blocks.push({
      type: 'list',
      ordered: false,
      items: records.map((record) => {
        const title = record.title === null ? '' : oneLine(record.title);
        return [...linkOr(record.url, [text(title === '' ? t.untitled : title)])];
      }),
    });
  }
  const more = total - records.length;
  if (more > 0) {
    blocks.push({ type: 'paragraph', children: [text(t.more(formatCount(more, locale)))] });
  }
  return blocks;
}
