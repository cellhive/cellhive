import { describe, expect, it } from 'vitest';

import {
  aiChangedValues,
  aiIssues,
  aiOptionsBody,
  bracketName,
  newAiDraft,
  promptFields,
  serverAiIssue,
  sourceFieldOf,
  templatePrompt,
  tokensPerRow,
  type AiDraft,
} from '../ai/model';
import { createBody, draftOf, newOption, updateBody, validateDraft } from '../draft';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-11-01T00:00:00.000Z';

function field(overrides: Partial<FieldDto>): FieldDto {
  return {
    id: 'fld_Summary000000001',
    table_id: 'tbl_Tickets000000001',
    name: 'Summary',
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 3,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const AI_OPTIONS = {
  task: 'summarize',
  prompt: 'Summarize in one sentence: {{ [Mô tả] }}',
  instructions: null,
  auto_update: true,
  max_output_tokens: 300,
};
const TITLE = field({ id: 'fld_Title0000000001', name: 'Tiêu đề', is_primary: true });
const DESCRIPTION = field({ id: 'fld_Desc00000000001', name: 'Mô tả', position: 1 });
const FILES = field({ id: 'fld_Files0000000001', name: 'Files', type: 'attachment' });
const OTHER_AI = field({ id: 'fld_Other0000000001', name: 'Other', options: { ai: AI_OPTIONS } });
const SAVED = field({ options: { style: { type: 'plain' }, default_value: null, ai: AI_OPTIONS } });

describe('templates', () => {
  it.each([
    ['plain', 'Mô tả', '[Mô tả]'],
    ['closing bracket', 'a]b', String.raw`[a\]b]`],
    ['backslash', String.raw`a\b`, String.raw`[a\\b]`],
  ])('bracketName escapes a %s', (_case, name, expected) => {
    expect(bracketName(name)).toBe(expected);
  });

  it.each<[Parameters<typeof templatePrompt>[0], string, FieldDto | undefined, string]>([
    ['summarize', 'Summarize:', DESCRIPTION, 'Summarize: {{ [Mô tả] }}'],
    ['translate', 'Translate {x}:', DESCRIPTION, String.raw`Translate \{x}: {{ [Mô tả] }}`],
    ['extract', 'Extract:', undefined, 'Extract:'],
    ['custom', 'ignored', DESCRIPTION, ''],
  ])('the %s prompt', (task, lead, source, expected) => {
    expect(templatePrompt(task, lead, source)).toBe(expected);
  });

  it('starts from the first text field that is not the primary one, never an AI field', () => {
    expect(sourceFieldOf([TITLE, OTHER_AI, FILES, DESCRIPTION])?.name).toBe('Mô tả');
    expect(sourceFieldOf([TITLE, FILES])?.name).toBe('Tiêu đề');
    expect(sourceFieldOf([FILES])).toBeUndefined();
    // Nor a field locked for the reader, nor the field itself.
    expect(promptFields([TITLE, DESCRIPTION], DESCRIPTION.id).map((item) => item.id)).toEqual([
      TITLE.id,
    ]);
    expect(promptFields([field({ ...DESCRIPTION, locked: true })])).toEqual([]);
  });
});

describe('options and issues', () => {
  const draft: AiDraft = {
    ...newAiDraft('summarize', '  Summarize: {{ [Mô tả] }} '),
    instructions: '  Vietnamese ',
  };

  it('sends the contract options (trimmed, `null` instructions when empty)', () => {
    expect(aiOptionsBody(draft)).toEqual({
      task: 'summarize',
      prompt: 'Summarize: {{ [Mô tả] }}',
      instructions: 'Vietnamese',
      auto_update: true,
      max_output_tokens: 300,
    });
    expect(aiOptionsBody({ ...draft, instructions: ' ' }).instructions).toBeNull();
  });

  it.each<[string, AiDraft, 'text' | 'select', number, string[]]>([
    ['valid', draft, 'text', 0, []],
    ['empty prompt', { ...draft, prompt: ' ' }, 'text', 0, ['options.ai.prompt:REQUIRED']],
    [
      'too few tokens',
      { ...draft, maxOutputTokens: '8' },
      'text',
      0,
      ['options.ai.max_output_tokens:TOO_SMALL'],
    ],
    [
      'tokens not a number',
      { ...draft, maxOutputTokens: '3k' },
      'text',
      0,
      ['options.ai.max_output_tokens:EXPECTED_NUMBER'],
    ],
    ['a select without options', draft, 'select', 0, ['options.ai.choices:AI_CHOICES_REQUIRED']],
    ['a select with options', draft, 'select', 2, []],
  ])('%s', (_case, value, output, options, expected) => {
    expect(
      aiIssues(value, output, options).map((issue) => `${issue.path}:${issue.detail.code}`),
    ).toEqual(expected);
  });

  it('places the server problems of the prompt (save and preview paths)', () => {
    const placed = (path: string) =>
      serverAiIssue([
        { path: 'name', code: 'REQUIRED' },
        { path, code: 'UNKNOWN_FIELD', params: { position: 3 } },
      ]);
    expect(placed('options.ai.prompt')).toEqual({
      path: 'options.ai.prompt',
      detail: { code: 'UNKNOWN_FIELD', params: { position: 3 } },
    });
    expect(placed('ai.prompt')?.path).toBe('options.ai.prompt');
    expect(placed('options.style')).toBeUndefined();
  });

  it('asks to generate again only when what the AI writes changes', () => {
    expect(aiChangedValues(null, draft)).toBe(true);
    expect(aiChangedValues(draft, null)).toBe(false);
    expect(aiChangedValues(draft, { ...draft, autoUpdate: false })).toBe(false);
    expect(aiChangedValues(draft, { ...draft, prompt: 'Other {{ [Mô tả] }}' })).toBe(true);
    expect(aiChangedValues(draft, { ...draft, maxOutputTokens: '500' })).toBe(true);
  });

  it('averages the tokens of a preview', () => {
    expect(tokensPerRow({ rows: 120, tokens: 9_600 })).toBe(80);
    expect(tokensPerRow({ rows: 0, tokens: 0 })).toBeUndefined();
    expect(tokensPerRow(undefined)).toBeUndefined();
  });
});

describe('the field draft', () => {
  it('reads the AI part of a saved field', () => {
    expect(draftOf(SAVED).ai).toEqual({
      task: 'summarize',
      prompt: 'Summarize in one sentence: {{ [Mô tả] }}',
      instructions: '',
      autoUpdate: true,
      maxOutputTokens: '300',
    });
    expect(draftOf(DESCRIPTION).ai).toBeNull();
  });

  it('creates an AI text field: options.ai, never required nor unique', () => {
    const draft = {
      ...draftOf(),
      name: 'Summary',
      required: true,
      unique: true,
      ai: newAiDraft('summarize', 'Summarize: {{ [Mô tả] }}'),
    };
    expect(validateDraft(draft).issues).toEqual([]);
    expect(createBody(draft)).toEqual({
      name: 'Summary',
      type: 'text',
      options: {
        style: { type: 'plain' },
        default_value: null,
        ai: { ...AI_OPTIONS, prompt: 'Summarize: {{ [Mô tả] }}' },
      },
    });
  });

  it('creates an AI select: single, its options, no default', () => {
    const base = draftOf();
    const draft = {
      ...base,
      name: 'Mức độ',
      type: 'select' as const,
      select: {
        multiple: true,
        options: [newOption('Thấp', 0), newOption('Cao', 1)],
        defaultOptionId: null,
      },
      ai: newAiDraft('classify', 'Choose: {{ [Mô tả] }}'),
    };
    expect(validateDraft(draft).issues).toEqual([]);
    expect(createBody(draft).options).toEqual({
      multiple: false,
      options: [
        { name: 'Thấp', color: 0 },
        { name: 'Cao', color: 1 },
      ],
      default_value: null,
      ai: { ...AI_OPTIONS, task: 'classify', prompt: 'Choose: {{ [Mô tả] }}' },
    });
    expect(validateDraft({ ...draft, select: { ...draft.select, options: [] } }).issues).toEqual([
      { path: 'options.ai.choices', detail: { code: 'AI_CHOICES_REQUIRED' } },
    ]);
  });

  it('updates only what changed, and removes AI with `ai: null`', () => {
    const before = draftOf(SAVED);
    expect(updateBody(SAVED, before)).toBeNull();
    const ai = before.ai;
    if (ai === null) throw new Error('an AI field');
    expect(updateBody(SAVED, { ...before, ai: { ...ai, prompt: 'Short: {{ [Mô tả] }}' } })).toEqual(
      {
        options: {
          style: { type: 'plain' },
          default_value: null,
          ai: { ...AI_OPTIONS, prompt: 'Short: {{ [Mô tả] }}' },
        },
      },
    );
    expect(updateBody(SAVED, { ...before, ai: null })).toEqual({
      options: { style: { type: 'plain' }, default_value: null, ai: null },
    });
  });
});
