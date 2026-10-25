import { describe, expect, it } from 'vitest';

import {
  baseChannel,
  dashboardChannel,
  parseRealtimeChannel,
  parseRealtimeClientMessage,
  realtimeServerMessageSchema,
  tableChannel,
  userChannel,
} from '../src/realtime.js';

const BSE = 'bse_A1b2C3d4E5f6G7h8';
const TBL = 'tbl_A1b2C3d4E5f6G7h8';
const USR = 'usr_A1b2C3d4E5f6G7h8';
const DSH = 'dsh_A1b2C3d4E5f6G7h8';

describe('parseRealtimeChannel', () => {
  it.each([
    [`base:${BSE}`, { kind: 'base', id: BSE }],
    [`table:${TBL}`, { kind: 'table', id: TBL }],
    [`user:${USR}`, { kind: 'user', id: USR }],
    [`dashboard:${DSH}`, { kind: 'dashboard', id: DSH }],
  ])('%s', (channel, expected) => {
    expect(parseRealtimeChannel(channel)).toEqual(expected);
  });

  it.each([
    ['empty', ''],
    ['no separator', BSE],
    ['unknown kind', `view:viw_A1b2C3d4E5f6G7h8`],
    ['dashboard with table id', `dashboard:${TBL}`],
    ['wrong prefix for kind', `base:${TBL}`],
    ['table with user id', `table:${USR}`],
    ['user with base id', `user:${BSE}`],
    ['short id', 'base:bse_short'],
    ['trailing data', `base:${BSE}:x`],
    ['too long', `table:${'x'.repeat(80)}`],
  ])('rejects %s', (_name, channel) => {
    expect(parseRealtimeChannel(channel)).toBeUndefined();
  });

  it('builds channel names', () => {
    expect(baseChannel(BSE)).toBe(`base:${BSE}`);
    expect(tableChannel(TBL)).toBe(`table:${TBL}`);
    expect(userChannel(USR)).toBe(`user:${USR}`);
    expect(dashboardChannel(DSH)).toBe(`dashboard:${DSH}`);
  });
});

describe('parseRealtimeClientMessage', () => {
  it.each([
    [
      { type: 'subscribe', channel: `table:${TBL}`, req_id: '1' },
      { type: 'subscribe', channel: `table:${TBL}`, req_id: '1' },
    ],
    [
      { type: 'unsubscribe', channel: `base:${BSE}` },
      { type: 'unsubscribe', channel: `base:${BSE}` },
    ],
    [{ type: 'ping' }, { type: 'ping' }],
    [
      { type: 'ping', req_id: 'p' },
      { type: 'ping', req_id: 'p' },
    ],
  ])('accepts %j', (input, expected) => {
    expect(parseRealtimeClientMessage(JSON.stringify(input))).toEqual({
      ok: true,
      message: expected,
    });
  });

  it.each([
    ['malformed JSON', '{', null, 'MALFORMED_JSON'],
    ['a JSON string', '"subscribe"', null, 'INVALID_TYPE'],
    ['unknown type', JSON.stringify({ type: 'hello', req_id: '7' }), '7', 'UNKNOWN_TYPE'],
    [
      'subscribe without req_id',
      JSON.stringify({ type: 'subscribe', channel: `table:${TBL}` }),
      null,
      'INVALID_TYPE',
    ],
    [
      'subscribe to an invalid channel',
      JSON.stringify({ type: 'subscribe', channel: 'table:nope', req_id: '2' }),
      '2',
      'CUSTOM',
    ],
    [
      'unknown key',
      JSON.stringify({ type: 'ping', extra: true, req_id: '3' }),
      '3',
      'UNRECOGNIZED_KEYS',
    ],
    [
      'req_id too long',
      JSON.stringify({ type: 'subscribe', channel: `base:${BSE}`, req_id: 'x'.repeat(65) }),
      null,
      'TOO_BIG',
    ],
  ])('rejects %s', (_name, text, reqId, code) => {
    const result = parseRealtimeClientMessage(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reqId).toBe(reqId);
    expect(result.errors[0]?.code).toBe(code);
  });
});

describe('realtimeServerMessageSchema', () => {
  it.each([
    { type: 'subscribed', req_id: '1', channel: `table:${TBL}` },
    { type: 'error', req_id: '1', code: 'NOT_FOUND' },
    { type: 'error', req_id: null, code: 'NOT_FOUND', channel: `table:${TBL}` },
    // T706: an API token without records:read.
    {
      type: 'error',
      req_id: '1',
      code: 'INSUFFICIENT_SCOPE',
      channel: `table:${TBL}`,
      errors: [
        {
          path: '',
          code: 'INSUFFICIENT_SCOPE',
          message: 'The API token does not allow this channel',
          params: { required: ['records:read'] },
        },
      ],
    },
    { type: 'pong' },
    {
      type: 'schema.changed',
      channel: `table:${TBL}`,
      entity: 'field',
      entity_id: 'fld_A1b2C3d4E5f6G7h8',
      action: 'updated',
    },
    { type: 'permission.changed', channel: `base:${BSE}` },
    // T807: hints only — ids and a version, never values.
    { type: 'dashboard.changed', channel: `dashboard:${DSH}`, dashboard_id: DSH, version: 3 },
    {
      type: 'dashboard.data_changed',
      channel: `dashboard:${DSH}`,
      dashboard_id: DSH,
      table_ids: [TBL],
    },
    {
      type: 'job.progress',
      channel: `user:${USR}`,
      job_id: 'job_A1b2C3d4E5f6G7h8',
      progress: 0.7,
      status: 'running',
    },
    {
      type: 'notification.created',
      channel: `user:${USR}`,
      notification_id: 'ntf_A1b2C3d4E5f6G7h8',
      organization_id: 'org_A1b2C3d4E5f6G7h8',
      notification_type: 'automation.disabled',
      base_id: BSE,
    },
    {
      type: 'record.updated',
      channel: `table:${TBL}`,
      record_id: 'rec_A1b2C3d4E5f6G7h8',
      version: 5,
      fields: { fld_A1b2C3d4E5f6G7h8: 2 },
      actor_id: USR,
      event_id: 'evt_A1b2C3d4E5f6G7h8',
    },
    { type: 'record.deleted', channel: `table:${TBL}`, record_ids: ['rec_A1b2C3d4E5f6G7h8'] },
    {
      type: 'record.batch',
      channel: `table:${TBL}`,
      actor_id: null,
      count: 150,
      ops: { created: 0, updated: 140, added: 5, removed_from_view: 5, deleted: 0, restored: 0 },
    },
  ])('accepts $type', (message) => {
    expect(realtimeServerMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    { type: 'error', req_id: '1', code: 'NOPE' },
    { type: 'job.progress', channel: `user:${USR}`, job_id: 'x', progress: 2, status: 'running' },
    // T511: closed type list, ids only.
    {
      type: 'notification.created',
      channel: `user:${USR}`,
      notification_id: 'ntf_A1b2C3d4E5f6G7h8',
      organization_id: 'org_A1b2C3d4E5f6G7h8',
      notification_type: 'record.unknown',
      base_id: null,
    },
    {
      type: 'notification.created',
      channel: `user:${USR}`,
      notification_id: 'ntf_A1b2C3d4E5f6G7h8',
      organization_id: 'org_A1b2C3d4E5f6G7h8',
      notification_type: 'automation.message',
      base_id: null,
      title: 'no content on the wire',
    },
    { type: 'record.deleted', channel: `table:${TBL}`, record_ids: [] },
    // T303: no record ids and no empty batch.
    {
      type: 'record.batch',
      channel: `table:${TBL}`,
      actor_id: null,
      count: 0,
      ops: { created: 0, updated: 0, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
    },
    {
      type: 'record.batch',
      channel: `table:${TBL}`,
      actor_id: null,
      count: 1,
      ops: { created: 1, updated: 0, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
      record_ids: ['rec_A1b2C3d4E5f6G7h8'],
    },
  ])('rejects %j', (message) => {
    expect(realtimeServerMessageSchema.safeParse(message).success).toBe(false);
  });
});
