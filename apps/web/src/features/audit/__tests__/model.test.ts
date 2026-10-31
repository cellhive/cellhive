import { AUDIT_ACTION_PREFIXES, AUDIT_ACTIONS, type AuditLogEntryDto } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { localeResources } from '../../../../test/i18n';
import {
  ACTION_CATEGORIES,
  DEFAULT_FILTERS,
  EMPTY_REFS,
  actionParts,
  actorOf,
  dayOf,
  diffRows,
  entityOf,
  filtersToParams,
  mergeRefs,
  parseFilters,
  prefixKey,
  rangeBounds,
  safeDownloadUrl,
  startOfDay,
  toQuery,
  valueText,
  viaOf,
  type AuditFilters,
} from '../model';

/** T716: the pure model of the audit log viewer. */

const NOW = Date.parse('2026-10-24T03:00:00.000Z');

function entry(patch: Partial<AuditLogEntryDto> = {}): AuditLogEntryDto {
  return {
    id: 'aud_0000000000000001',
    created_at: '2026-10-24T02:00:00.000Z',
    actor: { type: 'user', id: 'usr_0000000000000001', name: 'An' },
    via: null,
    action: 'record.updated',
    entity_type: 'record',
    entity_id: 'rec_0000000000000001',
    base_id: 'bse_0000000000000001',
    table_id: 'tbl_0000000000000001',
    batch_id: 'req_1',
    request_id: 'req_1',
    before: null,
    after: null,
    ip: null,
    user_agent: null,
    ...patch,
  };
}

describe('action groups', () => {
  it('puts every prefix in exactly one category', () => {
    const listed = ACTION_CATEGORIES.flatMap((category) => [...category.prefixes]);
    expect([...listed].sort()).toEqual([...AUDIT_ACTION_PREFIXES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('has a label for every group and verb of the catalogue in en and vi', () => {
    const resources = localeResources();
    for (const language of ['en', 'vi']) {
      const audit = resources[language]?.['audit'] as {
        groups: Record<string, string>;
        verbs: Record<string, string>;
        categories: Record<string, string>;
      };
      for (const prefix of AUDIT_ACTION_PREFIXES) {
        expect(audit.groups[prefixKey(prefix)], `${language} ${prefix}`).toBeTruthy();
      }
      for (const action of AUDIT_ACTIONS) {
        const parts = actionParts(action);
        expect(parts, action).not.toBeNull();
        expect(audit.verbs[parts?.verb ?? ''], `${language} ${action}`).toBeTruthy();
      }
      for (const category of ACTION_CATEGORIES) {
        expect(audit.categories[category.key]).toBeTruthy();
      }
    }
  });

  it.each([
    ['record.updated', { prefix: 'record.', verb: 'updated' }],
    ['automation.run.failed', { prefix: 'automation.', verb: 'run_failed' }],
    ['email_identity.verified', { prefix: 'email_identity.', verb: 'verified' }],
    ['unknown.thing', null],
    ['nodot', null],
  ])('splits %s', (action, expected) => {
    expect(actionParts(action)).toEqual(expected);
  });
});

describe('filters in the URL', () => {
  const cases: [string, string, Partial<AuditFilters>][] = [
    ['empty → defaults', '', {}],
    [
      'repeated values',
      'actor=usr_A&actor=usr_B&group=record.&group=nope.&via=api_token&via=bad',
      { actors: ['usr_A', 'usr_B'], prefixes: ['record.'], via: ['api_token'] },
    ],
    [
      'custom range',
      'range=custom&from=2026-10-01&to=2026-10-03',
      { range: 'custom', from: '2026-10-01', to: '2026-10-03' },
    ],
    ['custom without days → default', 'range=custom', {}],
    [
      'malformed day dropped',
      'range=custom&from=yesterday&to=2026-10-03',
      { range: 'custom', to: '2026-10-03' },
    ],
    ['unknown range → default', 'range=forever', {}],
    [
      'single values',
      'entity=record&base=bse_1&batch=req_9&action=record.updated',
      { entityType: 'record', baseId: 'bse_1', batchId: 'req_9', actions: ['record.updated'] },
    ],
    ['injection-looking value dropped', 'actor=%3Cscript%3E', {}],
  ];
  it.each(cases)('%s', (_name, search, expected) => {
    const filters = parseFilters(new URLSearchParams(search));
    expect(filters).toEqual({ ...DEFAULT_FILTERS, ...expected });
    // Round trip.
    expect(parseFilters(filtersToParams(filters))).toEqual(filters);
  });

  it('keeps at most 20 values of a filter', () => {
    const search = Array.from({ length: 25 }, (_, index) => `actor=usr_${String(index)}`).join('&');
    expect(parseFilters(new URLSearchParams(search)).actors).toHaveLength(20);
  });
});

describe('time range', () => {
  it.each([
    ['7d', { from: '2026-10-17T03:00:00.000Z' }],
    ['24h', { from: '2026-10-23T03:00:00.000Z' }],
    ['all', {}],
  ] as const)('preset %s', (range, expected) => {
    expect(rangeBounds({ range, from: null, to: null }, NOW, 'UTC')).toEqual(expected);
  });

  it.each([
    ['UTC', '2026-10-01', '2026-10-01T00:00:00.000Z'],
    ['Asia/Ho_Chi_Minh', '2026-10-01', '2026-09-30T17:00:00.000Z'],
    ['America/New_York', '2026-07-01', '2026-07-01T04:00:00.000Z'],
    ['America/New_York', '2026-12-01', '2026-12-01T05:00:00.000Z'],
  ])('start of a day in %s', (zone, day, expected) => {
    expect(startOfDay(day, zone).toISOString()).toBe(expected);
    expect(dayOf(new Date(expected), zone)).toBe(day);
  });

  it('a custom range includes both days (end exclusive the next midnight)', () => {
    expect(
      rangeBounds(
        { range: 'custom', from: '2026-10-01', to: '2026-10-03' },
        NOW,
        'Asia/Ho_Chi_Minh',
      ),
    ).toEqual({ from: '2026-09-30T17:00:00.000Z', to: '2026-10-03T17:00:00.000Z' });
  });

  it('builds the query; base_id only on the organization route', () => {
    const filters: AuditFilters = {
      ...DEFAULT_FILTERS,
      actors: ['usr_A'],
      prefixes: ['record.'],
      baseId: 'bse_1',
      via: ['api_token'],
      batchId: 'req_1',
    };
    expect(toQuery(filters, NOW, 'UTC', 'org')).toEqual({
      from: '2026-10-17T03:00:00.000Z',
      actor_id: ['usr_A'],
      action_prefix: ['record.'],
      base_id: 'bse_1',
      via: ['api_token'],
      batch_id: 'req_1',
    });
    expect(toQuery(filters, NOW, 'UTC', 'base')).not.toHaveProperty('base_id');
  });
});

describe('names from refs', () => {
  const refs = {
    users: {
      usr_0000000000000001: { display_name: 'Nguyễn An' },
      usr_gone: { display_name: null },
    },
    fields: {
      fld_amount: { name: 'amount', table_id: 'tbl_0000000000000001', deleted: false },
      fld_old: { name: 'Old', table_id: 'tbl_0000000000000001', deleted: true },
    },
    tables: { tbl_0000000000000001: { name: 'Orders', deleted: false } },
    api_tokens: { tok_0000000000000001: { name: 'CRM sync' } },
  } as const;
  const asRefs = refs as unknown as typeof EMPTY_REFS;

  it('names the actor from refs; a deleted user is id + deleted', () => {
    expect(actorOf(entry(), asRefs)).toMatchObject({ kind: 'user', name: 'Nguyễn An' });
    expect(actorOf(entry({ actor: { type: 'user', id: 'usr_gone', name: null } }), asRefs)).toEqual(
      { kind: 'user', id: 'usr_gone', name: null, deleted: true },
    );
    expect(actorOf(entry({ actor: { type: 'system', id: null, name: null } }), asRefs)).toEqual({
      kind: 'system',
    });
  });

  it.each([
    [
      'named token',
      { api_token_id: 'tok_0000000000000001', api_token_name: 'CRM sync' },
      [{ kind: 'api_token', name: 'CRM sync' }],
    ],
    [
      'masked token',
      { api_token_id: null, api_token_name: null },
      [{ kind: 'api_token', name: null }],
    ],
    [
      'token named by refs only',
      { api_token_id: 'tok_0000000000000001' },
      [{ kind: 'api_token', name: 'CRM sync' }],
    ],
    [
      'through MCP, named',
      { api_token_id: 'tok_0000000000000001', api_token_name: 'CRM sync', mcp: true },
      [{ kind: 'mcp', name: 'CRM sync' }],
    ],
    [
      'through MCP, masked',
      { api_token_id: null, api_token_name: null, mcp: true },
      [{ kind: 'mcp', name: null }],
    ],
    [
      'automation run',
      { automation_id: 'aut_0000000000000001', run_id: 'run_0000000000000001' },
      [{ kind: 'automation' }],
    ],
    [
      'revert through a token',
      { api_token_id: null, reverted_from: 'aud_0000000000000009' },
      [{ kind: 'api_token', name: null }, { kind: 'reverted' }],
    ],
  ] as const)('via: %s', (_name, via, expected) => {
    expect(viaOf(entry({ via }), asRefs)).toEqual(expected);
  });

  it.each([
    ['record in its table', entry(), { type: 'record', table: { name: 'Orders' } }],
    [
      'table',
      entry({ entity_type: 'table', entity_id: 'tbl_0000000000000001' }),
      { name: 'Orders', deleted: false },
    ],
    [
      'table removed for good',
      entry({ entity_type: 'table', entity_id: 'tbl_gone' }),
      { name: null, deleted: true },
    ],
    [
      'field in the trash',
      entry({ entity_type: 'field', entity_id: 'fld_old' }),
      { name: 'Old', deleted: true },
    ],
    ['base by name', entry({ entity_type: 'base', entity_id: 'bse_1' }), { name: 'CSKH' }],
    [
      'other types by id',
      entry({ entity_type: 'view', entity_id: 'viw_1' }),
      { name: null, id: 'viw_1' },
    ],
  ])('entity: %s', (_name, value, expected) => {
    expect(entityOf(value, asRefs, new Map([['bse_1', 'CSKH']]))).toMatchObject(expected);
  });

  it('diffs a record by current field names; a field gone for good is id + deleted', () => {
    const rows = diffRows(
      entry({
        before: { fld_amount: 100, fld_gone: 'x', fld_old: ['opt_a'] },
        after: { fld_amount: 150, fld_gone: 'x', fld_old: ['opt_b'] },
      }),
      asRefs,
    );
    expect(rows).toEqual([
      {
        key: 'fld_amount',
        label: { id: 'fld_amount', name: 'amount', deleted: false },
        before: '100',
        after: '150',
        changed: true,
      },
      {
        key: 'fld_gone',
        label: { id: 'fld_gone', name: null, deleted: true },
        before: 'x',
        after: 'x',
        changed: false,
      },
      {
        key: 'fld_old',
        label: { id: 'fld_old', name: 'Old', deleted: true },
        before: '["opt_a"]',
        after: '["opt_b"]',
        changed: true,
      },
    ]);
  });

  it('keeps the keys of other entries', () => {
    expect(
      diffRows(
        entry({ entity_type: 'api_token', before: { name: 'a' }, after: { name: 'b' } }),
        asRefs,
      ),
    ).toMatchObject([{ key: 'name', label: { name: 'name' }, before: 'a', after: 'b' }]);
  });

  it.each([
    [null, null],
    ['<b>bold</b>', '<b>bold</b>'],
    [12, '12'],
    [{ a: 1 }, '{"a":1}'],
    [false, 'false'],
  ])('value text of %j', (value, expected) => {
    expect(valueText(value)).toBe(expected);
  });

  it('merges the refs of every page', () => {
    expect(
      mergeRefs([
        { refs: { ...EMPTY_REFS, users: { usr_a: { display_name: 'A' } } } },
        {},
        { refs: { ...EMPTY_REFS, users: { usr_b: { display_name: 'B' } } } },
      ]).users,
    ).toEqual({ usr_a: { display_name: 'A' }, usr_b: { display_name: 'B' } });
  });

  it.each([
    [{ download_url: '/api/v1/files/exports/job_1' }, '/api/v1/files/exports/job_1'],
    [{ download_url: 'https://evil.test/x' }, null],
    [{ download_url: 'javascript:alert(1)' }, null],
    [null, null],
  ])('download link of %j', (result, expected) => {
    expect(safeDownloadUrl(result)).toBe(expected);
  });
});
