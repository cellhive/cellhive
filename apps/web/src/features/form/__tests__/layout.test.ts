import { describe, expect, it } from 'vitest';

import { questionsOf } from '../model/questions';
import { isShortQuestion } from '../renderer/FormRenderer';
import { memberChoices } from '../renderer/QuestionInput';

import type { FormRendererField } from '../../../lib/forms/renderer';
import type { StoredFormSettings } from '@cellhive/contracts';

const fields: FormRendererField[] = [
  {
    id: 'fld_title',
    name: 'Title',
    type: 'text',
    options: {},
    description: null,
    is_primary: true,
  },
  { id: 'fld_notes', name: 'Notes', type: 'text', options: {}, description: null },
  {
    id: 'fld_phone',
    name: 'Phone',
    type: 'text',
    options: { style: { type: 'phone' } },
    description: null,
  },
  { id: 'fld_amount', name: 'Amount', type: 'number', options: {}, description: null },
  {
    id: 'fld_due',
    name: 'Due',
    type: 'datetime',
    options: { style: { format: 'dd/MM/yyyy' } },
    description: null,
  },
  {
    id: 'fld_level',
    name: 'Level',
    type: 'select',
    options: { multiple: false, options: [{ id: 'opt_a', name: 'A' }] },
    description: null,
  },
];

function form(): StoredFormSettings {
  return {
    title: '',
    description: '',
    cover_attachment_id: null,
    fields: fields.map((field) => ({ field: field.id, required: false, label: null, help: null })),
    success_message: '',
    redirect_url: null,
    allow_multiple_submissions: true,
    require_login: false,
    submission_limit: 'none',
  };
}

describe('form layout (design "Form công khai", T320)', () => {
  it('puts short answers two per row, long ones and pills across the card', () => {
    const short = Object.fromEntries(
      questionsOf(form(), fields).map((question) => [
        question.field.name,
        isShortQuestion(question),
      ]),
    );
    expect(short).toEqual({
      Title: false,
      Notes: false,
      Phone: true,
      Amount: true,
      Due: true,
      // Few options: horizontal pills, across the card.
      Level: false,
    });
  });

  it('names people, with their email only when needed', () => {
    expect(
      memberChoices([
        { id: 'usr_a', name: 'Minh', email: 'minh@x.test' },
        { id: 'usr_b', name: 'Lan', email: 'lan@x.test' },
        { id: 'usr_c', name: ' lan ', email: 'lan2@x.test' },
        { id: 'usr_d', name: '', email: 'nobody@x.test' },
      ]),
    ).toEqual([
      { value: 'usr_a', label: 'Minh' },
      { value: 'usr_b', label: 'Lan', detail: 'lan@x.test' },
      { value: 'usr_c', label: 'lan', detail: 'lan2@x.test' },
      { value: 'usr_d', label: 'nobody@x.test' },
    ]);
  });
});
