import { describe, expect, it } from 'vitest';

import {
  buildAuditRow,
  findForbiddenAuditKey,
  MAX_USER_AGENT_LENGTH,
  systemAuditContext,
  type AuditContext,
  type AuditEntryInput,
} from '../../src/audit/audit-entry.js';

import type { JsonValue } from '../../src/db/schema.js';

const ORG = 'org_AuditOrg00000001';

const userContext: AuditContext = {
  actor: { type: 'user', id: 'usr_User000000000001' },
  via: null,
  batch_id: 'req_Request000000001',
  request_id: 'req_Request000000001',
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0',
};

function entry(overrides: Partial<Record<keyof AuditEntryInput, unknown>> = {}): AuditEntryInput {
  return {
    action: 'record.updated',
    organizationId: ORG,
    tableId: 'tbl_Table00000000001',
    entityType: 'record',
    entityId: 'rec_Record0000000001',
    before: { fld_status: ['opt_new'] },
    after: { fld_status: ['opt_done'] },
    context: userContext,
    ...overrides,
  } as AuditEntryInput;
}

describe('buildAuditRow', () => {
  it('maps the entry and its context to columns', () => {
    expect(buildAuditRow(entry())).toEqual({
      organization_id: ORG,
      base_id: null,
      table_id: 'tbl_Table00000000001',
      actor_type: 'user',
      actor_id: 'usr_User000000000001',
      via: null,
      action: 'record.updated',
      entity_type: 'record',
      entity_id: 'rec_Record0000000001',
      batch_id: 'req_Request000000001',
      request_id: 'req_Request000000001',
      before: { fld_status: ['opt_new'] },
      after: { fld_status: ['opt_done'] },
      ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0',
    });
  });

  it.each<[string, Partial<Record<keyof AuditEntryInput, unknown>>]>([
    ['auth.* without organization', { action: 'auth.login_failed', organizationId: null }],
    [
      'system actor without organization (CLI)',
      {
        action: 'setup.completed',
        organizationId: null,
        context: systemAuditContext(),
      },
    ],
    ['audit-only action', { action: 'export.created' }],
    [
      'via automation',
      {
        context: {
          ...userContext,
          actor: { type: 'automation', id: 'aut_Automation000001' },
          via: { automation_id: 'aut_Automation000001', run_id: 'run_Run0000000000001' },
        },
      },
    ],
    ['IPv6 address', { context: { ...userContext, ip: '2001:db8::1' } }],
    ['job batch id', { context: { ...userContext, batch_id: 'job_Job0000000000001' } }],
    // T707: an account created by an OIDC sign-in that joined no organization.
    [
      'user.created without organization',
      { action: 'user.created', entityType: 'user', organizationId: null },
    ],
  ])('accepts %s', (_name, overrides) => {
    expect(() => buildAuditRow(entry(overrides))).not.toThrow();
  });

  it.each<[string, Partial<Record<keyof AuditEntryInput, unknown>>, RegExp]>([
    ['unknown action', { action: 'record.exploded' }, /unknown action 'record\.exploded'/],
    [
      'user action without organization',
      { organizationId: null },
      /organizationId may be null only/,
    ],
    ['bad organization id', { organizationId: 'org_x' }, /organizationId/],
    ['bad table id', { tableId: 'fld_Field00000000001' }, /tableId/],
    ['bad entity type', { entityType: 'Record' }, /entityType/],
    [
      'password in after',
      { after: { password: 'hunter2' } },
      /after\.password looks like a secret/,
    ],
    [
      'nested token hash',
      { before: { session: [{ Token_Hash: 'x' }] } },
      /before\.session\[0\]\.Token_Hash/,
    ],
    ['invalid ip', { context: { ...userContext, ip: 'not-an-ip' } }, /context\.ip/],
    ['empty via', { context: { ...userContext, via: {} } }, /context\.via/],
    ['unknown via key', { context: { ...userContext, via: { webhook: 'x' } } }, /context\.via/],
    [
      'request id with another prefix',
      { context: { ...userContext, request_id: 'job_Job0000000000001' } },
      /context\.request_id/,
    ],
    [
      'user actor without id',
      { context: { ...userContext, actor: { type: 'user', id: null } } },
      /context\.actor/,
    ],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => buildAuditRow(entry(overrides))).toThrow(TypeError);
    expect(() => buildAuditRow(entry(overrides))).toThrow(message);
  });

  it('cuts a long user agent', () => {
    const row = buildAuditRow(
      entry({ context: { ...userContext, user_agent: 'x'.repeat(2_000) } }),
    );
    expect(row.user_agent).toHaveLength(MAX_USER_AGENT_LENGTH);
  });
});

describe('findForbiddenAuditKey', () => {
  it.each<[JsonValue | undefined, string | null]>([
    [undefined, null],
    [null, null],
    [{ fld_a: 'password' }, null],
    [{ token_prefix: 'ob_abc' }, null],
    [{ api_key: 'x' }, 'api_key'],
    [{ a: { b: { SECRET: 1 } } }, 'a.b.SECRET'],
    [[{ ok: 1 }, { cookie: 'x' }], '[1].cookie'],
  ])('%j → %s', (value, expected) => {
    expect(findForbiddenAuditKey(value)).toBe(expected);
  });
});
