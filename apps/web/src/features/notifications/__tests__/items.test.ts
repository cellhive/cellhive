import { EMAIL_FREQUENCIES, MANDATORY_NOTIFICATION_TYPES } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  basesOf,
  EMAIL_FREQUENCY_OPTIONS,
  MANDATORY_TYPES,
  groupRows,
  isMandatory,
  linkOf,
  lostAccess,
  type PanelRow,
} from '../model/items';
import { badgeText } from '../shell/unread';

import type { NotificationDto } from '@cellhive/contracts';

const BASE = { id: 'bse_aaaaaaaaaaaaaaaa', name: 'Sales' } as const;

function notification(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: 'ntf_aaaaaaaaaaaaaaaa',
    type: 'automation.message',
    base: BASE,
    table_id: 'tbl_aaaaaaaaaaaaaaaa',
    entity: { type: 'record', id: 'rec_aaaaaaaaaaaaaaaa', title: 'Order R1' },
    actor: null,
    data: { automation_id: 'aut_aaaaaaaaaaaaaaaa', run_id: 'run_a', title: 'Paid', body: '' },
    read_at: null,
    created_at: '2026-10-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('linkOf / lostAccess', () => {
  const cases: {
    name: string;
    item: NotificationDto;
    link: string | null;
    lost: boolean;
  }[] = [
    {
      name: 'record opens the record panel',
      item: notification(),
      link: '/b/bse_aaaaaaaaaaaaaaaa/t/tbl_aaaaaaaaaaaaaaaa?record=rec_aaaaaaaaaaaaaaaa',
      lost: false,
    },
    {
      name: 'record the caller cannot read any more: no link',
      item: notification({ entity: { type: 'record', id: 'rec_a', title: null } }),
      link: null,
      lost: true,
    },
    {
      name: 'automation opens its builder',
      item: notification({
        type: 'automation.disabled',
        entity: { type: 'automation', id: 'aut_a', title: 'Sync' },
      }),
      link: '/b/bse_aaaaaaaaaaaaaaaa/automations/aut_a',
      lost: false,
    },
    {
      name: 'base the caller cannot open: no link',
      item: notification({ base: null }),
      link: null,
      lost: true,
    },
    {
      name: 'table',
      item: notification({ entity: { type: 'table', id: 'tbl_b', title: 'Orders' } }),
      link: '/b/bse_aaaaaaaaaaaaaaaa/t/tbl_b',
      lost: false,
    },
    {
      name: 'job (import.finished, T552): opens its table; no title is not "lost"',
      item: notification({
        type: 'import.finished',
        entity: { type: 'job', id: 'job_1', title: null },
      }),
      link: '/b/bse_aaaaaaaaaaaaaaaa/t/tbl_aaaaaaaaaaaaaaaa',
      lost: false,
    },
    {
      name: 'job without a table (cancelled while queued): no link',
      item: notification({ table_id: null, entity: { type: 'job', id: 'job_1', title: null } }),
      link: null,
      lost: false,
    },
    {
      name: 'job of a base the caller cannot open: lost, no link',
      item: notification({ base: null, entity: { type: 'job', id: 'job_1', title: null } }),
      link: null,
      lost: true,
    },
    {
      name: 'grouped record.assigned (table entity) the caller cannot view: lost',
      item: notification({
        type: 'record.assigned',
        entity: { type: 'table', id: 'tbl_aaaaaaaaaaaaaaaa', title: null },
      }),
      link: null,
      lost: true,
    },
  ];
  it.each(cases)('$name', ({ item, link, lost }) => {
    expect(linkOf(item)).toBe(link);
    expect(lostAccess(item)).toBe(lost);
  });
});

describe('isMandatory', () => {
  it.each([
    ['automation.message', false],
    ['automation.disabled', true],
    ['automation.batch_overflow', false],
    ['record.assigned', false],
    ['date.reminder', false],
    ['comment.mentioned', false],
  ] as const)('%s', (type, mandatory) => {
    expect(isMandatory({ type })).toBe(mandatory);
  });
});

function message(id: string, automation: string, minutesAgo: number): NotificationDto {
  return notification({
    id: id as NotificationDto['id'],
    data: { automation_id: automation, run_id: 'run_a', title: id, body: '' },
    created_at: new Date(
      Date.parse('2026-10-05T10:00:00.000Z') - minutesAgo * 60_000,
    ).toISOString(),
  });
}

function shape(rows: readonly PanelRow[]): string[] {
  return rows.map((row) =>
    row.kind === 'item' ? row.item.id : `group(${row.items.map((item) => item.id).join(',')})`,
  );
}

describe('groupRows', () => {
  const disabled = notification({ id: 'ntf_x', type: 'automation.disabled' });
  const cases: { name: string; items: NotificationDto[]; rows: string[] }[] = [
    { name: 'empty', items: [], rows: [] },
    {
      name: 'two in a row stay single',
      items: [message('a', 'aut_1', 0), message('b', 'aut_1', 1)],
      rows: ['a', 'b'],
    },
    {
      name: 'three in a row of one automation group',
      items: [message('a', 'aut_1', 0), message('b', 'aut_1', 1), message('c', 'aut_1', 2)],
      rows: ['group(a,b,c)'],
    },
    {
      name: 'another automation breaks the run',
      items: [
        message('a', 'aut_1', 0),
        message('b', 'aut_2', 1),
        message('c', 'aut_1', 2),
        message('d', 'aut_1', 3),
      ],
      rows: ['a', 'b', 'c', 'd'],
    },
    {
      name: 'older than an hour from the newest is left out',
      items: [
        message('a', 'aut_1', 0),
        message('b', 'aut_1', 10),
        message('c', 'aut_1', 59),
        message('d', 'aut_1', 61),
      ],
      rows: ['group(a,b,c)', 'd'],
    },
    {
      name: 'other types are never grouped',
      items: [
        disabled,
        message('a', 'aut_1', 0),
        message('b', 'aut_1', 1),
        message('c', 'aut_1', 1),
      ],
      rows: ['ntf_x', 'group(a,b,c)'],
    },
  ];
  it.each(cases)('$name', ({ items, rows }) => {
    expect(shape(groupRows(items))).toEqual(rows);
  });
});

describe('basesOf', () => {
  it('lists each base once, in order, without null', () => {
    const other = { id: 'bse_bbbbbbbbbbbbbbbb', name: 'Ops' } as const;
    expect(
      basesOf([{ base: BASE }, { base: null }, { base: other }, { base: BASE }]).map(
        (base) => base.name,
      ),
    ).toEqual(['Sales', 'Ops']);
  });
});

describe('badgeText', () => {
  const format = (value: number) => new Intl.NumberFormat('en').format(value);
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1000, '999+'],
  ])('%i → %s', (count, text) => {
    expect(badgeText(count, format)).toBe(text);
  });
});

describe('catalogue copies (CONTRACTS §22)', () => {
  it('match the contract', () => {
    expect([...MANDATORY_TYPES].sort()).toEqual([...MANDATORY_NOTIFICATION_TYPES].sort());
    expect([...EMAIL_FREQUENCY_OPTIONS].sort()).toEqual([...EMAIL_FREQUENCIES].sort());
  });
});
