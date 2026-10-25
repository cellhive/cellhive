import { describe, expect, it } from 'vitest';

import {
  changedKeys,
  effectiveConfig,
  omitKeys,
  parseDraft,
  pickKeys,
  serializeDraft,
  type EffectiveViewConfig,
  type ViewConfigPatch,
} from '../config';

const A = 'fld_A000000000000001';

const SAVED: EffectiveViewConfig = {
  filter: null,
  sort: [],
  group: [],
  hidden_fields: [],
  field_order: [],
  column_widths: {},
  frozen_count: 1,
  row_height: 'short',
  tree: { enabled: false, show_ancestors: true },
};

const FORM = {
  title: 'Support',
  description: '',
  cover_attachment_id: null,
  fields: [{ field: A, required: true }],
  success_message: '',
  redirect_url: null,
  allow_multiple_submissions: true,
  require_login: false,
  submission_limit: 'none' as const,
};

describe('parseDraft (untrusted localStorage)', () => {
  it.each<[string, string | null, ViewConfigPatch]>([
    ['nothing stored', null, {}],
    ['not JSON', '{oops', {}],
    ['not an object', '[1]', {}],
    [
      'a valid draft',
      JSON.stringify({ hidden_fields: [A], row_height: 'tall' }),
      { hidden_fields: [A], row_height: 'tall' },
    ],
    [
      'a sort item gets its default direction',
      JSON.stringify({ sort: [{ field: A }] }),
      { sort: [{ field: A, direction: 'asc' }] },
    ],
    ['an unknown key drops the whole draft', JSON.stringify({ hidden_fields: [A], evil: 1 }), {}],
    ['a bad id drops the whole draft', JSON.stringify({ hidden_fields: ['x'] }), {}],
    ['a width out of the contract range', JSON.stringify({ column_widths: { [A]: 5 } }), {}],
    [
      'a whole form (T315)',
      JSON.stringify({ form: FORM }),
      { form: { ...FORM, fields: [{ field: A, required: true, label: null, help: null }] } },
    ],
    ['a partial form is dropped', JSON.stringify({ form: { title: 'Only a title' } }), {}],
    [
      'a form with a non-http redirect is dropped',
      JSON.stringify({ form: { ...FORM, redirect_url: 'javascript:alert(1)' } }),
      {},
    ],
  ])('%s', (_label, raw, expected) => {
    expect(parseDraft(raw)).toEqual(expected);
  });

  it('round-trips; an empty draft is not stored', () => {
    expect(serializeDraft({})).toBeNull();
    const draft: ViewConfigPatch = { column_widths: { [A]: 120 }, frozen_count: 2 };
    expect(parseDraft(serializeDraft(draft))).toEqual(draft);
  });
});

describe('effectiveConfig / changedKeys', () => {
  it('layers saved, then pending, then temporary changes', () => {
    const config = effectiveConfig(
      SAVED,
      { frozen_count: 2, row_height: 'medium' },
      { row_height: 'tall' },
    );
    expect(config.frozen_count).toBe(2);
    expect(config.row_height).toBe('tall');
    expect(effectiveConfig(SAVED, {}, {})).toBe(SAVED);
  });

  it('lists only temporary changes that differ from the saved config', () => {
    expect(
      changedKeys(SAVED, {
        frozen_count: 1,
        column_widths: {},
        hidden_fields: [A],
        sort: [{ field: A, direction: 'asc' }],
      }),
    ).toEqual(['hidden_fields', 'sort']);
  });

  it('picks and omits keys', () => {
    const patch: ViewConfigPatch = { frozen_count: 2, hidden_fields: [A] };
    expect(pickKeys(patch, ['frozen_count'])).toEqual({ frozen_count: 2 });
    expect(omitKeys(patch, ['frozen_count'])).toEqual({ hidden_fields: [A] });
  });
});
