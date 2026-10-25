import { describe, expect, it } from 'vitest';

import { targetChoices } from '../convert/model';
import {
  buttonLabelOf,
  createBody,
  CREATABLE_TYPES,
  draftOf,
  needsConversion,
  updateBody,
  validateDraft,
  type FieldDraft,
} from '../draft';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-10-06T00:00:00.000Z';

function buttonField(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Approve000000001',
    table_id: 'tbl_Orders0000000001',
    name: 'Duyệt nhanh',
    type: 'button',
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
    button: { automation_id: null, automation_enabled: false, min_permission: null },
  };
}

const newButton = (change: (draft: FieldDraft) => FieldDraft = (d) => d): FieldDraft =>
  change({ ...draftOf(), name: 'Duyệt nhanh', type: 'button' });

describe('button fields in the field dialog (T525)', () => {
  it('can be created', () => {
    expect(CREATABLE_TYPES).toContain('button');
  });

  it.each([
    [
      'the name as label, grey, no confirmation',
      (draft: FieldDraft) => draft,
      { label: 'Duyệt nhanh', color: 0, confirm: null },
    ],
    [
      'its own label and color',
      (draft: FieldDraft) => ({ ...draft, button: { ...draft.button, label: 'Duyệt', color: 5 } }),
      { label: 'Duyệt', color: 5, confirm: null },
    ],
    [
      'a confirmation, trimmed',
      (draft: FieldDraft) => ({
        ...draft,
        button: {
          ...draft.button,
          confirm: true,
          confirmTitle: ' Duyệt đơn này? ',
          confirmMessage: 'Không hoàn tác được. ',
          confirmLabel: 'Duyệt ',
        },
      }),
      {
        label: 'Duyệt nhanh',
        color: 0,
        confirm: {
          title: 'Duyệt đơn này?',
          message: 'Không hoàn tác được.',
          confirm_label: 'Duyệt',
        },
      },
    ],
  ])('creates with %s', (_name, change, options) => {
    const draft = newButton(change);
    expect(validateDraft(draft).issues).toEqual([]);
    expect(createBody(draft)).toEqual({ name: 'Duyệt nhanh', type: 'button', options });
  });

  it('asks for the confirmation title and button text', () => {
    const draft = newButton((d) => ({ ...d, button: { ...d.button, confirm: true } }));
    const paths = validateDraft(draft).issues.map((issue) => issue.path);
    expect(paths).toEqual(['options.confirm.title', 'options.confirm.confirm_label']);
  });

  it('reads a saved button and sends only what changed', () => {
    const field = buttonField({
      label: 'Duyệt',
      color: 5,
      confirm: { title: 'Duyệt?', message: '', confirm_label: 'Duyệt' },
    });
    const draft = draftOf(field);
    expect(draft.type).toBe('button');
    expect(draft.button).toEqual({
      label: 'Duyệt',
      color: 5,
      confirm: true,
      confirmTitle: 'Duyệt?',
      confirmMessage: '',
      confirmLabel: 'Duyệt',
    });
    expect(updateBody(field, draft)).toBeNull();
    expect(needsConversion(field, draft)).toBe(false);
    const off = { ...draft, button: { ...draft.button, confirm: false } };
    expect(updateBody(field, off)).toEqual({
      options: { label: 'Duyệt', color: 5, confirm: null },
    });
  });

  it('labels with the name when the label is blank', () => {
    expect(buttonLabelOf({ name: ' Gửi ', button: newButton().button })).toBe('Gửi');
  });

  it('never converts: no type becomes a button, a button becomes nothing', () => {
    const text = { type: 'text', options: {}, is_primary: false } as const;
    expect(targetChoices(text).find((choice) => choice.type === 'button')?.kind).toBe('forbidden');
    const button = buttonField({ label: 'Go' });
    expect(
      targetChoices(button).every(
        (choice) => choice.type === 'button' || choice.kind === 'forbidden',
      ),
    ).toBe(true);
  });
});
