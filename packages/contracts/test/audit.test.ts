import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_PREFIXES,
  AUDIT_ACTIONS,
  auditActionsOfPrefix,
  auditLogFiltersSchema,
  baseAuditLogQuerySchema,
  exportBaseAuditLogsRequestSchema,
  MAX_AUDIT_FILTER_VALUES,
  orgAuditLogQuerySchema,
} from '../src/index.js';

/** T709: audit viewer filters (CONTRACTS §11.4). */
describe('audit log filters', () => {
  it('the action groups are exactly the entity parts of the action catalogue', () => {
    const derived = [...new Set(AUDIT_ACTIONS.map((a) => a.slice(0, a.indexOf('.') + 1)))].sort();
    expect([...AUDIT_ACTION_PREFIXES]).toEqual(derived);
    for (const prefix of AUDIT_ACTION_PREFIXES) {
      expect(auditActionsOfPrefix(prefix).length).toBeGreaterThan(0);
    }
    expect(auditActionsOfPrefix('email.')).toEqual(['email.test_sent']);
  });

  it.each([
    ['one value', { action: 'record.updated' }, { action: ['record.updated'] }],
    [
      'repeated values',
      { action: ['record.updated', 'record.created'], actor_id: ['usr_a'] },
      { action: ['record.updated', 'record.created'], actor_id: ['usr_a'] },
    ],
    [
      'groups and sources',
      { action_prefix: 'record.', via: ['api_token', 'import'] },
      { action_prefix: ['record.'], via: ['api_token', 'import'] },
    ],
  ])('parses %s as lists', (_name, input, expected) => {
    expect(orgAuditLogQuerySchema.parse(input)).toMatchObject(expected);
  });

  it.each([
    ['an unknown group', { action_prefix: 'records.' }],
    ['a group without its dot', { action_prefix: 'record' }],
    ['an unknown source', { via: 'webhook' }],
    ['an empty list', { action: [] }],
    [
      `more than ${String(MAX_AUDIT_FILTER_VALUES)} actions`,
      { action: Array.from({ length: MAX_AUDIT_FILTER_VALUES + 1 }, (_v, i) => `a.b${String(i)}`) },
    ],
    [
      `more than ${String(MAX_AUDIT_FILTER_VALUES)} actors`,
      {
        actor_id: Array.from(
          { length: MAX_AUDIT_FILTER_VALUES + 1 },
          (_v, i) => `usr_${String(i)}`,
        ),
      },
    ],
    ['an unknown include', { include: 'names' }],
  ])('rejects %s', (_name, input) => {
    expect(orgAuditLogQuerySchema.safeParse(input).success).toBe(false);
  });

  it('accepts 20 values and include=refs', () => {
    const action = Array.from({ length: MAX_AUDIT_FILTER_VALUES }, (_v, i) => `a.b${String(i)}`);
    expect(baseAuditLogQuerySchema.parse({ action, include: 'refs' })).toMatchObject({
      action,
      include: 'refs',
    });
  });

  it('a base export body cannot name a base; the org export body can', () => {
    expect(
      exportBaseAuditLogsRequestSchema.safeParse({
        format: 'csv',
        filters: { base_id: 'bse_A1b2C3d4E5f6G7h8' },
      }).success,
    ).toBe(false);
    expect(
      auditLogFiltersSchema.parse({ base_id: 'bse_A1b2C3d4E5f6G7h8', action: 'record.updated' }),
    ).toEqual({ base_id: 'bse_A1b2C3d4E5f6G7h8', action: ['record.updated'] });
  });
});
