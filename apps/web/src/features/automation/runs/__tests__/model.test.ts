import { describe, expect, it } from 'vitest';

import { plainValue, stepOutputView, warningsOf } from '../model/output';
import {
  batchOverflowOf,
  canCancel,
  canRerun,
  elapsedMs,
  FAST_POLL_MS,
  fromOf,
  hasActiveRerun,
  parseRunFilter,
  parseRunRange,
  pollIntervalOf,
  SLOW_POLL_MS,
  statusesOf,
  timelineOf,
} from '../model/runs';

import type {
  AutomationDefinition,
  AutomationRunStatus,
  AutomationRunStepDto,
} from '@cellhive/contracts';

const NOW = new Date('2026-10-06T12:00:00.000Z');

describe('filters ⇄ URL', () => {
  it.each([
    [null, 'all', undefined],
    ['failed', 'failed', ['failed']],
    ['active', 'active', ['queued', 'running', 'waiting']],
    // T614: runs waiting for a Wait step or an HTTP delivery only.
    ['waiting', 'waiting', ['waiting']],
    ['succeeded', 'succeeded', ['succeeded']],
    ['nonsense', 'all', undefined],
  ] as const)('status %s → %s', (value, filter, statuses) => {
    expect(parseRunFilter(value)).toBe(filter);
    expect(statusesOf(parseRunFilter(value))).toEqual(statuses);
  });

  it.each([
    [null, '7d', '2026-09-29T12:00:00.000Z'],
    ['24h', '24h', '2026-10-05T12:00:00.000Z'],
    ['30d', '30d', '2026-09-06T12:00:00.000Z'],
    ['all', 'all', undefined],
    ['1y', '7d', '2026-09-29T12:00:00.000Z'],
  ] as const)('range %s → %s from %s', (value, range, from) => {
    expect(parseRunRange(value)).toBe(range);
    expect(fromOf(parseRunRange(value), NOW)).toBe(from);
  });
});

describe('polling and actions', () => {
  it.each([
    [[], false],
    [['succeeded', 'failed'], false],
    [['succeeded', 'waiting'], SLOW_POLL_MS],
    [['waiting', 'queued'], FAST_POLL_MS],
    [['running'], FAST_POLL_MS],
  ] as [AutomationRunStatus[], number | false][])('%j → %s', (statuses, interval) => {
    expect(pollIntervalOf(statuses)).toBe(interval);
  });

  it.each([
    ['queued', false, true],
    ['running', false, false],
    ['waiting', false, true],
    ['succeeded', false, false],
    ['failed', true, false],
    ['skipped', false, false],
    ['cancelled', true, false],
  ] as [AutomationRunStatus, boolean, boolean][])(
    '%s: re-run %s, cancel %s',
    (status, rerun, cancel) => {
      expect(canRerun({ status })).toBe(rerun);
      expect(canCancel({ status })).toBe(cancel);
    },
  );

  it('blocks a re-run while another re-run has not ended', () => {
    expect(hasActiveRerun([{ status: 'succeeded' }, { status: 'failed' }])).toBe(false);
    expect(hasActiveRerun([{ status: 'failed' }, { status: 'queued' }])).toBe(true);
  });

  it('measures elapsed time', () => {
    expect(elapsedMs('2026-10-06T12:00:00.000Z', '2026-10-06T12:00:01.400Z')).toBe(1400);
    expect(elapsedMs('2026-10-06T12:00:00.000Z', null)).toBeNull();
    expect(elapsedMs('2026-10-06T12:00:02.000Z', '2026-10-06T12:00:01.000Z')).toBeNull();
  });
});

function step(
  actionId: string,
  overrides: Partial<AutomationRunStepDto> = {},
): AutomationRunStepDto {
  return {
    id: `stp_${actionId}`,
    action_id: actionId,
    action_type: null,
    status: 'succeeded',
    attempt: 1,
    started_at: NOW.toISOString(),
    finished_at: NOW.toISOString(),
    reused: false,
    output: null,
    redacted: false,
    error: null,
    ...overrides,
  };
}

describe('timeline of a run', () => {
  const definition = {
    actions: [
      { id: 'act_1', type: 'update_record', config: {} },
      {
        id: 'act_2',
        type: 'if',
        config: {
          then: [{ id: 'act_3', type: 'create_record', config: {} }],
          else: [{ id: 'act_4', type: 'delete_record', config: {} }],
        },
      },
      { id: 'act_5', type: 'delay', config: {} },
    ],
  } as unknown as AutomationDefinition;

  it('follows the definition, numbers branches and marks what did not run', () => {
    const items = timelineOf(definition, [
      step('act_1'),
      step('act_2'),
      step('act_3', { status: 'failed' }),
    ]);
    expect(items.map((item) => [item.number, item.actionId, item.step?.status ?? null])).toEqual([
      ['1', 'act_1', 'succeeded'],
      ['2', 'act_2', 'succeeded'],
      ['2.1', 'act_3', 'failed'],
      ['2.2', 'act_4', null],
      ['3', 'act_5', null],
    ]);
  });

  it('keeps steps of actions not in the snapshot (or without one) in start order', () => {
    expect(
      timelineOf(null, [step('act_9', { action_type: 'find_records' })]).map((item) => [
        item.number,
        item.type,
      ]),
    ).toEqual([[null, 'find_records']]);
    expect(timelineOf(definition, [step('act_x')]).at(-1)?.actionId).toBe('act_x');
  });
});

describe('batch overflow run', () => {
  it('reads the stand-in run of a full batch', () => {
    expect(
      batchOverflowOf({
        error: {
          code: 'batch_fanout_exceeded',
          params: { batch_id: 'job_1', limit: 1000, skipped: 4000 },
        },
        trigger: {
          event_type: 'record.created',
          event_id: null,
          table_id: null,
          record_id: null,
          bulk: true,
          batch: { id: 'job_1', size: 5000 },
        },
      }),
    ).toEqual({ size: 5000, limit: 1000, skipped: 4000 });
    expect(
      batchOverflowOf({
        error: { code: 'invalid_value' },
        trigger: {
          event_type: null,
          event_id: null,
          table_id: null,
          record_id: null,
          bulk: false,
          batch: null,
        },
      }),
    ).toBeNull();
  });
});

describe('step outputs (redacted by the server)', () => {
  it('keeps hidden values hidden in find_records', () => {
    const view = stepOutputView('find_records', {
      count: 3,
      truncated: true,
      records: [
        {
          id: 'rec_1',
          fields: { fld_name: 'Đơn 1', fld_cost: null },
          redacted: false,
          redacted_fields: ['fld_cost'],
        },
        { id: 'rec_2', fields: { fld_name: null }, redacted: true, redacted_fields: ['fld_name'] },
      ],
    });
    expect(view).toEqual({
      kind: 'find',
      count: 3,
      truncated: true,
      records: [
        {
          id: 'rec_1',
          hidden: false,
          values: [
            { fieldId: 'fld_name', value: 'Đơn 1', hidden: false },
            { fieldId: 'fld_cost', value: null, hidden: true },
          ],
        },
        { id: 'rec_2', hidden: true, values: [{ fieldId: 'fld_name', value: null, hidden: true }] },
      ],
    });
  });

  it.each([
    ['update_record', { id: 'rec_1' }, { kind: 'record', recordId: 'rec_1' }],
    ['create_record', { id: null }, { kind: 'record', recordId: null }],
    ['if', { result: true, branch: 'then' }, { kind: 'if', branch: 'then', result: true }],
    [
      'delay',
      { until: null, resumed_at: null, recheck: null },
      { kind: 'delay', until: null, resumedAt: null, recheck: null },
    ],
    [
      'update_records',
      { matched: 12, updated: 10, batches: 1, skipped_not_editable: 2, done: true },
      {
        kind: 'updateRecords',
        matched: 12,
        updated: 10,
        batches: 1,
        skippedNotEditable: 2,
        done: true,
      },
    ],
    [
      'send_notification',
      {
        recipients: 3,
        delivered: 1,
        turned_off: 0,
        summarized: 0,
        groups: 1,
        record_id: 'rec_1',
        skipped: [{ user_id: 'usr_1', reason: 'cannot_read_record' }],
      },
      {
        kind: 'notification',
        recipients: 3,
        delivered: 1,
        turnedOff: 0,
        summarized: 0,
        recordId: 'rec_1',
        skipped: [{ userId: 'usr_1', reason: 'cannot_read_record' }],
      },
    ],
    [
      'send_email',
      {
        message_id: null,
        identity_id: null,
        mode: 'on_behalf',
        recipients: {
          accepted: ['k***@corp.vn'],
          rejected: [
            { masked: 'c***@x.vn', code: 'smtp_rejected' },
            { masked: 'd***@y.vn', code: 'smtp_rejected', smtp: { code: 552, enhanced: '5.2.2' } },
          ],
        },
        bytes: 100,
        attachment_count: 2,
        attachment_bytes: 2048,
        inline_image_count: 1,
        inline_image_bytes: 4096,
        smtp: { code: 550, enhanced: '5.1.1' },
        footer: 'minimal',
      },
      {
        kind: 'email',
        mode: 'on_behalf',
        accepted: ['k***@corp.vn'],
        rejected: [
          { masked: 'c***@x.vn', code: 'smtp_rejected', smtp: null, reason: 'refused' },
          {
            masked: 'd***@y.vn',
            code: 'smtp_rejected',
            smtp: { code: 552, enhanced: '5.2.2' },
            reason: 'mailbox_full',
          },
        ],
        attachmentCount: 2,
        attachmentBytes: 2048,
        inlineImageCount: 1,
        inlineImageBytes: 4096,
        smtpCode: 550,
        smtpEnhanced: '5.1.1',
        footer: 'minimal',
      },
    ],
    [
      'send_telegram',
      { message_id: 42, text: null },
      { kind: 'other', entries: [['message_id', '42']] },
    ],
    ['send_telegram', { text: null }, null],
  ])('%s', (type, output, view) => {
    expect(stepOutputView(type, output)).toEqual(view);
  });

  it('has no view without an output', () => {
    expect(stepOutputView('update_record', null)).toBeNull();
  });

  it('reads template warnings', () => {
    expect(warningsOf({ id: 'rec_1', warnings: ['unknown_reference', 3] })).toEqual([
      'unknown_reference',
    ]);
    expect(warningsOf(null)).toEqual([]);
  });

  it.each([
    [null, ''],
    ['Đơn 1', 'Đơn 1'],
    [12.5, '12.5'],
    [true, 'Yes'],
    [[{ id: 'usr_1', name: 'Lan' }, { id: 'rec_2' }], 'Lan, rec_2'],
    [['a', null, 'b'], 'a, b'],
  ])('plain value %j → %s', (value, text) => {
    expect(plainValue(value, 'Yes', 'No')).toBe(text);
  });
});
