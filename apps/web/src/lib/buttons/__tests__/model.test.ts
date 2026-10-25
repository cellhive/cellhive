import { describe, expect, it } from 'vitest';

import { buttonColumnOf, buttonKey, buttonViewOf } from '../model';

import type { FieldDto } from '@cellhive/contracts';

function field(options: Record<string, unknown>, extra: Partial<FieldDto> = {}) {
  return { type: 'button', options, ...extra } as Pick<FieldDto, 'type' | 'options' | 'button'>;
}

describe('buttonColumnOf (T525, CONTRACTS §2 ButtonFieldOptions)', () => {
  it.each([
    ['saved options', { label: 'Approve', color: 5, confirm: null }, 'Approve', 5, null],
    ['defaults when missing', {}, 'Run', 0, null],
    ['blank label falls back', { label: '  ', color: 99 }, 'Run', 0, null],
    ['a colour out of range', { label: 'Go', color: -1 }, 'Go', 0, null],
    [
      'a confirmation',
      { label: 'Go', confirm: { title: 'Sure?', message: 'No undo.', confirm_label: 'Yes' } },
      'Go',
      0,
      { title: 'Sure?', message: 'No undo.', confirm_label: 'Yes' },
    ],
    [
      'an incomplete confirmation is none',
      { label: 'Go', confirm: { title: '', confirm_label: 'Yes' } },
      'Go',
      0,
      null,
    ],
  ])('%s', (_name, options, label, color, confirm) => {
    const column = buttonColumnOf(field(options));
    expect(column?.label).toBe(label);
    expect(column?.color).toBe(color);
    expect(column?.confirm).toEqual(confirm);
  });

  it('is undefined for other types and keeps the automation summary', () => {
    expect(buttonColumnOf({ type: 'text', options: {} })).toBeUndefined();
    const summary = {
      automation_id: 'aut_0123456789ABCDEF',
      automation_enabled: true,
      min_permission: 'read',
    } as const;
    expect(buttonColumnOf(field({}, { button: summary }))?.summary).toEqual(summary);
  });
});

describe('buttonViewOf (CONTRACTS §2 button cell)', () => {
  it.each([
    [{ state: 'ready', reason: null }, false, { state: 'ready' }],
    [{ state: 'ready', reason: null }, true, { state: 'running' }],
    [{ state: 'disabled', reason: 'condition' }, false, { state: 'disabled', reason: 'condition' }],
    [
      { state: 'disabled', reason: 'automation_disabled' },
      false,
      { state: 'disabled', reason: 'automation_disabled' },
    ],
    // Anything the server did not give never runs.
    [null, false, { state: 'disabled', reason: 'permission' }],
    ['Approve', false, { state: 'disabled', reason: 'permission' }],
    [{ state: 'disabled', reason: 'other' }, false, { state: 'disabled', reason: 'permission' }],
  ])('%j (running %s)', (value, running, view) => {
    expect(buttonViewOf(value, running)).toEqual(view);
  });

  it('keys a cell by record and field', () => {
    expect(buttonKey('rec_1', 'fld_2')).toBe('rec_1|fld_2');
  });
});
