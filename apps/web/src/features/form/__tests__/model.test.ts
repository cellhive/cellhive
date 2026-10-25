import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../lib/api/client';
import { limitReached, relativeTime, splitProblems, tokenProblem } from '../model/errors';
import { buildPrefillUrl, parsePrefill } from '../model/prefill';
import {
  addableFields,
  addQuestion,
  EMPTY_FORM,
  moveQuestion,
  questionsOf,
  redirectUrlOf,
  removeQuestion,
  updateQuestion,
  withSubmissionRules,
} from '../model/questions';
import { buildSubmission, isEmptyInput, prefillInput, writeValue } from '../model/values';

import type { FormRendererField } from '../../../lib/forms/renderer';
import type { StoredFormSettings } from '@cellhive/contracts';

const TITLE = 'fld_Title00000000001';
const PRIORITY = 'fld_Priority00000001';
const AMOUNT = 'fld_Amount0000000001';
const DUE = 'fld_Due0000000000001';
const DONE = 'fld_Done000000000001';
const TAGS = 'fld_Tags000000000001';
const CREATED = 'fld_Created000000001';
const OWNER = 'fld_Owner00000000001';

const field = (
  id: string,
  name: string,
  type: FormRendererField['type'],
  options: Record<string, unknown> = {},
  required = false,
): FormRendererField => ({ id, name, type, options, description: null, required });

const FIELDS: FormRendererField[] = [
  field(TITLE, 'Title', 'text', {}, true),
  field(PRIORITY, 'Priority', 'select', {
    options: [
      { id: 'opt_High000000000001', name: 'High' },
      { id: 'opt_Low0000000000001', name: 'Low' },
    ],
  }),
  field(AMOUNT, 'Amount', 'number', {
    style: { type: 'plain', precision: 0, percentage: false, thousands_separator: true },
  }),
  field(DUE, 'Due', 'datetime', { style: { format: 'dd/MM/yyyy' } }),
  field(DONE, 'Done', 'checkbox'),
  field(TAGS, 'Tags', 'select', {
    multiple: true,
    options: [
      { id: 'opt_A000000000000001', name: 'A' },
      { id: 'opt_B000000000000001', name: 'B' },
    ],
  }),
  field(CREATED, 'Created', 'created_at'),
  field(OWNER, 'Owner', 'user', { multiple: false }),
];

const form = (ids: string[], patch: Partial<StoredFormSettings> = {}): StoredFormSettings => ({
  ...EMPTY_FORM,
  fields: ids.map((id) => ({ field: id, required: false, label: null, help: null })),
  ...patch,
});

const CTX = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };

describe('questions', () => {
  it('uses the own label, else the field name; table-required fields are required', () => {
    const settings = updateQuestion(form([TITLE, PRIORITY, 'fld_Deleted000000001']), PRIORITY, {
      label: 'How urgent?',
      help: '  ',
    });
    const questions = questionsOf(settings, FIELDS);
    expect(questions.map((q) => [q.label, q.required, q.tableRequired, q.help])).toEqual([
      ['Title', true, true, null],
      ['How urgent?', false, false, null],
    ]);
  });

  it('offers only askable fields not on the form (no created_at)', () => {
    expect(addableFields(form([TITLE, PRIORITY]), FIELDS).map((f) => f.id)).toEqual([
      AMOUNT,
      DUE,
      DONE,
      TAGS,
      OWNER,
    ]);
  });

  it.each([
    [0, 2, [PRIORITY, AMOUNT, TITLE]],
    [2, 0, [AMOUNT, TITLE, PRIORITY]],
    [1, 1, [TITLE, PRIORITY, AMOUNT]],
    [0, 5, [TITLE, PRIORITY, AMOUNT]],
  ])('moves %i to %i', (from, to, expected) => {
    expect(
      moveQuestion(form([TITLE, PRIORITY, AMOUNT]), from, to).fields.map((f) => f.field),
    ).toEqual(expected);
  });

  it('adds with the table required flag, never removes a table-required field', () => {
    const titleField = FIELDS[0];
    const amountField = FIELDS[2];
    if (titleField === undefined || amountField === undefined) throw new TypeError('fixture');
    const added = addQuestion(form([]), titleField);
    expect(added.fields).toEqual([{ field: TITLE, required: true, label: null, help: null }]);
    expect(addQuestion(added, titleField)).toBe(added);
    expect(removeQuestion(added, titleField)).toBe(added);
    expect(removeQuestion(addQuestion(added, amountField), amountField).fields).toHaveLength(1);
  });

  it('keeps sign-in and the submission limit in step', () => {
    const limited = withSubmissionRules(form([]), { requireLogin: true, limit: 'once' });
    expect(limited).toMatchObject({
      require_login: true,
      submission_limit: 'once',
      allow_multiple_submissions: false,
    });
    // A limit without sign-in is not possible; turning sign-in off drops the limit.
    expect(withSubmissionRules(form([]), { limit: 'daily' }).submission_limit).toBe('none');
    expect(withSubmissionRules(limited, { requireLogin: false })).toMatchObject({
      require_login: false,
      submission_limit: 'none',
      allow_multiple_submissions: true,
    });
  });

  it.each([
    ['', null],
    ['  https://example.com/thanks ', 'https://example.com/thanks'],
    ['http://a.test', 'http://a.test'],
    ['javascript:alert(1)', undefined],
    ['ftp://a.test', undefined],
    ['not a url', undefined],
  ])('redirect url %j', (text, expected) => {
    expect(redirectUrlOf(text)).toBe(expected);
  });
});

describe('values', () => {
  const questions = questionsOf(form([TITLE, PRIORITY, AMOUNT, DUE, DONE, TAGS]), FIELDS);
  const config = (id: string) => {
    const question = questions.find((q) => q.field.id === id);
    if (question?.config === undefined || question.config === null) throw new TypeError(id);
    return question.config;
  };

  it.each([
    ['', true],
    ['  ', true],
    ['a', false],
    [[], true],
    [['A'], false],
    [false, true],
    [true, false],
  ])('isEmptyInput(%j) = %s', (value, empty) => {
    expect(isEmptyInput(value)).toBe(empty);
  });

  it.each([
    [PRIORITY, 'high', 'High'],
    [PRIORITY, 'opt_Low0000000000001', 'Low'],
    [PRIORITY, 'Unknown', ''],
    [TAGS, 'A, B, nope', ['A', 'B']],
    [DONE, 'Có', true],
    [DONE, 'no', false],
    // Shown in the field's format, as the question's input holds it (T320).
    [DUE, '25/09/2026', '25/09/2026'],
    [DUE, '2026-09-25', '25/09/2026'],
    [AMOUNT, ' 1.500 ', '1.500'],
  ])('prefill %s from %j', (id, raw, expected) => {
    expect(prefillInput(config(id), raw, CTX)).toEqual(expected);
  });

  it('reads dates typed in the field format, like the grid editor (T320)', () => {
    expect(writeValue(config(DUE), '25/09/2026', CTX)).toEqual({ ok: true, value: '2026-09-25' });
    expect(writeValue(config(DUE), '31/02/2026', CTX)).toMatchObject({
      ok: false,
      issue: { code: 'EXPECTED_DATE' },
    });
  });

  it('reads numbers in the locale and dates from the native picker', () => {
    expect(writeValue(config(AMOUNT), '1.500.000', CTX)).toEqual({ ok: true, value: 1_500_000 });
    expect(writeValue(config(AMOUNT), 'abc', CTX)).toMatchObject({
      ok: false,
      issue: { code: 'EXPECTED_NUMBER' },
    });
    expect(writeValue(config(DUE), '2026-09-25', CTX)).toEqual({ ok: true, value: '2026-09-25' });
    expect(writeValue(config(PRIORITY), 'Nope', CTX)).toMatchObject({
      ok: false,
      issue: { code: 'INVALID_SELECT_OPTION' },
    });
  });

  it('checks required questions, skips empty optional ones, sends hidden ones raw', () => {
    const settings = updateQuestion(form([TITLE, PRIORITY, AMOUNT, DONE]), DONE, {
      required: true,
    });
    const submission = buildSubmission(
      questionsOf(settings, FIELDS),
      { [TITLE]: '  ', [AMOUNT]: '', [DONE]: false },
      { [PRIORITY]: 'high' },
      CTX,
    );
    expect(submission.fields).toEqual({ [PRIORITY]: 'high' });
    expect(submission.issues).toEqual({
      [TITLE]: { code: 'REQUIRED_FIELD_MISSING' },
      [DONE]: { code: 'REQUIRED_FIELD_MISSING' },
    });
    const ok = buildSubmission(
      questions,
      { [TITLE]: 'Printer', [TAGS]: ['B'], [DONE]: true },
      {},
      CTX,
    );
    expect(ok).toEqual({ fields: { [TITLE]: 'Printer', [TAGS]: ['B'], [DONE]: true }, issues: {} });
  });
});

describe('prefill URL', () => {
  it('parses prefill_ and hide_ for field ids only', () => {
    const parsed = parsePrefill(
      `?form=fill&prefill_${TITLE}=M%C3%A1y%20in&hide_${TITLE}=1&prefill_bad=x&hide_${AMOUNT}=0`,
    );
    expect(parsed.values).toEqual({ [TITLE]: 'Máy in' });
    expect([...parsed.hidden]).toEqual([TITLE]);
    expect(parsePrefill(undefined).values).toEqual({});
  });

  it('builds a link, replacing old prefill parameters and skipping empty values', () => {
    const url = buildPrefillUrl(`https://ob.test/b/x/v/y?form=fill&prefill_${AMOUNT}=1`, [
      { fieldId: TITLE, value: 'Máy in', hide: true },
      { fieldId: AMOUNT, value: '', hide: true },
    ]);
    expect(url).toBe(
      `https://ob.test/b/x/v/y?form=fill&prefill_${TITLE}=M%C3%A1y+in&hide_${TITLE}=1`,
    );
    expect(parsePrefill(new URL(url).search).values).toEqual({ [TITLE]: 'Máy in' });
  });
});

describe('server answers', () => {
  it('splits problems by question', () => {
    const split = splitProblems([
      { path: `fields.${TITLE}`, code: 'REQUIRED_FIELD_MISSING', message: '' },
      { path: `fields.${TAGS}[1]`, code: 'INVALID_SELECT_OPTION', message: '' },
      { path: `fields.${TITLE}`, code: 'SECOND', message: '' },
      { path: 'submit_token', code: 'SUBMIT_TOKEN_INVALID', message: '' },
    ]);
    expect(Object.keys(split.fields)).toEqual([TITLE, TAGS]);
    expect(split.fields[TITLE]?.code).toBe('REQUIRED_FIELD_MISSING');
    expect(split.other.map((item) => item.path)).toEqual(['submit_token']);
  });

  it('reads the submission limit and the token problems', () => {
    const limit = new ApiError({
      status: 409,
      code: 'SUBMISSION_LIMIT_REACHED',
      errors: [
        {
          path: '',
          code: 'SUBMISSION_LIMIT_REACHED',
          message: '',
          params: { limit: 'daily', next_allowed_at: '2026-09-26T17:00:00.000Z' },
        },
      ],
    });
    expect(limitReached(limit)).toEqual({
      limit: 'daily',
      nextAllowedAt: '2026-09-26T17:00:00.000Z',
    });
    expect(limitReached(new ApiError({ status: 409, code: 'SUBMISSION_LIMIT_REACHED' }))).toEqual({
      limit: null,
      nextAllowedAt: null,
    });
    const fast = new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [
        {
          path: 'submit_token',
          code: 'SUBMITTED_TOO_FAST',
          message: '',
          params: { retry_after_ms: 1200 },
        },
      ],
    });
    expect(tokenProblem(fast)).toEqual({ kind: 'too_fast', retryAfterMs: 1200 });
    expect(limitReached(fast)).toBeNull();
  });

  it.each([
    [3 * 86_400_000, 'en', 'in 3 days'],
    [5 * 3_600_000 + 60_000, 'en', 'in 5 hours'],
    [30_000, 'en', 'in 1 minute'],
    [2 * 86_400_000, 'vi', 'sau 2 ngày nữa'],
  ])('relative time %i ms (%s)', (delta, locale, text) => {
    expect(relativeTime(1_000_000 + delta, 1_000_000, locale)).toBe(text);
  });
});
