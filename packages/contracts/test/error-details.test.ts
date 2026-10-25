import { describe, expect, it } from 'vitest';

import {
  ADMIN_DETAIL_CODES,
  ERROR_DETAIL_CODES,
  FORM_DETAIL_CODES,
  EXPORT_DETAIL_CODES,
  IMPORT_DETAIL_CODES,
  ROLE_DETAIL_CODES,
  SCHEMA_DETAIL_CODES,
  SHARE_LINK_DETAIL_CODES,
  VIEW_DETAIL_CODES,
} from '../src/error-details.js';
import { EXPORT_TOO_LARGE } from '../src/exports.js';
import {
  REQUIRES_LOGIN,
  SUBMISSION_LIMIT_REACHED,
  SUBMIT_TOKEN_INVALID,
  SUBMITTED_TOO_FAST,
  UNLOCK_REQUIRED,
  UPLOAD_LIMIT_EXCEEDED,
} from '../src/forms.js';
import {
  ARCHIVE_LIMIT_EXCEEDED,
  DUPLICATE_COLUMN,
  EMPTY_FILE,
  FILE_REQUIRED,
  INVALID_FILE,
  LINK_TARGET_AMBIGUOUS,
  TOO_MANY_COLUMNS,
  TOO_MANY_ROWS,
  UNKNOWN_COLUMN,
  UNKNOWN_SHEET,
} from '../src/imports.js';
import {
  ALREADY_MEMBER,
  LAST_OWNER,
  OWNS_BASES,
  UNKNOWN_PRINCIPAL,
  WORKSPACE_NOT_EMPTY,
} from '../src/orgs.js';
import {
  ROLE_IN_USE,
  SYSTEM_ROLE,
  UNKNOWN_FIELD,
  UNKNOWN_ROLE,
  UNKNOWN_TABLE,
} from '../src/roles.js';
import {
  DASHBOARD_LINK,
  EMBED_NOT_SUPPORTED,
  INVALID_ORIGIN,
  NOT_AVAILABLE_YET,
  PERSONAL_VIEW,
} from '../src/share-links.js';
import { PRIMARY_FIELD_NOT_DELETABLE, UNKNOWN_OPTION } from '../src/tables.js';
import {
  INVALID_FIELD_TYPE,
  LAST_VIEW,
  UNKNOWN_VIEW,
  VIEW_LIMIT_EXCEEDED,
  VIEW_LOCKED,
} from '../src/views.js';

describe('detail codes (CONTRACTS §6)', () => {
  it('lists every code once, in upper snake case', () => {
    expect(new Set(ERROR_DETAIL_CODES).size).toBe(ERROR_DETAIL_CODES.length);
    for (const code of ERROR_DETAIL_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/u);
  });

  it('includes the detail-code constants exported next to their schemas', () => {
    expect(ROLE_DETAIL_CODES).toEqual(
      expect.arrayContaining([
        SYSTEM_ROLE,
        ROLE_IN_USE,
        UNKNOWN_ROLE,
        UNKNOWN_TABLE,
        UNKNOWN_FIELD,
        UNKNOWN_VIEW,
      ]),
    );
    expect([...IMPORT_DETAIL_CODES].sort()).toEqual(
      [
        TOO_MANY_ROWS,
        TOO_MANY_COLUMNS,
        INVALID_FILE,
        ARCHIVE_LIMIT_EXCEEDED,
        UNKNOWN_SHEET,
        UNKNOWN_COLUMN,
        DUPLICATE_COLUMN,
        FILE_REQUIRED,
        EMPTY_FILE,
        LINK_TARGET_AMBIGUOUS,
      ].sort(),
    );
    expect(VIEW_DETAIL_CODES).toEqual(
      expect.arrayContaining([LAST_VIEW, VIEW_LIMIT_EXCEEDED, VIEW_LOCKED, INVALID_FIELD_TYPE]),
    );
    expect(SHARE_LINK_DETAIL_CODES).toEqual([
      NOT_AVAILABLE_YET,
      PERSONAL_VIEW,
      EMBED_NOT_SUPPORTED,
      INVALID_ORIGIN,
      DASHBOARD_LINK,
    ]);
    expect(FORM_DETAIL_CODES).toEqual([
      SUBMIT_TOKEN_INVALID,
      SUBMITTED_TOO_FAST,
      REQUIRES_LOGIN,
      SUBMISSION_LIMIT_REACHED,
      UNLOCK_REQUIRED,
      UPLOAD_LIMIT_EXCEEDED,
    ]);
    expect(EXPORT_DETAIL_CODES).toEqual([EXPORT_TOO_LARGE]);
    expect(ADMIN_DETAIL_CODES).toEqual(
      expect.arrayContaining([
        LAST_OWNER,
        ALREADY_MEMBER,
        UNKNOWN_PRINCIPAL,
        WORKSPACE_NOT_EMPTY,
        OWNS_BASES,
      ]),
    );
    expect(SCHEMA_DETAIL_CODES).toEqual(
      expect.arrayContaining([PRIMARY_FIELD_NOT_DELETABLE, UNKNOWN_OPTION]),
    );
  });
});
