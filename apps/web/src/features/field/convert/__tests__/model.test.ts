import { describe, expect, it } from 'vitest';

import { draftOf, type FieldDraft } from '../../draft';
import {
  canChangeType,
  conversionRequestOf,
  groupOf,
  isRefused,
  linkChangeOf,
  requiredConsents,
  sampleNames,
  sampleText,
  settingsKindOf,
  styleCheckOf,
  targetChoices,
  truthyValuesOf,
} from '../model';

import type { ConvertFieldPreview, FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-26T00:00:00.000Z';
const CUSTOMERS = 'tbl_Customers0000001';

function field(type: string, options: Record<string, unknown> = {}): FieldDto {
  return {
    id: 'fld_Code000000000001',
    table_id: 'tbl_Orders0000000001',
    name: 'Code',
    type: type as FieldDto['type'],
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

const LINK = (extra: Record<string, unknown> = {}) =>
  field('link', {
    link_table: CUSTOMERS,
    bidirectional: false,
    allow_multiple: true,
    record_filter: null,
    symmetric_field_id: null,
    ...extra,
  });

function preview(overrides: Partial<ConvertFieldPreview> = {}): ConvertFieldPreview {
  return {
    allowed: true,
    reason: null,
    kind: 'keep',
    requires_confirm: false,
    requires_accept_data_loss: false,
    unique_values_reset: false,
    affected: 10,
    lost: 0,
    truncated: 0,
    new_options: [],
    samples: [],
    dependents: [],
    ...overrides,
  };
}

describe('target types of the picker (CONTRACTS §4)', () => {
  const kinds = (source: FieldDto) =>
    Object.fromEntries(targetChoices(source).map((choice) => [choice.type, choice.kind]));

  it('text: kept, lost and never, the current type first', () => {
    expect(kinds(field('text'))).toMatchObject({
      text: 'none',
      number: 'keep',
      select: 'keep',
      datetime: 'keep',
      checkbox: 'blacklist',
      user: 'blacklist',
      link: 'forbidden',
      created_at: 'forbidden',
      auto_number: 'forbidden',
      attachment: 'forbidden',
    });
  });

  it.each([
    ['created_at', 'noColumn'],
    ['auto_number', 'noColumn'],
    ['link', 'otherKind'],
    ['attachment', 'otherKind'],
  ])('refuses %s with the reason %s', (type, refusal) => {
    const choice = targetChoices(field('number')).find((item) => item.type === type);
    expect(choice?.refusal).toBe(refusal);
    expect(choice === undefined ? null : groupOf(choice)).toBe('forbidden');
  });

  it('select → number is lost, number → text kept', () => {
    expect(kinds(field('select', { multiple: false, options: [] }))['number']).toBe('blacklist');
    expect(kinds(field('number'))['text']).toBe('keep');
  });

  it('link and attachment never change type', () => {
    expect(canChangeType(LINK())).toBe(false);
    expect(canChangeType(field('attachment'))).toBe(false);
    expect(canChangeType(field('text'))).toBe(true);
    expect(
      targetChoices(LINK()).every(
        (choice) => choice.type === 'link' || choice.refusal === 'fixedSource',
      ),
    ).toBe(true);
  });
});

describe('conversion bodies', () => {
  it('a new type sends the full definition and the settings of the pair', () => {
    const source = field('text');
    const draft: FieldDraft = { ...draftOf(source), type: 'select' };
    expect(conversionRequestOf(source, draft)).toEqual({
      type: 'select',
      options: { multiple: false, options: [], default_value: null },
    });
    expect(
      conversionRequestOf(source, draft, {
        matchExistingOnly: true,
        truthyValues: '',
        matchEmail: false,
      }),
    ).toMatchObject({ conversion: { match_existing_only: true } });
    const checkbox: FieldDraft = { ...draftOf(source), type: 'checkbox' };
    expect(
      conversionRequestOf(source, checkbox, {
        matchExistingOnly: false,
        truthyValues: 'Có, x, , Có',
        matchEmail: false,
      }),
    ).toEqual({ type: 'checkbox', conversion: { truthy_values: ['Có', 'x'] } });
  });

  it('several values → one is a conversion of the same type', () => {
    const source = field('select', { multiple: true, options: [] });
    const draft = draftOf(source);
    expect(conversionRequestOf(source, draft)).toBeNull();
    expect(
      conversionRequestOf(source, { ...draft, select: { ...draft.select, multiple: false } }),
    ).toMatchObject({ type: 'select', options: { multiple: false } });
  });

  it('nothing to convert: null', () => {
    const source = field('number');
    expect(conversionRequestOf(source, draftOf(source))).toBeNull();
  });

  it('links send only the change (T415)', () => {
    const oneWay = LINK();
    const draft = draftOf(oneWay);
    const twoWay: FieldDraft = {
      ...draft,
      link: { ...draft.link, bidirectional: true, reverseName: ' Orders ' },
    };
    expect(linkChangeOf(oneWay, twoWay)).toBe('to_two_way');
    expect(conversionRequestOf(oneWay, twoWay)).toEqual({
      type: 'link',
      options: { bidirectional: true, bidirectional_link_field_name: 'Orders' },
    });
    const single: FieldDraft = { ...draft, link: { ...draft.link, allowMultiple: false } };
    expect(conversionRequestOf(oneWay, single)).toEqual({
      type: 'link',
      options: { allow_multiple: false },
    });
    const saved = LINK({
      bidirectional: true,
      bidirectional_link_field_name: 'Orders',
      symmetric_field_id: 'fld_Orders0000000001',
    });
    const savedDraft = draftOf(saved);
    expect(savedDraft.link).toMatchObject({
      bidirectional: true,
      reverseName: 'Orders',
      symmetricFieldId: 'fld_Orders0000000001',
    });
    const off: FieldDraft = { ...savedDraft, link: { ...savedDraft.link, bidirectional: false } };
    expect(linkChangeOf(saved, off)).toBe('to_one_way');
    expect(conversionRequestOf(saved, off)).toEqual({
      type: 'link',
      options: { bidirectional: false },
    });
  });

  it('email / phone style: a check, not a conversion', () => {
    const source = field('text', { style: { type: 'plain' } });
    const draft = draftOf(source);
    const email: FieldDraft = { ...draft, text: { ...draft.text, style: { type: 'email' } } };
    expect(conversionRequestOf(source, email)).toBeNull();
    expect(styleCheckOf(source, email)).toEqual({
      type: 'text',
      options: { style: { type: 'email' }, default_value: null },
    });
    const url: FieldDraft = { ...draft, text: { ...draft.text, style: { type: 'url' } } };
    expect(styleCheckOf(source, url)).toBeNull();
  });

  it.each([
    ['text', 'select', 'selectMatch'],
    ['number', 'select', 'selectMatch'],
    ['select', 'checkbox', 'truthyValues'],
    ['text', 'user', 'matchEmail'],
    ['number', 'text', null],
  ])('%s → %s asks for %s', (from, to, kind) => {
    expect(settingsKindOf(from, to)).toBe(kind);
  });

  it('reads the checked values', () => {
    expect(truthyValuesOf(' Có ; x\nyes, Có ')).toEqual(['Có', 'x', 'yes']);
  });
});

describe('what the preview asks for', () => {
  it.each([
    [preview(), { confirm: false, acceptDataLoss: false }],
    [preview({ lost: 12 }), { confirm: true, acceptDataLoss: false }],
    [preview({ truncated: 3, kind: 'truncate' }), { confirm: true, acceptDataLoss: false }],
    [preview({ requires_confirm: true }), { confirm: true, acceptDataLoss: false }],
    [
      preview({ kind: 'blacklist', requires_accept_data_loss: true }),
      { confirm: false, acceptDataLoss: true },
    ],
  ])('%#', (answer, consents) => {
    expect(requiredConsents(answer)).toEqual(consents);
  });

  it('refused previews', () => {
    expect(isRefused(preview({ allowed: false, reason: 'TOO_MANY_OPTIONS' }))).toBe(true);
    expect(isRefused(preview({ kind: 'forbidden' }))).toBe(true);
    expect(isRefused(preview())).toBe(false);
  });

  it.each([
    [null, ''],
    ['abc', 'abc'],
    [12.5, '12.5'],
    [true, '✓'],
    [['A', 'B'], 'A, B'],
    [
      [
        { id: 'rec_1', title: 'An Phát' },
        { id: 'rec_2', title: null },
      ],
      'An Phát, rec_2',
    ],
    [{ id: 'usr_1', name: 'Hà' }, 'Hà'],
  ])('sample text of %j', (value, text) => {
    expect(sampleText(value)).toBe(text);
  });

  it('names of select samples', () => {
    expect(sampleNames(['A', 'B'])).toEqual(['A', 'B']);
    expect(sampleNames('A')).toEqual(['A']);
    expect(sampleNames(null)).toEqual([]);
  });
});
