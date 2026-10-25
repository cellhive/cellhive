import { NOTIFICATION_DATA_SCHEMAS } from '@cellhive/contracts';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import { createFormatters } from '../../../lib/i18n/format';
import { assignedRecordRows } from '../model/records';
import { reportDownloadUrl } from '../model/report';
import {
  describeNotification,
  fieldIdsOf,
  needsTableName,
  reminderStatus,
  type ItemContext,
  type ItemView,
} from '../model/types';

import type { NotificationDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

/**
 * T552: the renderer of each notification type (FRONTEND §14.1), with the
 * real en/vi strings. Data shapes follow CONTRACTS §22.1 (checked against
 * the contract's schemas below).
 */

const BASE = { id: 'bse_aaaaaaaaaaaaaaaa', name: 'Sales' } as const;
const TABLE = 'tbl_aaaaaaaaaaaaaaaa';
const REC = 'rec_aaaaaaaaaaaaaaaa';
const OWNER = 'fld_owner00000000000';
const REVIEW = 'fld_review0000000000';
const STATUS = 'fld_status0000000000';
const NOTE = 'fld_note000000000000';
const HIDDEN = 'fld_hidden0000000000';
const DUE = 'fld_due0000000000000';
const ZONE = 'Asia/Ho_Chi_Minh';
const NOW = new Date('2026-10-17T03:00:00.000Z'); // 10:00 in Ho Chi Minh City

const FIELD_NAMES: Record<string, string> = {
  [OWNER]: 'Owner',
  [REVIEW]: 'Reviewers',
  [STATUS]: 'Status',
  [NOTE]: 'Note',
  [DUE]: 'Due',
};

function notification(overrides: Partial<NotificationDto>): NotificationDto {
  return {
    id: 'ntf_aaaaaaaaaaaaaaaa',
    type: 'record.assigned',
    base: BASE,
    table_id: TABLE,
    entity: { type: 'record', id: REC, title: 'Order R1' },
    actor: { type: 'user', id: 'usr_editor0000000000', name: 'Lan' },
    data: {},
    read_at: null,
    created_at: '2026-10-17T02:59:00.000Z',
    ...overrides,
  };
}

const languages: Record<'en' | 'vi', I18n> = {} as Record<'en' | 'vi', I18n>;

beforeAll(async () => {
  languages.en = await createTestI18n('en');
  languages.vi = await createTestI18n('vi');
});

function context(language: 'en' | 'vi', extra: Partial<ItemContext> = {}): ItemContext {
  const i18n = languages[language];
  const t = i18n.getFixedT(language, 'notifications');
  return {
    t: (key, options) => (options === undefined ? t(key) : t(key, options)),
    locale: language,
    format: createFormatters(language, ZONE),
    fieldName: (id) => FIELD_NAMES[id] ?? null,
    tableName: null,
    now: NOW,
    ...extra,
  };
}

function view(
  item: NotificationDto,
  language: 'en' | 'vi' = 'en',
  extra: Partial<ItemContext> = {},
): ItemView {
  return describeNotification(item, context(language, extra));
}

describe('record.assigned (T544)', () => {
  const single = notification({
    data: { batch_id: null, count: 1, record_ids: [REC], field_ids: [OWNER] },
  });
  const bulk = notification({
    entity: { type: 'table', id: TABLE, title: 'Orders' },
    data: {
      batch_id: 'req_1',
      count: 200,
      record_ids: Array.from(
        { length: 20 },
        (_, index) => `rec_${String(index).padStart(16, '0')}`,
      ),
      field_ids: [OWNER, REVIEW],
    },
  });

  it('keeps to the stored data shape of the contract', () => {
    expect(NOTIFICATION_DATA_SCHEMAS['record.assigned'].safeParse(single.data).success).toBe(true);
    expect(NOTIFICATION_DATA_SCHEMAS['record.assigned'].safeParse(bulk.data).success).toBe(true);
  });

  it.each([
    ['en', single, 'Lan assigned you to «Order R1» · Owner', null],
    ['vi', single, 'Lan đã giao cho bạn «Order R1» · Owner', null],
    ['en', bulk, 'Lan assigned you 200 records in «Orders»', 'Through Owner and Reviewers'],
    ['vi', bulk, 'Lan đã giao cho bạn 200 bản ghi trong «Orders»', 'Qua trường Owner và Reviewers'],
  ] as const)('%s: %s', (language, item, title, body) => {
    const result = view(item, language);
    expect(result.kind).toBe('assigned');
    expect(result.title).toBe(title);
    expect(result.body).toBe(body);
  });

  it('lists the records of a bulk write only (≤ 20 of count)', () => {
    expect(view(single).records).toBeNull();
    expect(view(bulk).records).toEqual({ ids: bulk.data['record_ids'], count: 200 });
    // No base: nothing to open, nothing to list.
    expect(view({ ...bulk, base: null }).records).toBeNull();
  });

  it.each([
    [
      'an automation, a field no longer readable, the record without title',
      notification({
        actor: { type: 'automation', id: 'aut_a', name: null },
        entity: { type: 'record', id: REC, title: null },
        data: { batch_id: null, count: 1, record_ids: [REC], field_ids: [HIDDEN] },
      }),
      'An automation assigned you to a record',
    ],
    [
      'a user who left the organization (no name)',
      notification({
        actor: { type: 'user', id: 'usr_gone', name: null },
        data: { batch_id: null, count: 1, record_ids: [REC], field_ids: [OWNER] },
      }),
      'Someone assigned you to «Order R1» · Owner',
    ],
    [
      'a bulk write of one record of a table the viewer cannot see',
      notification({
        entity: { type: 'table', id: TABLE, title: null },
        data: { batch_id: 'b', count: 1, record_ids: [REC], field_ids: [OWNER] },
      }),
      'Lan assigned you 1 record in a table',
    ],
  ])('%s', (_name, item, title) => {
    expect(view(item).title).toBe(title);
  });

  it('names at most three fields, counts the others', () => {
    const many = notification({
      data: {
        batch_id: null,
        count: 1,
        record_ids: [REC],
        field_ids: [OWNER, REVIEW, STATUS, NOTE, DUE],
      },
    });
    expect(view(many).title).toBe(
      'Lan assigned you to «Order R1» · Owner, Reviewers, Status, and 2 more',
    );
  });
});

describe('record.followed_changed (T545)', () => {
  const item = (data: Record<string, unknown>, ...actor: [NotificationDto['actor']] | []) =>
    notification({
      type: 'record.followed_changed',
      ...(actor.length === 0 ? {} : { actor: actor[0] }),
      data,
    });

  it.each([
    [
      'one change by one person',
      item({ field_ids: [STATUS], change_count: 1, actor_ids: ['usr_editor0000000000'] }),
      'en',
      'Lan changed Status on «Order R1»',
      null,
    ],
    [
      'three changes by three people',
      item({
        field_ids: [STATUS, NOTE],
        change_count: 3,
        actor_ids: ['usr_other10000000000', 'usr_editor0000000000', 'usr_other20000000000'],
      }),
      'en',
      'Lan and 2 others changed Status and Note on «Order R1»',
      '3 changes',
    ],
    [
      'Vietnamese',
      item({
        field_ids: [STATUS, NOTE],
        change_count: 2,
        actor_ids: ['usr_other10000000000', 'usr_editor0000000000'],
      }),
      'vi',
      'Lan và 1 người khác đã sửa Status và Note trên «Order R1»',
      '2 lần thay đổi',
    ],
    [
      'by an automation; only hidden fields left',
      item(
        { field_ids: [HIDDEN], change_count: 1, actor_ids: [] },
        { type: 'automation', id: 'aut_a', name: null },
      ),
      'en',
      'An automation changed «Order R1»',
      null,
    ],
  ] as const)('%s', (_name, notificationItem, language, title, body) => {
    expect(
      NOTIFICATION_DATA_SCHEMAS['record.followed_changed'].safeParse(notificationItem.data).success,
    ).toBe(true);
    const result = view(notificationItem, language);
    expect(result.kind).toBe('followed');
    expect(result.title).toBe(title);
    expect(result.body).toBe(body);
  });
});

describe('incoming webhook writes (T608)', () => {
  const HOOK = 'hok_aaaaaaaaaaaaaaaa';
  const automation = { type: 'automation', id: 'aut_aaaaaaaaaaaaaaaa', name: null } as const;
  const ids = Array.from({ length: 20 }, (_, index) => `rec_${String(index).padStart(16, '0')}`);
  const assigned = notification({
    actor: automation,
    entity: { type: 'table', id: TABLE, title: 'Orders' },
    data: {
      batch_id: null,
      count: 200,
      record_ids: ids,
      field_ids: [REVIEW],
      source: { incoming_webhook_id: HOOK },
    },
  });
  const followed = (recordCount: number, changes: number, fieldIds: readonly string[]) =>
    notification({
      type: 'record.followed_changed',
      actor: automation,
      entity: { type: 'table', id: TABLE, title: 'Orders' },
      data: {
        field_ids: fieldIds,
        change_count: changes,
        actor_ids: [],
        record_ids: ids.slice(0, Math.min(20, recordCount)),
        record_count: recordCount,
        source: { incoming_webhook_id: HOOK },
      },
    });

  it('keeps to the stored data shape of the contract', () => {
    expect(NOTIFICATION_DATA_SCHEMAS['record.assigned'].safeParse(assigned.data).success).toBe(
      true,
    );
    expect(
      NOTIFICATION_DATA_SCHEMAS['record.followed_changed'].safeParse(
        followed(23, 30, [STATUS]).data,
      ).success,
    ).toBe(true);
  });

  it.each([
    [
      'en',
      assigned,
      'An automation assigned you 200 records in «Orders»',
      'Through Reviewers\nVia an incoming webhook',
    ],
    [
      'vi',
      assigned,
      'Một automation đã giao cho bạn 200 bản ghi trong «Orders»',
      'Qua trường Reviewers\nQua webhook nhận',
    ],
    [
      'en',
      followed(23, 30, [STATUS, NOTE]),
      'An automation changed Status and Note on 23 records you follow in «Orders»',
      '30 changes\nVia an incoming webhook',
    ],
    [
      'en',
      followed(1, 1, [HIDDEN]),
      'An automation changed 1 record you follow in «Orders»',
      'Via an incoming webhook',
    ],
    [
      'vi',
      followed(3, 5, [STATUS]),
      'Một automation đã sửa Status trên 3 bản ghi bạn theo dõi trong «Orders»',
      '5 lần thay đổi\nQua webhook nhận',
    ],
  ] as const)('%s: %s', (language, item, title, body) => {
    const result = view(item, language);
    expect(result.title).toBe(title);
    expect(result.body).toBe(body);
  });

  it('lists the records (≤ 20 of record_count) on demand', () => {
    expect(view(assigned).records).toEqual({ ids, count: 200 });
    expect(view(followed(23, 30, [STATUS])).records).toEqual({ ids, count: 23 });
    expect(view({ ...followed(23, 30, [STATUS]), base: null }).records).toBeNull();
  });
});

describe('date.reminder (T547)', () => {
  const reminder = (value: string, dueAt: string) =>
    notification({
      type: 'date.reminder',
      actor: null,
      data: { field_id: DUE, due_at: dueAt, value },
    });
  const format = createFormatters('en', ZONE);

  it.each([
    ['date-only, tomorrow', '2026-10-18', 'upcoming'],
    ['date-only, today in the viewer zone (UTC is still the 17th)', '2026-10-17', 'today'],
    ['date-only, yesterday', '2026-10-16', 'overdue'],
    ['instant in an hour', '2026-10-17T04:00:00.000Z', 'upcoming'],
    ['instant a minute ago', '2026-10-17T02:59:00.000Z', 'overdue'],
  ] as const)('status: %s', (_name, value, status) => {
    expect(reminderStatus(value, NOW, ZONE)).toBe(status);
  });

  it('upcoming instant: value and reminder time in the viewer zone, with the zone', () => {
    const item = reminder('2026-10-18T02:00:00.000Z', '2026-10-17T02:00:00.000Z');
    expect(NOTIFICATION_DATA_SCHEMAS['date.reminder'].safeParse(item.data).success).toBe(true);
    const result = view(item);
    expect(result.kind).toBe('reminder');
    expect(result.title).toBe(
      `«Order R1»: «Due» is due at ${format.dateTime('2026-10-18T02:00:00.000Z')}`,
    );
    // 02:00 UTC is 09:00 in Ho Chi Minh City.
    expect(result.title).toContain('9:00');
    expect(result.body).toBe(`Reminder of ${format.dateTime('2026-10-17T02:00:00.000Z')} (GMT+7)`);
    expect(result.pill).toEqual({ label: 'Upcoming', tone: 'neutral' });
  });

  it('overdue instant at its own time: no second time', () => {
    const result = view(reminder('2026-10-17T02:00:00.000Z', '2026-10-17T02:00:00.000Z'), 'vi');
    expect(result.title).toBe(
      `«Order R1» đã quá hạn «Due» lúc ${createFormatters('vi', ZONE).dateTime('2026-10-17T02:00:00.000Z')}`,
    );
    expect(result.body).toBeNull();
    expect(result.pill).toEqual({ label: 'Quá hạn', tone: 'danger' });
  });

  it('date-only today: the calendar day, never shifted by a zone', () => {
    const result = view(reminder('2026-10-17', '2026-10-17T02:00:00.000Z'));
    expect(result.title).toBe('«Order R1»: «Due» is due today');
    expect(result.pill).toEqual({ label: 'Due today', tone: 'warning' });
    const tomorrow = view(reminder('2026-10-18', '2026-10-17T02:00:00.000Z'), 'en', {
      // A viewer far west: the 18th must still read Oct 18.
      format: createFormatters('en', 'America/Los_Angeles'),
      now: NOW,
    });
    expect(tomorrow.title).toBe('«Order R1»: «Due» is due on Oct 18, 2026');
  });

  it('field no longer readable: no field name', () => {
    const result = view(reminder('2026-10-16', '2026-10-16T02:00:00.000Z'), 'en', {
      fieldName: () => null,
    });
    expect(result.title).toBe('«Order R1» was due on Oct 16, 2026');
  });
});

describe('import.finished (T548)', () => {
  const imported = (data: Record<string, unknown>) =>
    notification({
      type: 'import.finished',
      entity: { type: 'job', id: 'job_aaaaaaaaaaaaaaaa', title: null },
      data: { job_id: 'job_aaaaaaaaaaaaaaaa', ...data },
    });

  it.each([
    [
      'succeeded with failed rows: the report',
      { status: 'succeeded', created: 12, updated: 3, failed_rows: 1 },
      'en',
      'Orders',
      'Import into «Orders» finished',
      '12 created · 3 updated · 1 row failed',
      'importSucceeded',
      true,
    ],
    [
      'succeeded, nothing failed: no report',
      { status: 'succeeded', created: 1000, updated: 0, failed_rows: 0 },
      'vi',
      'Đơn hàng',
      'Nhập dữ liệu vào «Đơn hàng» đã xong',
      '1.000 tạo mới · 0 cập nhật',
      'importSucceeded',
      false,
    ],
    [
      'failed, table not visible',
      { status: 'failed', created: 0, updated: 0, failed_rows: 4 },
      'en',
      null,
      'Import failed',
      '0 created · 0 updated · 4 rows failed',
      'importFailed',
      false,
    ],
    [
      'cancelled',
      { status: 'cancelled', created: 5, updated: 1, failed_rows: 0 },
      'vi',
      'Đơn hàng',
      'Nhập dữ liệu vào «Đơn hàng» đã bị huỷ',
      '5 tạo mới · 1 cập nhật',
      'importCancelled',
      false,
    ],
  ] as const)('%s', (_name, data, language, tableName, title, body, kind, report) => {
    const item = imported(data);
    expect(NOTIFICATION_DATA_SCHEMAS['import.finished'].safeParse(item.data).success).toBe(true);
    const result = view(item, language, { tableName });
    expect(result.title).toBe(title);
    expect(result.body).toBe(body);
    expect(result.kind).toBe(kind);
    expect(result.report).toEqual(report ? { jobId: 'job_aaaaaaaaaaaaaaaa' } : null);
  });

  it('asks for the table name only when it can open it', () => {
    expect(needsTableName(imported({ status: 'succeeded' }))).toBe(true);
    expect(needsTableName({ ...imported({ status: 'succeeded' }), table_id: null })).toBe(false);
    expect(needsTableName({ ...imported({ status: 'succeeded' }), base: null })).toBe(false);
  });
});

describe('automation types', () => {
  it.each([
    [
      'batch overflow with skipped (QA L6)',
      notification({
        type: 'automation.batch_overflow',
        entity: { type: 'automation', id: 'aut_a', title: 'Sync' },
        data: {
          automation_id: 'aut_a',
          run_id: 'run_a',
          batch_id: 'b',
          limit: 1000,
          skipped: 4000,
        },
      }),
      'en',
      'Automation «Sync» skipped records of a bulk change',
      '4,000 records of the batch got no run. It runs at most 1,000 times for one batch of changes.',
    ],
    [
      'batch overflow, skipped unknown (automation not visible)',
      notification({
        type: 'automation.batch_overflow',
        entity: { type: 'automation', id: 'aut_a', title: null },
        data: {
          automation_id: 'aut_a',
          run_id: 'run_a',
          batch_id: 'b',
          limit: 1000,
          skipped: null,
        },
      }),
      'vi',
      'Một automation bỏ qua bản ghi của một thay đổi hàng loạt',
      'Automation chạy tối đa 1.000 lần cho một lô thay đổi.',
    ],
    [
      'message',
      notification({
        type: 'automation.message',
        data: { automation_id: 'aut_a', run_id: 'run_a', title: 'Paid', body: 'Order paid' },
      }),
      'en',
      'Paid',
      'Order paid',
    ],
    [
      'disabled',
      notification({
        type: 'automation.disabled',
        entity: { type: 'automation', id: 'aut_a', title: 'Sync' },
        data: { automation_id: 'aut_a', reason: 'circuit_breaker' },
      }),
      'en',
      'Automation «Sync» turned itself off',
      'Its runs failed 50 times in a row, or it was triggered more than 100 times in a minute.',
    ],
    [
      'a type without a renderer yet',
      notification({ type: 'comment.mentioned', data: {} }),
      'vi',
      'Thông báo mới',
      null,
    ],
  ] as const)('%s', (_name, item, language, title, body) => {
    const result = view(item, language);
    expect(result.title).toBe(title);
    expect(result.body).toBe(body);
  });
});

describe('fieldIdsOf', () => {
  it.each([
    ['record.assigned', { field_ids: [OWNER] }, [OWNER]],
    ['record.followed_changed', { field_ids: [STATUS, NOTE] }, [STATUS, NOTE]],
    ['date.reminder', { field_id: DUE }, [DUE]],
    ['import.finished', { job_id: 'job_a' }, []],
    ['automation.message', {}, []],
  ] as const)('%s', (type, data, ids) => {
    expect(fieldIdsOf(notification({ type, data }))).toEqual(ids);
  });
});

describe('assignedRecordRows', () => {
  it('keeps the notification order, drops unreadable records, titles by primary text', () => {
    expect(
      assignedRecordRows(
        ['rec_1', 'rec_2', 'rec_3', 'rec_4'],
        [
          { id: 'rec_3', fields: { fld_p: 'Third' } },
          { id: 'rec_1', fields: { fld_p: 'First' } },
          { id: 'rec_4', fields: { fld_p: '  ' } },
        ],
        'fld_p',
      ),
    ).toEqual([
      { id: 'rec_1', title: 'First' },
      { id: 'rec_3', title: 'Third' },
      { id: 'rec_4', title: null },
    ]);
    expect(assignedRecordRows(['rec_1'], [{ id: 'rec_1', fields: {} }], null)).toEqual([
      { id: 'rec_1', title: null },
    ]);
  });
});

describe('reportDownloadUrl', () => {
  const now = new Date('2026-10-17T03:00:00.000Z');
  it.each([
    [
      'available',
      {
        status: 'succeeded',
        result: {
          download_url: '/api/v1/files/exports/job_a',
          expires_at: '2026-10-18T00:00:00.000Z',
        },
      },
      '/api/v1/files/exports/job_a',
    ],
    [
      'expired',
      {
        status: 'succeeded',
        result: {
          download_url: '/api/v1/files/exports/job_a',
          expires_at: '2026-10-17T02:00:00.000Z',
        },
      },
      null,
    ],
    ['deleted by the cleanup', { status: 'succeeded', result: { file_deleted: true } }, null],
    ['not finished', { status: 'running', result: null }, null],
    [
      'not a path of this origin',
      { status: 'succeeded', result: { download_url: 'https://evil.example/x' } },
      null,
    ],
  ] as const)('%s', (_name, job, url) => {
    expect(reportDownloadUrl(job, now)).toBe(url);
  });
});
