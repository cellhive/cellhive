import { describe, expect, it } from 'vitest';

import { linkDetails } from '../model/link-details';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-28T00:00:00.000Z';
const CODE = 'fld_Code000000000001';
const CITY = 'fld_City000000000001';
const TIER = 'fld_Tier000000000001';

function field(id: string, type: string, options: object = {}): FieldDto {
  return {
    id,
    table_id: 'tbl_Customers0000001',
    name: id,
    type,
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

const DISPLAY = [
  { id: CODE, name: 'Code', type: 'text' },
  { id: CITY, name: 'City', type: 'text' },
  { id: TIER, name: 'Tier', type: 'select' },
];
const FIELDS = [
  field(CODE, 'text'),
  field(CITY, 'text'),
  field(TIER, 'select', {
    multiple: false,
    options: [{ id: 'opt_Gold000000000001', name: 'Vàng' }],
  }),
];
const CTX = { locale: 'vi', timeZone: 'UTC' };

describe('linkDetails (T421a)', () => {
  it.each([
    [
      'formats every display value like the cell',
      { [CODE]: 'KH-1049', [CITY]: 'Hà Nội', [TIER]: 'Vàng' },
      FIELDS,
      ['KH-1049', 'Hà Nội', 'Vàng'],
    ],
    ['leaves empty values out', { [CODE]: 'KH-1', [CITY]: null, [TIER]: '' }, FIELDS, ['KH-1']],
    [
      'plain text when the linked fields are not known',
      { [CODE]: 'KH-2', [TIER]: 'Vàng' },
      undefined,
      ['KH-2'],
    ],
  ])('%s', (_name, values, fields, expected) => {
    expect(linkDetails({ fields: values }, DISPLAY, fields, CTX)).toEqual(expected);
  });
});
