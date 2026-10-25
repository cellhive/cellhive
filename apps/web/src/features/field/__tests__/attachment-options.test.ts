import { ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { joinAccept, splitAccept } from '../components/options/AttachmentOptionsForm';
import {
  blockedExtensionsOf,
  createBody,
  CREATABLE_TYPES,
  draftOf,
  updateBody,
  validateDraft,
  type FieldDraft,
} from '../draft';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-25T00:00:00.000Z';

function attachmentField(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Photos0000000001',
    table_id: 'tbl_Products00000001',
    name: 'Ảnh sản phẩm',
    type: 'attachment',
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

const newAttachment = (change: (draft: FieldDraft) => FieldDraft = (d) => d): FieldDraft =>
  change({ ...draftOf(), name: 'Tài liệu', type: 'attachment' });

describe('attachment fields in the field dialog (T418)', () => {
  it('can be created', () => {
    expect(CREATABLE_TYPES).toContain('attachment');
  });

  it('starts from the defaults: any type, 100 files, executables blocked', () => {
    expect(createBody(newAttachment())).toEqual({
      name: 'Tài liệu',
      type: 'attachment',
      options: {
        accept: null,
        max_files: 100,
        blocked_extensions: [...ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS],
      },
    });
  });

  it('sends picked types, a typed limit and typed extensions', () => {
    const draft = newAttachment((d) => ({
      ...d,
      attachment: {
        accept: joinAccept(new Set(['images', 'pdf']), 'application/vnd.dwg'),
        maxFiles: '8',
        blocked: '.EXE, msi  bat',
      },
    }));
    expect(validateDraft(draft).issues).toEqual([]);
    expect(createBody(draft).options).toEqual({
      accept: ['image/*', 'application/pdf', 'application/vnd.dwg'],
      max_files: 8,
      blocked_extensions: ['exe', 'msi', 'bat'],
    });
  });

  it.each([
    ['0', 'options.max_files'],
    ['101', 'options.max_files'],
    ['tám', 'options.max_files'],
  ])('refuses max files %s', (maxFiles, path) => {
    const draft = newAttachment((d) => ({ ...d, attachment: { ...d.attachment, maxFiles } }));
    expect(validateDraft(draft).issues.map((issue) => issue.path)).toContain(path);
  });

  it('edits keep what did not change, and send only the options when they did', () => {
    const field = attachmentField({ accept: ['image/*'], max_files: 8, blocked_extensions: [] });
    const draft = draftOf(field);
    expect(draft.type).toBe('attachment');
    expect(draft.attachment).toEqual({ accept: ['image/*'], maxFiles: '8', blocked: '' });
    expect(updateBody(field, draft)).toBeNull();
    expect(
      updateBody(field, { ...draft, attachment: { ...draft.attachment, maxFiles: '10' } }),
    ).toEqual({
      options: { accept: ['image/*'], max_files: 10, blocked_extensions: [] },
    });
  });

  it('reads presets back from accept, other types as typed', () => {
    const { presets, custom } = splitAccept(['image/*', 'application/pdf', 'image/heic']);
    expect([...presets].sort()).toEqual(['images', 'pdf']);
    expect(custom).toEqual(['image/heic']);
    expect(blockedExtensionsOf(' exe,,EXE .sh ')).toEqual(['exe', 'sh']);
  });
});
