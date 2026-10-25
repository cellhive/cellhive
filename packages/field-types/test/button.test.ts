import { describe, expect, it } from 'vitest';

import {
  buttonFieldType,
  buttonOptionsSchema,
  FIELD_TYPE_REGISTRY,
  getFieldType,
  isButtonFieldType,
} from '../src/index.js';

describe('button field type (T517)', () => {
  it('has no registry definition (no column, no stored value)', () => {
    expect(getFieldType('button')).toBeUndefined();
    expect(Object.keys(FIELD_TYPE_REGISTRY)).not.toContain('button');
    expect(buttonFieldType.readOnly).toBe(true);
    expect(buttonFieldType.supportsDefaultValue).toBe(false);
    expect(isButtonFieldType('button')).toBe(true);
    expect(isButtonFieldType('text')).toBe(false);
  });

  it('fills defaults', () => {
    expect(buttonOptionsSchema.parse({})).toEqual({ label: 'Run', color: 0, confirm: null });
  });

  it.each([
    ['a label and a colour', { label: '  Duyệt  ', color: 12 }, { label: 'Duyệt', color: 12 }],
    [
      'a confirmation',
      { label: 'Gửi', confirm: { title: 'Chắc chưa?', confirm_label: 'Gửi' } },
      { confirm: { title: 'Chắc chưa?', message: '', confirm_label: 'Gửi' } },
    ],
  ])('accepts %s', (_name, input, expected) => {
    expect(buttonOptionsSchema.parse(input)).toMatchObject(expected);
  });

  it.each([
    ['an empty label', { label: '   ' }],
    ['a label of 101 characters', { label: 'x'.repeat(101) }],
    ['a colour outside the palette', { color: 55 }],
    ['a fractional colour', { color: 1.5 }],
    ['an unknown key', { action: 'x' }],
    ['a confirmation without title', { confirm: { confirm_label: 'OK' } }],
    [
      'a message of 1 001 characters',
      { confirm: { title: 'T', confirm_label: 'OK', message: 'm'.repeat(1001) } },
    ],
  ])('rejects %s', (_name, input) => {
    expect(buttonOptionsSchema.safeParse(input).success).toBe(false);
  });

  it('renders the label as text', () => {
    const options = buttonOptionsSchema.parse({ label: 'Duyệt' });
    expect(buttonFieldType.formatText({ state: 'ready', reason: null }, options)).toBe('Duyệt');
  });
});
