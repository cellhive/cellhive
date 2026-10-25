import { describe, expect, it } from 'vitest';

import {
  delayUntilRecordRefs,
  delayUntilVisible,
  redactStepOutput,
  stepRecordRefs,
  type DelayUntilContext,
  type StepReadability,
} from '../../src/automation/runs/redact.js';

import type { JsonValue } from '../../src/db/schema.js';

const ORDERS = 'tbl_Orders0000000001';
const HIDDEN_TABLE = 'tbl_Hidden0000000001';

/** Reads `title` and `amount` of Orders (not `cost`), and only `rec_mine`. */
const viewer: StepReadability = {
  fieldsOf: (tableId) => (tableId === ORDERS ? new Set(['fld_title', 'fld_amount']) : undefined),
  recordVisible: (tableId, recordId) => tableId === ORDERS && recordId === 'rec_mine',
};

const found = (records: JsonValue[]): JsonValue => ({
  records,
  count: records.length,
  truncated: false,
});

/** A `send_email` step output as T514 stores it (`sendEmailStepOutputSchema`). */
const SENT: JsonValue = {
  message_id: '<ob.0123456789abcdef0123456789abcdef01234567@corp.vn>',
  identity_id: 'eid_Hr00000000000001',
  mode: 'send_as',
  recipients: {
    accepted: ['a***@corp.vn', '***'],
    rejected: [{ masked: 'x***@gmail.com', code: 'smtp_rejected' }],
  },
  bytes: 5120,
  attachment_count: 0,
  attachment_bytes: 0,
  smtp: { code: 250, enhanced: '2.0.0' },
  footer: 'minimal',
  warnings: [{ code: 'EXTERNAL_RECIPIENTS' }],
};

describe('redactStepOutput (BACKLOG T518)', () => {
  const cases: {
    name: string;
    type: string | null;
    table: string | null;
    output: JsonValue | null;
    expected: { output: JsonValue | null; redacted: boolean };
  }[] = [
    {
      name: 'record ids, branches and warnings are not values: as stored',
      type: 'create_record',
      table: ORDERS,
      output: { id: 'rec_Other00000000001', warnings: [{ code: 'field_unavailable' }] },
      expected: {
        output: { id: 'rec_Other00000000001', warnings: [{ code: 'field_unavailable' }] },
        redacted: false,
      },
    },
    {
      name: '`if` output as stored',
      type: 'if',
      table: null,
      output: { result: true, branch: 'then' },
      expected: { output: { result: true, branch: 'then' }, redacted: false },
    },
    {
      name: '`send_email` (T514): masked recipients, sizes and SMTP codes are kept',
      type: 'send_email',
      table: null,
      output: SENT,
      expected: { output: SENT, redacted: false },
    },
    {
      name: '`send_email`: an unmasked address or any text (subject) is hidden',
      type: 'send_email',
      table: null,
      output: {
        ...(SENT as Record<string, JsonValue>),
        subject: 'Đơn 1 của Lan',
        recipients: { accepted: ['lan@corp.vn', 'b***@corp.vn'], rejected: [] },
      },
      expected: {
        output: {
          ...(SENT as Record<string, JsonValue>),
          subject: null,
          recipients: { accepted: [null, 'b***@corp.vn'], rejected: [] },
        },
        redacted: true,
      },
    },
    {
      name: '`update_records` (T506): counts and the last record id are kept',
      type: 'update_records',
      table: ORDERS,
      output: {
        matched: 1200,
        updated: 1000,
        batches: 1,
        last_record_id: 'rec_Last000000000001',
        skipped_not_editable: 3,
      },
      expected: {
        output: {
          matched: 1200,
          updated: 1000,
          batches: 1,
          last_record_id: 'rec_Last000000000001',
          skipped_not_editable: 3,
        },
        redacted: false,
      },
    },
    {
      name: '`delay` (T506): resume times and the recheck code are kept',
      type: 'delay',
      table: null,
      output: {
        until: '2026-10-06T03:00:00.000Z',
        resumed_at: '2026-10-06T03:00:01.000Z',
        recheck: 'matched',
      },
      expected: {
        output: {
          until: '2026-10-06T03:00:00.000Z',
          resumed_at: '2026-10-06T03:00:01.000Z',
          recheck: 'matched',
        },
        redacted: false,
      },
    },
    {
      name: '`send_notification` (T515): counts, user ids and skip reasons are kept; text is not',
      type: 'send_notification',
      table: null,
      output: {
        recipients: 3,
        delivered: 1,
        turned_off: 0,
        summarized: 0,
        groups: 1,
        record_id: 'rec_Mine000000000001',
        skipped: [{ user_id: 'usr_Skipped000000001', reason: 'cannot_read_field' }],
        title: 'Đơn 1 của Lan',
      },
      expected: {
        output: {
          recipients: 3,
          delivered: 1,
          turned_off: 0,
          summarized: 0,
          groups: 1,
          record_id: 'rec_Mine000000000001',
          skipped: [{ user_id: 'usr_Skipped000000001', reason: 'cannot_read_field' }],
          title: null,
        },
        redacted: true,
      },
    },
    {
      name: 'send_telegram keeps the message id, secret id and sizes (no text was stored)',
      type: 'send_telegram',
      table: null,
      output: {
        message_id: 4711,
        secret_id: 'sec_Bot0000000000001',
        length: 42,
        truncated: false,
        text: 'Đơn <b>1</b>',
        chat_id: '-100123',
      },
      expected: {
        output: {
          message_id: 4711,
          secret_id: 'sec_Bot0000000000001',
          length: 42,
          truncated: false,
          text: null,
          chat_id: null,
        },
        redacted: true,
      },
    },
    {
      name: 'an action without a rule keeps ids, codes and numbers only',
      type: 'http_request',
      table: null,
      output: { text: 'Đơn 1 xong', chat: 'Kho', status: 'sent', ok: true, attempts: 1 },
      expected: {
        output: { text: null, chat: null, status: 'sent', ok: true, attempts: 1 },
        redacted: true,
      },
    },
    {
      name: 'no output',
      type: 'find_records',
      table: ORDERS,
      output: null,
      expected: { output: null, redacted: false },
    },
    {
      name: 'a readable record keeps readable fields, hides the others',
      type: 'find_records',
      table: ORDERS,
      output: found([{ id: 'rec_mine', fields: { fld_title: 'Đơn 1', fld_cost: 700 } }]),
      expected: {
        output: found([
          {
            id: 'rec_mine',
            fields: { fld_title: 'Đơn 1', fld_cost: null },
            redacted: false,
            redacted_fields: ['fld_cost'],
          },
        ]),
        redacted: true,
      },
    },
    {
      name: 'a record outside the read rule: every value null',
      type: 'find_records',
      table: ORDERS,
      output: found([{ id: 'rec_other', fields: { fld_title: 'Đơn 2', fld_amount: 5 } }]),
      expected: {
        output: found([
          {
            id: 'rec_other',
            fields: { fld_title: null, fld_amount: null },
            redacted: true,
            redacted_fields: ['fld_title', 'fld_amount'],
          },
        ]),
        redacted: true,
      },
    },
    {
      name: 'everything readable: nothing redacted',
      type: 'find_records',
      table: ORDERS,
      output: found([{ id: 'rec_mine', fields: { fld_title: 'Đơn 1', fld_amount: 5 } }]),
      expected: {
        output: found([
          {
            id: 'rec_mine',
            fields: { fld_title: 'Đơn 1', fld_amount: 5 },
            redacted: false,
            redacted_fields: [],
          },
        ]),
        redacted: false,
      },
    },
    {
      name: 'a table the viewer cannot read',
      type: 'find_records',
      table: HIDDEN_TABLE,
      output: found([{ id: 'rec_mine', fields: { fld_title: 'x' } }]),
      expected: {
        output: found([
          {
            id: 'rec_mine',
            fields: { fld_title: null },
            redacted: true,
            redacted_fields: ['fld_title'],
          },
        ]),
        redacted: true,
      },
    },
    {
      name: 'an unknown table (definition no longer parses)',
      type: 'find_records',
      table: null,
      output: found([{ id: 'rec_mine', fields: { fld_title: 'x' } }]),
      expected: {
        output: found([
          {
            id: 'rec_mine',
            fields: { fld_title: null },
            redacted: true,
            redacted_fields: ['fld_title'],
          },
        ]),
        redacted: true,
      },
    },
    {
      name: 'an unexpected record entry is dropped',
      type: 'find_records',
      table: ORDERS,
      output: found(['rec_mine']),
      expected: { output: found([null]), redacted: true },
    },
    {
      name: 'an unexpected output shape hides the whole output',
      type: 'find_records',
      table: ORDERS,
      output: { rows: [{ fld_cost: 1 }] },
      expected: { output: null, redacted: true },
    },
  ];

  it.each(cases)('$name', ({ type, table, output, expected }) => {
    expect(redactStepOutput(type, table, output, viewer)).toEqual(expected);
  });
});

describe('stepRecordRefs', () => {
  it('lists the records of a value-carrying step only', () => {
    const output = found([{ id: 'rec_a', fields: {} }, { id: 'rec_b', fields: {} }, 'junk']);
    expect(stepRecordRefs('find_records', ORDERS, output)).toEqual({
      tableId: ORDERS,
      recordIds: ['rec_a', 'rec_b'],
    });
    expect(stepRecordRefs('create_record', ORDERS, { id: 'rec_a' })).toBeUndefined();
    expect(stepRecordRefs('find_records', null, output)).toBeUndefined();
    expect(stepRecordRefs(null, ORDERS, output)).toBeUndefined();
  });
});

describe('delay times (T506 `until`, coordinator decision for T518)', () => {
  const READ = 'fld_Read000000000001';
  const HIDDEN = 'fld_Hidden0000000001';
  const MINE = 'rec_Mine000000000001';
  const OTHER = 'rec_Other00000000001';
  /** Reads READ (not HIDDEN) of Orders, and only the record MINE. */
  const reader: StepReadability = {
    fieldsOf: (tableId) => (tableId === ORDERS ? new Set([READ]) : undefined),
    recordVisible: (tableId, recordId) => tableId === ORDERS && recordId === MINE,
  };
  const context = (until: unknown, recordId = MINE): DelayUntilContext => ({
    until,
    trigger: { tableId: ORDERS, recordId, dueFieldId: HIDDEN },
    steps: new Map([
      ['act_find', { tableId: ORDERS, recordIds: [MINE] }],
      ['act_other', { tableId: ORDERS, recordIds: [OTHER] }],
      ['act_hidden', { tableId: HIDDEN_TABLE, recordIds: [MINE] }],
    ]),
  });
  const cases: { name: string; until: unknown; recordId?: string; visible: boolean }[] = [
    { name: 'minutes', until: null, visible: true },
    { name: 'a literal', until: { literal: '2026-10-07' }, visible: true },
    { name: 'NOW()/TODAY()', until: { template: '{{ TODAY() + 1 }}' }, visible: true },
    { name: 'the trigger fire time', until: { trigger: 'fired_at' }, visible: true },
    { name: 'a readable field', until: { field: READ }, visible: true },
    { name: 'a hidden field', until: { field: HIDDEN }, visible: false },
    {
      name: 'a readable field of a hidden record',
      until: { field: READ },
      recordId: OTHER,
      visible: false,
    },
    {
      name: 'a template reading a hidden field',
      until: { template: `{{ [${HIDDEN}] }}` },
      visible: false,
    },
    {
      name: 'a template reading a readable field',
      until: { template: `{{ [${READ}] + 1 }}` },
      visible: true,
    },
    { name: 'due_at of a hidden date field', until: { trigger: 'due_at' }, visible: false },
    {
      name: 'a step on a readable record',
      until: { step: 'act_find', path: `records[0].fields.${READ}` },
      visible: true,
    },
    {
      name: 'a step reading a hidden field',
      until: { step: 'act_find', path: `records[0].fields.${HIDDEN}` },
      visible: false,
    },
    { name: 'a step on a hidden record', until: { step: 'act_other' }, visible: false },
    { name: 'a step on a hidden table', until: { step: 'act_hidden' }, visible: false },
    { name: 'a template naming a step', until: { template: '{{ [act_other] }}' }, visible: false },
    { name: 'a digest', until: { digest: { step: 'act_find' } }, visible: false },
  ];
  it.each(cases)('$name → visible: $visible', ({ until, recordId, visible }) => {
    expect(delayUntilVisible(context(until, recordId), reader)).toBe(visible);
  });

  it('asks only for the records the value was read from', () => {
    expect(delayUntilRecordRefs(context({ literal: 'x' }))).toEqual([]);
    expect(delayUntilRecordRefs(context({ field: READ }))).toEqual([
      { tableId: ORDERS, recordIds: [MINE] },
    ]);
    expect(delayUntilRecordRefs(context({ step: 'act_other' }))).toEqual([
      { tableId: ORDERS, recordIds: [OTHER] },
    ]);
  });

  it('hides the times of a delay the viewer may not read', () => {
    const output = { until: '2026-10-07T00:00:00.000Z', resumed_at: null, recheck: null };
    expect(redactStepOutput('delay', null, output, reader, { hideDelayTimes: true })).toEqual({
      output: { until: null, resumed_at: null, recheck: null },
      redacted: true,
    });
    expect(redactStepOutput('delay', null, output, reader)).toEqual({ output, redacted: false });
  });
});
