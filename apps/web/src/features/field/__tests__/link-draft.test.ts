import { describe, expect, it } from 'vitest';

import {
  createBody,
  draftOf,
  needsConversion,
  updateBody,
  validateDraft,
  type FieldDraft,
} from '../draft';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers0000001';
const FILTER = { field: 'fld_Tier000000000001', operator: 'is_not_empty' };

function linkField(allowMultiple: boolean): FieldDto {
  return {
    id: 'fld_Customer00000001',
    table_id: 'tbl_Orders0000000001',
    name: 'Customer',
    type: 'link',
    options: {
      link_table: CUSTOMERS,
      bidirectional: false,
      allow_multiple: allowMultiple,
      record_filter: null,
      symmetric_field_id: null,
    },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe('link fields in the field dialog (T413, basic form)', () => {
  it('needs a linked table; creates with table, multiple and conditions', () => {
    const draft: FieldDraft = { ...draftOf(), name: 'Customer', type: 'link' };
    expect(validateDraft(draft).issues).toEqual([
      { path: 'options.link_table', detail: { code: 'REQUIRED' } },
    ]);
    const chosen: FieldDraft = {
      ...draft,
      link: { linkTable: CUSTOMERS, allowMultiple: true, recordFilter: FILTER },
    };
    expect(validateDraft(chosen).issues).toEqual([]);
    expect(createBody(chosen)).toEqual({
      name: 'Customer',
      type: 'link',
      options: { link_table: CUSTOMERS, allow_multiple: true, record_filter: FILTER },
    });
  });

  it('edits send only allow_multiple (one → several) and the conditions, never the table', () => {
    const saved = linkField(false);
    const draft = draftOf(saved);
    expect(draft.type).toBe('link');
    expect(draft.link).toEqual({ linkTable: CUSTOMERS, allowMultiple: false, recordFilter: null });
    expect(updateBody(saved, draft)).toBeNull();
    const next: FieldDraft = {
      ...draft,
      link: { linkTable: 'tbl_Other00000000001', allowMultiple: true, recordFilter: FILTER },
    };
    expect(updateBody(saved, next)).toEqual({
      options: { allow_multiple: true, record_filter: FILTER },
    });
    expect(needsConversion(saved, next)).toBe(false);
  });

  it('several → one record is a conversion (T415)', () => {
    const saved = linkField(true);
    const draft = draftOf(saved);
    expect(
      needsConversion(saved, { ...draft, link: { ...draft.link, allowMultiple: false } }),
    ).toBe(true);
  });
});
