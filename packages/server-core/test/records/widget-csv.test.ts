import { describe, expect, it } from 'vitest';

import { widgetCsv } from '../../src/records/index.js';

import type { WidgetDataColumn } from '@cellhive/contracts';

const column = (
  key: string,
  role: WidgetDataColumn['role'],
  aggregation: WidgetDataColumn['aggregation'] = null,
): WidgetDataColumn => ({
  key,
  role,
  field_id: null,
  field_type: null,
  aggregation,
  date_bucket: null,
  bucket_width: null,
});

const BOM = '﻿';

describe('widgetCsv (T808)', () => {
  const columns = [
    column('dimension', 'dimension'),
    column('series', 'series'),
    column('m1', 'metric', 'count'),
    column('m2', 'metric', 'sum'),
  ];

  it('writes the aggregate table with labels, the empty group and "Other" last', () => {
    const result = widgetCsv(
      {
        columns,
        rows: [
          [{ value: 'opt_a', label: 'Mới' }, { value: 'usr_a', label: '=cmd' }, 2, 150.5],
          [{ value: null, label: null }, { value: true, label: null }, 1, null],
        ],
        other: { groups: 3, rows: [[null, { value: 'usr_b', label: 'B, "x"' }, 4, -10]] },
      },
      [
        { fieldName: 'status', label: null },
        { fieldName: 'owner', label: null },
        { fieldName: null, label: null },
        { fieldName: 'amount', label: null },
      ],
      'en',
    );
    expect(result.rowCount).toBe(3);
    expect(result.text).toBe(
      `${BOM}status,owner,Count,Sum of amount\r\n` +
        `Mới,'=cmd,2,150.5\r\n` +
        `(Empty),true,1,\r\n` +
        `Other,"B, ""x""",4,-10\r\n`,
    );
  });

  it('uses saved metric labels, Vietnamese defaults, and guards headers too', () => {
    const result = widgetCsv(
      {
        columns: [column('m1', 'metric', 'avg'), column('m2', 'metric', 'count_distinct')],
        rows: [[1.5, 3]],
      },
      [
        { fieldName: 'cost', label: '+Chi phí' },
        { fieldName: 'khách', label: null },
      ],
      'vi-VN',
    );
    expect(result).toEqual({
      text: `${BOM}'+Chi phí,Số khách khác nhau\r\n1.5,3\r\n`,
      rowCount: 1,
    });
  });

  it('writes only the header of an empty widget', () => {
    expect(widgetCsv({ columns: [column('m1', 'metric', 'max')], rows: [] }, [], 'vi')).toEqual({
      text: `${BOM}Lớn nhất\r\n`,
      rowCount: 0,
    });
  });

  it('never writes the id of a linked record the reader cannot read (QA S7, T819)', () => {
    const link = { ...column('dimension', 'dimension'), field_type: 'link' as const };
    const text = { ...column('series', 'series'), field_type: 'text' as const };
    const result = widgetCsv(
      {
        columns: [link, text, column('m1', 'metric', 'count')],
        rows: [
          [{ value: 'rec_0123456789abcdef', label: 'An Phát' }, { value: 'x', label: null }, 1],
          [{ value: 'rec_ABCDEFGHIJKLMNOP', label: null }, { value: 'y', label: null }, 2],
          [{ value: null, label: null }, { value: 'rec_ZZZZZZZZZZZZZZZZ', label: null }, 3],
        ],
        other: { groups: 2, rows: [[null, { value: 'rec_QQQQQQQQQQQQQQQQ', label: null }, 4]] },
      },
      [
        { fieldName: 'customer', label: null },
        { fieldName: 'note', label: null },
        { fieldName: null, label: null },
      ],
      'vi',
    );
    expect(result.text).not.toContain('rec_ABCDEFGHIJKLMNOP');
    expect(result.text).toBe(
      `${BOM}customer,note,Số lượng\r\n` +
        `An Phát,x,1\r\n` +
        `(Không có quyền),y,2\r\n` +
        // A text value that looks like an id is a value, not a record.
        `(Trống),rec_ZZZZZZZZZZZZZZZZ,3\r\n` +
        `Khác,rec_QQQQQQQQQQQQQQQQ,4\r\n`,
    );
  });
});
