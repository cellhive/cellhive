import { describe, expect, it } from 'vitest';

import {
  BASE_EXPORT_PHASES,
  BASE_IMPORT_PHASES,
  BASE_IMPORT_REPORT_MAX_ITEMS,
  BASE_PACKAGE_DEFAULT_MAX_BYTES,
  BASE_PACKAGE_MAX_BYTES_LIMIT,
  baseExportPhaseOf,
  baseExportResultSchema,
  baseImportPhaseOf,
  baseImportReportSchema,
  baseImportResultSchema,
  basePackageProgress,
  CHECKSUM_MISMATCH,
  DANGLING_REFERENCE,
  DUPLICATE_ENTRY,
  INVALID_ARCHIVE,
  INVALID_DEFINITION,
  INVALID_ENTRY,
  MISSING_ENTRY,
  PACKAGE_ARCHIVE_LIMIT_EXCEEDED,
  PACKAGE_DUPLICATE_ID,
  PACKAGE_TOO_LARGE,
  UNKNOWN_ENTRY,
  UNSAFE_ENTRY,
  UNSUPPORTED_FORMAT_VERSION,
} from '../src/base-packages.js';
import {
  BASE_PACKAGE_DETAIL_CODES,
  BASE_PACKAGE_SIZE_DETAIL_CODES,
  ERROR_DETAIL_CODES,
} from '../src/error-details.js';

const counts = {
  tables: 3,
  fields: 40,
  records: 7200,
  links: 900,
  attachments: 41,
  views: 6,
  dashboards: 1,
  widgets: 5,
  automations: 2,
  roles: 1,
};

describe('base packages (CONTRACTS §12.2, T1016)', () => {
  it('lists every INVALID_PACKAGE detail code once, in the catalogue', () => {
    expect(BASE_PACKAGE_DETAIL_CODES).toEqual([
      INVALID_ARCHIVE,
      PACKAGE_ARCHIVE_LIMIT_EXCEEDED,
      UNSAFE_ENTRY,
      UNKNOWN_ENTRY,
      DUPLICATE_ENTRY,
      MISSING_ENTRY,
      INVALID_ENTRY,
      CHECKSUM_MISMATCH,
      UNSUPPORTED_FORMAT_VERSION,
      DANGLING_REFERENCE,
      INVALID_DEFINITION,
      PACKAGE_DUPLICATE_ID,
    ]);
    expect(BASE_PACKAGE_SIZE_DETAIL_CODES).toEqual([PACKAGE_TOO_LARGE]);
    for (const code of [...BASE_PACKAGE_DETAIL_CODES, ...BASE_PACKAGE_SIZE_DETAIL_CODES]) {
      expect(ERROR_DETAIL_CODES).toContain(code);
    }
  });

  it('keeps the default cap under one S3 PUT', () => {
    expect(BASE_PACKAGE_DEFAULT_MAX_BYTES).toBe(2 * 1024 ** 3);
    expect(BASE_PACKAGE_MAX_BYTES_LIMIT).toBeLessThan(5 * 1024 ** 3);
  });

  it('parses the job results', () => {
    expect(
      baseExportResultSchema.parse({
        download_url: '/api/v1/files/exports/job_0123456789abcdef',
        expires_at: '2026-11-08T11:00:00.000Z',
        size: 48_213_992,
        counts,
        skipped_personal_views: 2,
      }),
    ).toMatchObject({ size: 48_213_992 });
    expect(
      baseExportResultSchema.safeParse({
        file_deleted: true,
        size: 1,
        counts,
        skipped_personal_views: 0,
      }).success,
    ).toBe(true);
    const report = {
      ...counts,
      unmatched_user_emails: ['cu.nhanvien@x.vn'],
      unmatched_users: 1,
      automations_disabled: 2,
      secrets_to_reconnect: [
        {
          kind: 'secret',
          name: 'Bot Telegram',
          automations: [{ id: 'aut_0123456789abcdef', name: 'Notify' }],
        },
      ],
      webhooks_to_recreate: [],
      ai_fields: [
        { table_id: 'tbl_0123456789abcdef', field_id: 'fld_0123456789abcdef', name: 'Summary' },
      ],
      skipped_personal_views: 2,
      files_skipped: [{ filename: 'setup.exe', reason: 'blocked_file_type' }],
    };
    expect(baseImportResultSchema.parse({ base_id: 'bse_0123456789abcdef', report })).toEqual({
      base_id: 'bse_0123456789abcdef',
      report,
    });
    expect(
      baseImportReportSchema.safeParse({
        ...report,
        unmatched_user_emails: Array.from(
          { length: BASE_IMPORT_REPORT_MAX_ITEMS + 1 },
          (_value, index) => `u${String(index)}@x.vn`,
        ),
      }).success,
    ).toBe(false);
    expect(baseImportReportSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
  });

  it.each([
    [0, 'schema', 'check'],
    [0.04, 'schema', 'check'],
    [0.05, 'records', 'check'],
    [0.5, 'records', 'records'],
    [0.84, 'links', 'links'],
    [0.9, 'files', 'computed'],
    [0.97, 'upload', 'finish'],
    [1, 'upload', 'finish'],
  ] as const)('progress %s is export %s, import %s', (progress, exportPhase, importPhase) => {
    expect(baseExportPhaseOf(progress)).toBe(exportPhase);
    expect(baseImportPhaseOf(progress)).toBe(importPhase);
  });

  it('places the progress of a phase between its bounds', () => {
    expect(basePackageProgress(BASE_IMPORT_PHASES, 'check', 0, 10)).toBe(0);
    expect(basePackageProgress(BASE_IMPORT_PHASES, 'records', 50, 100)).toBeCloseTo(0.6);
    expect(basePackageProgress(BASE_IMPORT_PHASES, 'records', 500, 100)).toBeCloseTo(0.8);
    expect(basePackageProgress(BASE_IMPORT_PHASES, 'records', -1, 100)).toBeCloseTo(0.4);
    expect(basePackageProgress(BASE_EXPORT_PHASES, 'files', 0, 0)).toBeCloseTo(0.97);
    expect(basePackageProgress(BASE_EXPORT_PHASES, 'nothing', 1, 1)).toBe(0);
  });
});
