import { describe, expect, it } from 'vitest';

import { accessAllows } from '../../src/common/access/access.service.js';
import { diffOf, mutationContextOf } from '../../src/common/access/change-log.js';

import type { EffectiveAccess, TableAccess } from '@cellhive/contracts';

const TABLE = 'tbl_A1b2C3d4E5f6G7h8';

function access(isAdmin: boolean, perm?: TableAccess['perm']): EffectiveAccess {
  return {
    role: null,
    is_admin: isAdmin,
    base_rule: { copy: false, download: false, share_link: false },
    tables:
      perm === undefined
        ? {}
        : {
            [TABLE]: {
              perm,
              operations: [],
              view_rule: { allow_edit: false, visible_views: null },
              read_scope: 'all',
              fields: {},
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
    dashboards: {},
  };
}

describe('accessAllows', () => {
  it.each([
    ['admin', access(true), { read: true, edit: true, admin: true }],
    ['manage table', access(false, 'manage'), { read: true, edit: true, admin: false }],
    ['edit table', access(false, 'edit'), { read: true, edit: true, admin: false }],
    ['read-only table', access(false, 'read_only'), { read: true, edit: false, admin: false }],
    ['no table', access(false), { read: true, edit: false, admin: false }],
  ] as const)('%s', (_name, value, expected) => {
    expect({
      read: accessAllows(value, 'read'),
      edit: accessAllows(value, 'edit'),
      admin: accessAllows(value, 'admin'),
    }).toEqual(expected);
  });
});

describe('diffOf', () => {
  it('keeps changed keys only, comparing JSON values', () => {
    expect(
      diffOf(
        { name: 'A', icon: null, settings: { a: 1 }, same: [1] },
        { name: 'B', icon: '📈', settings: { a: 1 }, same: [1] },
      ),
    ).toEqual({ name: { from: 'A', to: 'B' }, icon: { from: null, to: '📈' } });
  });
});

describe('mutationContextOf', () => {
  it('uses the request ID as batch ID', () => {
    const context = mutationContextOf(
      { requestId: 'req_A1b2C3d4E5f6G7h8', ip: '192.0.2.1', userAgent: 'test' },
      'usr_A1b2C3d4E5f6G7h8',
    );
    expect(context).toEqual({
      actor: { type: 'user', id: 'usr_A1b2C3d4E5f6G7h8' },
      via: null,
      batch_id: 'req_A1b2C3d4E5f6G7h8',
      request_id: 'req_A1b2C3d4E5f6G7h8',
      ip: '192.0.2.1',
      user_agent: 'test',
    });
  });
});
