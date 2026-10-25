import { formatCount, linkOr, nameOf, quoted, text } from './shared.js';

import type { MailLocale } from '../../templates.js';
import type { ImportFinishedStatus } from '@cellhive/contracts';
import type { Block } from '@cellhive/markdown';

/**
 * `import.finished` in an email (T542, T548, ADR-34 §4): how the import into
 * a table ended, with its counts; links to the table, and to the report of
 * the rows that failed while the recipient may still download it.
 */
export interface ImportFinishedEmailItem {
  readonly type: 'import.finished';
  readonly status: ImportFinishedStatus;
  /** Name of the table imported into, when the recipient still reads it. */
  readonly tableName: string | null;
  readonly created: number;
  readonly updated: number;
  readonly failedRows: number;
  /**
   * The CSV report of the rows that failed (`PUBLIC_URL/api/v1/files/exports/job_…`,
   * CONTRACTS §19), only when the recipient can download it when the email
   * is sent: they ran the import and the report has not expired.
   */
  readonly reportUrl?: string | null;
}

type Counts = { readonly created: string; readonly updated: string; readonly failed: string };

const TEXTS = {
  en: {
    into: (table: string | null) =>
      table === null ? 'Your import' : `Import into ${quoted(table)}`,
    succeeded: (subject: string, n: Counts) =>
      `${subject} finished: ${n.created} created, ${n.updated} updated, ${n.failed} rows failed`,
    failed: (subject: string) => `${subject} failed`,
    cancelled: (subject: string) => `${subject} was cancelled`,
    report: 'Download the report of the rows that failed (available for 24 hours)',
  },
  vi: {
    into: (table: string | null) =>
      table === null ? 'Lần nhập dữ liệu của bạn' : `Nhập dữ liệu vào ${quoted(table)}`,
    succeeded: (subject: string, n: Counts) =>
      `${subject} đã xong: ${n.created} tạo mới, ${n.updated} cập nhật, ${n.failed} dòng lỗi`,
    failed: (subject: string) => `${subject} thất bại`,
    cancelled: (subject: string) => `${subject} đã bị huỷ`,
    report: 'Tải báo cáo các dòng lỗi (có trong 24 giờ)',
  },
} as const satisfies Record<MailLocale, unknown>;

export function importFinishedHeadline(item: ImportFinishedEmailItem, locale: MailLocale): string {
  const t = TEXTS[locale];
  const subject = t.into(nameOf(item.tableName));
  switch (item.status) {
    case 'succeeded':
      return t.succeeded(subject, {
        created: formatCount(item.created, locale),
        updated: formatCount(item.updated, locale),
        failed: formatCount(item.failedRows, locale),
      });
    case 'failed':
      return t.failed(subject);
    case 'cancelled':
      return t.cancelled(subject);
  }
}

/** The link to the report of the rows that failed, when there is one to download (T548). */
export function importFinishedBlocks(item: ImportFinishedEmailItem, locale: MailLocale): Block[] {
  const url = item.reportUrl ?? null;
  if (url === null || item.failedRows === 0) return [];
  const children = linkOr(url, [text(TEXTS[locale].report)]);
  // Without a usable link the sentence alone would mislead: leave it out.
  if (children[0]?.type !== 'link') return [];
  return [{ type: 'paragraph', children: [...children] }];
}
