import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { createQueryClient } from '../../../lib/query/client';
import { untrackAllJobs } from '../../../lib/realtime/jobs';
import { clearToasts } from '../../../lib/toast/toast';
import { ImportBaseDialog } from '../import-base/ImportBaseDialog';

import type { BaseImportReport, JobDto, WorkspaceDto } from '@cellhive/contracts';

/** "Import base from a .chbase file" of a workspace (FRONTEND §17.5, CONTRACTS §12.2). */

const WSP = 'wsp_Import0000000001';
const JOB = 'job_Import0000000001' as const;
const NEW_BASE = 'bse_Imported00000001' as const;
const NOW = '2026-11-08T03:00:00.000Z';

const WORKSPACE: WorkspaceDto = {
  id: WSP,
  organization_id: 'org_0123456789ABCDEF',
  name: 'Kho',
  slug: 'kho',
  role: 'admin',
  created_at: NOW,
  updated_at: NOW,
};

const REPORT: BaseImportReport = {
  tables: 3,
  fields: 41,
  records: 7200,
  links: 900,
  attachments: 40,
  views: 6,
  dashboards: 1,
  widgets: 5,
  automations: 2,
  roles: 1,
  unmatched_user_emails: ['a@old.vn', 'b@old.vn', 'c@old.vn'],
  unmatched_users: 12,
  automations_disabled: 2,
  secrets_to_reconnect: [
    {
      kind: 'secret',
      name: 'Bot Telegram',
      automations: [{ id: 'aut_0123456789ABCDEF', name: 'Báo đơn' }],
    },
    { kind: 'email_identity', name: '', automations: [] },
  ],
  webhooks_to_recreate: [
    {
      kind: 'incoming_webhook',
      name: 'Shop',
      automations: [{ id: 'aut_ABCDEF0123456789', name: 'Đơn từ shop' }],
    },
  ],
  ai_fields: [
    { table_id: 'tbl_0123456789ABCDEF', field_id: 'fld_0123456789ABCDEF', name: 'Tóm tắt' },
  ],
  skipped_personal_views: 2,
  files_skipped: [{ filename: 'setup.exe', reason: 'blocked_file_type' }],
};

function job(overrides: Partial<JobDto>): JobDto {
  return {
    id: JOB,
    type: 'base.import',
    status: 'running',
    progress: 0.5,
    result: null,
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: null,
    ...overrides,
  };
}

let current: JobDto = job({});

beforeEach(() => {
  current = job({});
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input, 'http://localhost').pathname;
      if (path === `/api/v1/jobs/${JOB}`) return Promise.resolve(json(current));
      if (path === `/api/v1/bases/${NEW_BASE}`) {
        return Promise.resolve(json({ id: NEW_BASE, name: 'Đơn hàng' }));
      }
      return Promise.resolve(problem('NOT_FOUND', 404));
    }),
  );
});

afterEach(() => {
  untrackAllJobs();
  clearToasts();
  vi.unstubAllGlobals();
});

async function renderDialog(upload = vi.fn(() => Promise.resolve({ job_id: JOB }))) {
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  const onOpenChange = vi.fn();
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ImportBaseDialog
            workspace={WORKSPACE}
            open
            opened={1}
            onOpenChange={onOpenChange}
            upload={upload}
            pollMs={50}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...utils, upload, onOpenChange };
}

function choose(name: string, size = 64) {
  const file = new File(['x'.repeat(size)], name, { type: 'application/zip' });
  fireEvent.change(screen.getByTestId('import-base-file'), { target: { files: [file] } });
  return file;
}

describe('ImportBaseDialog', () => {
  it('takes a .chbase file only, then imports it', async () => {
    const user = userEvent.setup();
    const { upload } = await renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Import base from a .chbase file' });
    expect(dialog).toHaveTextContent('The base is created in Kho, with you as its owner.');
    const start = screen.getByTestId('import-base-start');
    expect(start).toBeDisabled();
    choose('orders.csv');
    expect(dialog).toHaveTextContent('orders.csv is not a .chbase package');
    expect(start).toBeDisabled();
    const file = choose('Đơn hàng.chbase');
    expect(screen.getByTestId('import-chosen')).toHaveTextContent('Đơn hàng.chbase');
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(start);
    expect(upload).toHaveBeenCalledWith(WSP, file, expect.objectContaining({}));
    const phases = await screen.findByTestId('job-phases');
    expect(within(phases).getByText('Files').closest('li')).toHaveAttribute('data-state', 'done');
    expect(within(phases).getByText('Records').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('the report: counts, then only what needs the importer, and the way into the base', async () => {
    const user = userEvent.setup();
    await renderDialog();
    choose('Đơn hàng.chbase');
    await user.click(screen.getByTestId('import-base-start'));
    current = job({
      status: 'succeeded',
      progress: 1,
      finished_at: NOW,
      result: { base_id: NEW_BASE, report: REPORT },
    });
    const report = await screen.findByTestId('import-report');
    await waitFor(() => {
      expect(report).toHaveTextContent('Đơn hàng is ready');
    });
    expect(screen.getByTestId('import-report-counts')).toHaveTextContent('7,200');
    expect(screen.getByTestId('import-report-automations')).toHaveTextContent(
      '2 automations were imported turned off',
    );
    const reconnect = screen.getByTestId('import-report-reconnect');
    expect(reconnect).toHaveTextContent('SecretBot Telegram');
    expect(reconnect).toHaveTextContent('Sending identity(no name)');
    expect(reconnect).toHaveTextContent('Incoming webhookShop');
    expect(within(reconnect).getByRole('link', { name: 'Báo đơn' })).toHaveAttribute(
      'href',
      `/b/${NEW_BASE}/automations/aut_0123456789ABCDEF`,
    );
    const people = screen.getByTestId('import-report-people');
    expect(people).toHaveTextContent('a@old.vn');
    expect(people).toHaveTextContent('And 9 more');
    expect(screen.getByTestId('import-report-ai')).toHaveTextContent('Tóm tắt');
    expect(screen.getByTestId('import-report-views')).toHaveTextContent(
      '2 personal views of the source base were not exported',
    );
    expect(screen.getByTestId('import-report-files')).toHaveTextContent(
      'setup.exefile type not allowed',
    );
    expect(screen.getByTestId('import-open-base')).toHaveAttribute('href', `/b/${NEW_BASE}`);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('a refused package: each problem with its message, reason and path; nothing created', async () => {
    const user = userEvent.setup();
    await renderDialog();
    choose('bad.chbase');
    await user.click(screen.getByTestId('import-base-start'));
    current = job({
      status: 'failed',
      progress: 0.05,
      finished_at: NOW,
      error: {
        type: 'about:blank',
        title: 'Invalid package',
        status: 422,
        code: 'INVALID_PACKAGE',
        errors: [
          { path: 'manifest.json', code: 'CHECKSUM_MISMATCH', message: 'Changed.' },
          {
            path: 'schema/tables.json#/tables/0/fields/2',
            code: 'INVALID_DEFINITION',
            message: 'Cycle.',
            params: { code: 'FORMULA_CYCLE' },
          },
          {
            path: 'data/tbl_0123456789ABCDEF.ndjson:12',
            code: 'INVALID_ENTRY',
            message: 'Bad.',
            params: { code: 'SOMETHING_NEW' },
          },
        ],
        params: { more_problems: 4 },
      },
    });
    const failed = await screen.findByTestId('import-error');
    expect(failed).toHaveTextContent('This package cannot be imported');
    const problems = screen.getAllByTestId('import-problem');
    expect(problems).toHaveLength(3);
    expect(problems[0]).toHaveTextContent(
      'A part of the package was changed after it was exported.',
    );
    expect(problems[0]).toHaveTextContent('manifest.json');
    expect(problems[1]).toHaveTextContent('Reason: The formula refers to itself.');
    expect(problems[1]).toHaveTextContent('schema/tables.json#/tables/0/fields/2');
    // A code the app does not know shows as is.
    expect(problems[2]).toHaveTextContent('Reason: SOMETHING_NEW');
    expect(failed).toHaveTextContent('And 4 more problems');
    expect(failed).toHaveTextContent('Nothing was created');
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Choose another file' }));
    expect(await screen.findByTestId('import-dropzone')).toBeInTheDocument();
  });

  it('an upload over the limit of the instance names it and the command line', async () => {
    const user = userEvent.setup();
    await renderDialog(
      vi.fn(() =>
        Promise.reject(
          new ApiError({
            status: 413,
            code: 'PAYLOAD_TOO_LARGE',
            errors: [
              {
                path: 'file',
                code: 'PACKAGE_TOO_LARGE',
                message: 'Too big',
                params: { limit: 1048576 },
              },
            ],
          }),
        ),
      ),
    );
    choose('big.chbase');
    await user.click(screen.getByTestId('import-base-start'));
    expect(
      await screen.findByText(
        'The package is larger than this instance accepts in the browser (1 MB). Import it with the command line: cellhive base import.',
      ),
    ).toBeInTheDocument();
    // The file stays chosen: another try needs no new pick.
    expect(screen.getByTestId('import-chosen')).toHaveTextContent('big.chbase');
  });
});
