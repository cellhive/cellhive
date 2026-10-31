import { describe, expect, it } from 'vitest';

import { draftExamples } from '../model/ai-examples';

import type { FieldDto } from '@cellhive/contracts';

const field = (name: string, type: string, options: unknown = null) =>
  ({ id: `fld_${name}`, name, type, options }) as unknown as FieldDto;

const status = field('Trạng thái', 'select', {
  options: [{ name: 'Mới' }, { name: 'Đã xong' }],
});
const tags = field('Tags', 'select', { multiple: true, options: [{ name: 'A' }] });
const empty = field('Empty', 'select', { options: [] });
const assignee = field('Phụ trách', 'user');
const due = field('Hạn', 'datetime');

describe('draftExamples (T913)', () => {
  it.each([
    [
      'status, date and user fields: three sentences naming them',
      [status, due, assignee],
      [
        [
          'ai.examples.status',
          { table: 'Tickets', field: 'Trạng thái', option: 'Đã xong', user: 'Phụ trách' },
        ],
        ['ai.examples.reminder', { table: 'Tickets', date: 'Hạn', user: 'Phụ trách' }],
        ['ai.examples.created', { table: 'Tickets', user: 'Phụ trách' }],
      ],
    ],
    [
      'no user field: generic sentences',
      [status, due],
      [
        ['ai.examples.genericStatus', {}],
        ['ai.examples.genericReminder', {}],
        ['ai.examples.genericCreated', {}],
      ],
    ],
    [
      'a multiple select or one without options is no status',
      [tags, empty, assignee],
      [
        ['ai.examples.genericStatus', {}],
        ['ai.examples.genericReminder', {}],
        ['ai.examples.created', { table: 'Tickets', user: 'Phụ trách' }],
      ],
    ],
    [
      'no fields yet',
      [],
      [
        ['ai.examples.genericStatus', {}],
        ['ai.examples.genericReminder', {}],
        ['ai.examples.genericCreated', {}],
      ],
    ],
  ] as const)('%s', (_name, fields, expected) => {
    expect(
      draftExamples('Tickets', fields).map((example) => [example.key, example.params]),
    ).toEqual(expected);
  });
});
