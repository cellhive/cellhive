import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import { checkAppendImport } from '../../src/import/import-target.js';

import type { FieldRow } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';
import type { ResolvedBaseAccess } from '@cellhive/permissions';

const TABLE = 'tbl_Orders0000000001' as Id<'tbl'>;

function field(id: string, type: string, extra: Partial<FieldRow> = {}): FieldRow {
  return {
    id: id as Id<'fld'>,
    table_id: TABLE,
    type,
    db_column_name: type === 'link' || type === 'parent' ? null : `f_${id.slice(4, 10)}`,
    compute_mode: null,
    link_junction: type === 'link' ? 'l_abcdef' : null,
    ...extra,
  } as unknown as FieldRow;
}

const TITLE = field('fld_Title00000000001', 'text');
const LINK = field('fld_Link000000000001', 'link');
const PARENT = field('fld_Parent0000000001', 'parent');
const FILES = field('fld_Files00000000001', 'attachment');
const FIELDS = [TITLE, LINK, PARENT, FILES];

function resolved(perm: 'edit' | 'read'): ResolvedBaseAccess {
  return {
    access: {
      tables: {
        [TABLE]: {
          perm: 'edit',
          operations: ['add'],
          fields: {
            [TITLE.id]: 'edit',
            [LINK.id]: perm,
            [PARENT.id]: perm,
            [FILES.id]: 'edit',
          },
        },
      },
    },
  } as unknown as ResolvedBaseAccess;
}

function check(fieldIds: readonly string[], perm: 'edit' | 'read' = 'edit'): AppError | null {
  try {
    checkAppendImport(
      {
        mode: 'append',
        table_id: TABLE,
        mapping: fieldIds.map((id, column) => ({ column, field_id: id as Id<'fld'> })),
      },
      { resolved: resolved(perm), fields: FIELDS, columnCount: fieldIds.length },
    );
    return null;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

describe('checkAppendImport: link, parent and attachment fields (T411)', () => {
  it.each([
    ['link and parent writable', [TITLE.id, LINK.id, PARENT.id], 'edit', null],
    ['link read-only', [TITLE.id, LINK.id], 'read', 'FIELD_READ_ONLY'],
    ['parent read-only', [TITLE.id, PARENT.id], 'read', 'FIELD_READ_ONLY'],
    ['attachment', [TITLE.id, FILES.id], 'edit', 'VALIDATION_FAILED'],
  ] as const)('%s', (_, ids, perm, code) => {
    const error = check(ids, perm);
    expect(error?.code ?? null).toBe(code);
    if (code === 'VALIDATION_FAILED') {
      expect(error?.errors).toEqual([
        expect.objectContaining({
          path: 'mapping[1].field_id',
          code: 'INVALID_FIELD_TYPE',
          params: { type: 'attachment' },
        }),
      ]);
    }
  });

  it('a link field without junction is not writable', () => {
    const broken = field('fld_Broken0000000001', 'link', { link_junction: null });
    expect(() => {
      checkAppendImport(
        { mode: 'append', table_id: TABLE, mapping: [{ column: 0, field_id: broken.id }] },
        {
          resolved: {
            access: {
              tables: {
                [TABLE]: { perm: 'edit', operations: ['add'], fields: { [broken.id]: 'edit' } },
              },
            },
          } as unknown as ResolvedBaseAccess,
          fields: [broken],
          columnCount: 1,
        },
      );
    }).toThrow(expect.objectContaining({ code: 'FIELD_READ_ONLY' }) as Error);
  });
});
