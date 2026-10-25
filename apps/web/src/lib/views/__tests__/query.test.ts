import { describe, expect, it } from 'vitest';

import { recordQueryHash } from '../../query/keys';
import { countConditions, viewRecordQuery } from '../query';

import type { EffectiveViewConfig } from '../config';

const SAVED: EffectiveViewConfig = {
  filter: { op: 'and', items: [{ field: 'fld_A', operator: 'is_empty' }] },
  sort: [{ field: 'fld_A', direction: 'asc' }],
  group: [{ field: 'fld_B', direction: 'asc' }],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: true },
};

describe('viewRecordQuery (T311)', () => {
  it('reads through the view with its saved sort when nothing changed', () => {
    expect(viewRecordQuery('viw_1', SAVED, SAVED)).toEqual({
      view_id: 'viw_1',
      sort: [{ field: 'fld_A', direction: 'asc' }],
    });
    expect(viewRecordQuery('viw_1', { ...SAVED, sort: [] }, { ...SAVED, sort: [] })).toEqual({
      view_id: 'viw_1',
    });
  });

  it('replaces the saved filter and sort with changed ones', () => {
    const filter = { op: 'and', items: [{ field: 'fld_B', operator: 'is_not_empty' }] };
    const sort = [{ field: 'fld_B', direction: 'desc' as const }];
    expect(viewRecordQuery('viw_1', SAVED, { ...SAVED, filter, sort })).toEqual({
      view_id: 'viw_1',
      filter,
      filter_mode: 'replace',
      sort,
      sort_mode: 'replace',
    });
  });

  it('removing every filter condition or sort key still replaces the saved ones', () => {
    const query = viewRecordQuery('viw_1', SAVED, { ...SAVED, filter: null, sort: [], group: [] });
    expect(query).toEqual({
      view_id: 'viw_1',
      filter: null,
      filter_mode: 'replace',
      sort_mode: 'replace',
      group: [],
    });
    // Each of these is another set of rows: another cache key.
    expect(recordQueryHash(query)).not.toBe(
      recordQueryHash(viewRecordQuery('viw_1', SAVED, SAVED)),
    );
  });

  it('adds the trimmed search', () => {
    expect(viewRecordQuery('viw_1', SAVED, SAVED, '  an phat ')).toMatchObject({
      search: 'an phat',
    });
    expect(viewRecordQuery('viw_1', SAVED, SAVED, '   ')).not.toHaveProperty('search');
  });

  it('counts the conditions of a filter', () => {
    expect(countConditions(null)).toBe(0);
    expect(countConditions(SAVED.filter)).toBe(1);
    expect(
      countConditions({
        op: 'or',
        items: [
          { field: 'a', operator: 'is_empty' },
          { op: 'not', item: { field: 'b', operator: 'is_empty' } },
          { op: 'and', items: [] },
        ],
      }),
    ).toBe(2);
  });
});
