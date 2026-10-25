import { describe, expect, it } from 'vitest';

import {
  auditActionsOf,
  auditRefIdsOf,
  type AuditLogFilter,
  type AuditLogRow,
} from '../../src/audit/index.js';

function row(overrides: Partial<AuditLogRow>): AuditLogRow {
  return {
    id: 'aud_A1b2C3d4E5f6G7h8',
    organization_id: 'org_A1b2C3d4E5f6G7h8',
    base_id: null,
    table_id: null,
    actor_type: 'system',
    actor_id: null,
    actor_name: null,
    actor_view_id: null,
    via: null,
    action: 'record.updated',
    entity_type: 'record',
    entity_id: null,
    batch_id: null,
    request_id: null,
    before: null,
    after: null,
    ip: null,
    user_agent: null,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    cursor_at: '2026-10-01T00:00:00.000000Z',
    ...overrides,
  };
}

/** T709: action filters and the ids a page refers to (`include=refs`). */
describe('auditActionsOf', () => {
  it.each<[string, AuditLogFilter, readonly string[] | undefined]>([
    ['no action filter: any action', {}, undefined],
    ['exact actions, deduplicated', { actions: ['a.b', 'a.b', 'c.d'] }, ['a.b', 'c.d']],
    [
      'a group expands to its catalogue actions only',
      { actionPrefixes: ['email.'] },
      ['email.test_sent'],
    ],
    [
      'two groups: union',
      { actionPrefixes: ['view.', 'schema.'] },
      ['view.created', 'view.updated', 'view.deleted', 'schema.compacted'],
    ],
    [
      'actions AND groups: intersection',
      { actions: ['record.updated', 'field.created'], actionPrefixes: ['record.'] },
      ['record.updated'],
    ],
    [
      'disjoint actions and groups: nothing',
      { actions: ['field.created'], actionPrefixes: ['record.'] },
      [],
    ],
    ['an empty list: nothing', { actions: [] }, []],
  ])('%s', (_name, filter, expected) => {
    const actions = auditActionsOf(filter);
    if (expected === undefined) expect(actions).toBeUndefined();
    else expect([...(actions ?? [])].sort()).toEqual([...expected].sort());
  });

  it('`record.` covers every record action and nothing else', () => {
    expect([...(auditActionsOf({ actionPrefixes: ['record.'] }) ?? [])].sort()).toEqual([
      'record.created',
      'record.deleted',
      'record.purged',
      'record.restored',
      'record.updated',
    ]);
  });
});

describe('auditRefIdsOf', () => {
  it('collects actors, entities, tables, field keys and token ids of the page', () => {
    const ids = auditRefIdsOf([
      row({
        actor_type: 'user',
        actor_id: 'usr_A1b2C3d4E5f6G7h8',
        table_id: 'tbl_A1b2C3d4E5f6G7h8',
        entity_type: 'record',
        entity_id: 'rec_A1b2C3d4E5f6G7h8',
        via: { api_token_id: 'tok_A1b2C3d4E5f6G7h8' },
        before: { fld_A1b2C3d4E5f6G7h8: 'usr_Z9b2C3d4E5f6G7h8' },
        after: { fld_A1b2C3d4E5f6G7h8: 'x', fld_B1b2C3d4E5f6G7h8: 'tbl_Z9b2C3d4E5f6G7h8' },
      }),
      row({ actor_type: 'automation', actor_id: 'aut_A1b2C3d4E5f6G7h8' }),
      row({ entity_type: 'user', entity_id: 'usr_B1b2C3d4E5f6G7h8', action: 'user.created' }),
      row({ entity_type: 'field', entity_id: 'fld_C1b2C3d4E5f6G7h8', action: 'field.deleted' }),
      row({ entity_type: 'table', entity_id: 'tbl_B1b2C3d4E5f6G7h8', action: 'table.created' }),
      row({
        entity_type: 'api_token',
        entity_id: 'tok_B1b2C3d4E5f6G7h8',
        action: 'api_token.created',
        // Keys of non-record entries are not field ids.
        after: { fld_D1b2C3d4E5f6G7h8: 1 },
      }),
      row({ action: 'record.updated', after: { redacted: true } }),
    ]);
    expect(ids).toEqual({
      users: ['usr_A1b2C3d4E5f6G7h8', 'usr_B1b2C3d4E5f6G7h8'],
      fields: ['fld_A1b2C3d4E5f6G7h8', 'fld_B1b2C3d4E5f6G7h8', 'fld_C1b2C3d4E5f6G7h8'],
      tables: ['tbl_A1b2C3d4E5f6G7h8', 'tbl_B1b2C3d4E5f6G7h8'],
      apiTokens: ['tok_A1b2C3d4E5f6G7h8', 'tok_B1b2C3d4E5f6G7h8'],
    });
  });

  it('an empty page refers to nothing', () => {
    expect(auditRefIdsOf([])).toEqual({ users: [], fields: [], tables: [], apiTokens: [] });
  });
});
