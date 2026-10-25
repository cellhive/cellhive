import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createTestI18n, localeResources } from '../../../test/i18n';
import { columnHeaderLabel, typeLabelKey, useColumnHeaderLabels } from '../a11y';
import { toGridField } from '../types';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';

function field(type: string, options: Record<string, unknown> = {}, extra: Partial<FieldDto> = {}) {
  return toGridField({
    id: 'fld_Status0000000001',
    table_id: 'tbl_Tickets000000001',
    name: 'Status',
    type: type as FieldDto['type'],
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    ...extra,
  });
}

const FIELDS = [
  field('text'),
  field('text', { style: { type: 'url' } }),
  field('text', { style: { type: 'email' } }),
  field('text', { style: { type: 'phone' } }),
  field('text', { style: { type: 'barcode' } }),
  field('number'),
  field('number', { style: { type: 'plain', percentage: true } }),
  field('number', { style: { type: 'currency', currency_code: 'USD' } }),
  field('number', { style: { type: 'progress' } }),
  field('number', { style: { type: 'rating' } }),
  field('select'),
  field('select', { multiple: true }),
  field('datetime'),
  field('checkbox'),
  field('user'),
  field('created_at'),
  field('updated_at'),
  field('created_by'),
  field('updated_by'),
  field('auto_number'),
  field('link'),
  field('parent'),
  field('lookup'),
  field('formula'),
  field('attachment'),
];

describe('column header labels (FRONTEND §9.2)', () => {
  it.each(['en', 'vi'] as const)('has a %s name for every type and style', (language) => {
    const types = (localeResources()[language]?.['grid'] as { types: Record<string, string> })
      .types;
    for (const item of FIELDS) {
      const key = typeLabelKey(item).replace(/^types\./u, '');
      expect(types[key], key).toBeTypeOf('string');
    }
  });

  it('names the field and its type, and marks the primary field', async () => {
    const i18n = await createTestI18n('en');
    const t = i18n.getFixedT('en', 'grid');
    expect(columnHeaderLabel(field('select', { multiple: true }), t)).toBe(
      'Status, multiple select',
    );
    expect(columnHeaderLabel(field('text', {}, { is_primary: true, name: 'Title' }), t)).toBe(
      'Title, text, primary field',
    );
    const vi = (await createTestI18n('vi')).getFixedT('vi', 'grid');
    expect(
      columnHeaderLabel(field('number', { style: { type: 'currency', currency_code: 'VND' } }), vi),
    ).toBe('Status, tiền tệ');
  });

  it("labels glide's header cells by aria-colindex and again after re-renders", async () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<table role="grid"><thead><tr>' +
      '<th role="columnheader" aria-colindex="1">Title</th>' +
      '<th role="columnheader" aria-colindex="2">Status</th>' +
      '</tr></thead></table>';
    renderHook(() => {
      useColumnHeaderLabels(container, ['Title, text', 'Status, single select'], 0);
    });
    const headers = container.querySelectorAll('th');
    expect(headers[0]?.getAttribute('aria-label')).toBe('Title, text');
    expect(headers[1]?.getAttribute('aria-label')).toBe('Status, single select');

    // Glide re-renders the header row when the visible columns change.
    const row = container.querySelector('tr');
    row?.insertAdjacentHTML('beforeend', '<th role="columnheader" aria-colindex="3">Extra</th>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelectorAll('th')[2]?.hasAttribute('aria-label')).toBe(false);
    headers[1]?.removeAttribute('aria-label');
    row?.insertAdjacentHTML('beforeend', '<td></td>');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(headers[1]?.getAttribute('aria-label')).toBe('Status, single select');
  });
});
