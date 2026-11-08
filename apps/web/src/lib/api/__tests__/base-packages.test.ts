import { BASE_PACKAGE_MAX_BYTES_LIMIT, type JobDto } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  checkPackageFile,
  exportResultOf,
  importResultOf,
  jobErrorOf,
  moreProblemsOf,
  packageDownloadUrl,
} from '../base-packages';

const NOW = '2026-11-08T03:00:00.000Z';

function job(overrides: Partial<JobDto>): JobDto {
  return {
    id: 'job_0123456789ABCDEF',
    type: 'base.export',
    status: 'succeeded',
    progress: 1,
    result: null,
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: NOW,
    ...overrides,
  };
}

const COUNTS = {
  tables: 3,
  fields: 41,
  records: 7200,
  links: 900,
  attachments: 41,
  views: 6,
  dashboards: 1,
  widgets: 5,
  automations: 2,
  roles: 1,
};

describe('checkPackageFile', () => {
  it.each([
    ['base.chbase', 10, null],
    ['Base.CHBASE', 10, null],
    ['orders.csv', 10, 'extension'],
    ['base.chbase.zip', 10, 'extension'],
    ['base.chbase', 0, 'empty'],
    ['base.chbase', BASE_PACKAGE_MAX_BYTES_LIMIT, null],
    ['base.chbase', BASE_PACKAGE_MAX_BYTES_LIMIT + 1, 'tooLarge'],
  ] as const)('%s of %d bytes → %s', (name, size, problem) => {
    expect(checkPackageFile({ name, size })).toBe(problem);
  });
});

describe('job results', () => {
  const exported = {
    download_url: '/api/v1/files/exports/job_0123456789ABCDEF',
    expires_at: NOW,
    size: 48_213_992,
    counts: COUNTS,
    skipped_personal_views: 2,
  };

  it('reads the result of a succeeded export; anything else is undefined', () => {
    expect(exportResultOf(job({ result: exported }))).toEqual(exported);
    expect(exportResultOf(job({ status: 'running', result: exported }))).toBeUndefined();
    expect(exportResultOf(job({ result: { size: 'big' } }))).toBeUndefined();
    expect(exportResultOf(undefined)).toBeUndefined();
  });

  it('downloads only from a path of this API', () => {
    expect(packageDownloadUrl(exported)).toBe('/api/v1/files/exports/job_0123456789ABCDEF');
    expect(packageDownloadUrl({ ...exported, download_url: 'https://evil.test/x' })).toBeNull();
    expect(
      packageDownloadUrl({ ...exported, download_url: '/api/v1/files/exports/../x' }),
    ).toBeNull();
    expect(
      packageDownloadUrl({
        size: exported.size,
        counts: exported.counts,
        skipped_personal_views: 0,
        file_deleted: true,
      }),
    ).toBeNull();
  });

  it('reads the report of a succeeded import', () => {
    const report = {
      ...COUNTS,
      unmatched_user_emails: ['old@x.vn'],
      unmatched_users: 1,
      automations_disabled: 2,
      secrets_to_reconnect: [
        {
          kind: 'secret',
          name: 'Bot',
          automations: [{ id: 'aut_0123456789ABCDEF', name: 'Báo đơn' }],
        },
      ],
      webhooks_to_recreate: [],
      ai_fields: [],
      skipped_personal_views: 0,
      files_skipped: [{ filename: 'setup.exe', reason: 'blocked_file_type' }],
    };
    const result = { base_id: 'bse_0123456789ABCDEF', report };
    expect(importResultOf(job({ type: 'base.import', result }))).toEqual(result);
    expect(
      importResultOf(job({ type: 'base.import', result: { base_id: 'bse_x', report } })),
    ).toBeUndefined();
  });
});

describe('failed jobs', () => {
  const error = {
    type: 'about:blank',
    title: 'The package is invalid.',
    status: 422,
    code: 'INVALID_PACKAGE',
    errors: [{ path: 'manifest.json', code: 'MISSING_ENTRY', message: 'Missing.' }],
    params: { more_problems: 12 },
  };

  it('turns the problem+json of a failed job into an ApiError', () => {
    const apiError = jobErrorOf(job({ status: 'failed', error }));
    expect(apiError).toMatchObject({
      status: 422,
      code: 'INVALID_PACKAGE',
      errors: [{ path: 'manifest.json', code: 'MISSING_ENTRY' }],
    });
    expect(jobErrorOf(job({ status: 'succeeded' }))).toBeUndefined();
  });

  it('counts the problems past the 100 listed', () => {
    expect(moreProblemsOf(job({ status: 'failed', error }))).toBe(12);
    expect(moreProblemsOf(job({ status: 'failed', error: { ...error, params: {} } }))).toBe(0);
    expect(moreProblemsOf(undefined)).toBe(0);
  });
});
