import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { createQueryClient } from '../../../lib/query/client';
import { keys } from '../../../lib/query/keys';
import { onJobProgress, untrackAllJobs } from '../../../lib/realtime/jobs';
import { clearToasts } from '../../../lib/toast/toast';
import { importsApi, uploadImportFile } from '../api';
import { ImportMenu } from '../components/ImportMenu';
import { ImportWizard, type ImportTarget } from '../components/ImportWizard';

import type {
  FieldDto,
  ImportPreview,
  ImportUploadDto,
  JobDto,
  StartImportRequest,
} from '@cellhive/contracts';

vi.mock('../api', () => ({
  uploadImportFile: vi.fn(),
  importsApi: { preview: vi.fn(), start: vi.fn(), cancel: vi.fn() },
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Orders0000000001';
const JOB = 'job_0123456789ABCDEF';
const UPLOAD = 'imp_0123456789ABCDEF';
const NOW = '2026-09-24T00:00:00.000Z';

function field(id: `fld_${string}`, overrides: Partial<FieldDto> = {}): FieldDto {
  return {
    id,
    table_id: TABLE,
    name: id,
    type: 'text',
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const TITLE = field('fld_Title00000000001', { name: 'Tên khách', is_primary: true });
const AMOUNT = field('fld_Amount0000000001', { name: 'Số tiền', type: 'number', position: 1 });
const CODE = field('fld_Code000000000001', { name: 'Mã', type: 'auto_number', position: 2 });

const PREVIEW: ImportPreview = {
  format: 'csv',
  encoding: 'windows-1258',
  delimiter: ';',
  sheets: [],
  sheet: null,
  header_row: true,
  total_rows: 3,
  columns: [
    { index: 0, name: 'Tên khách', type: 'text', options: {} },
    { index: 1, name: 'Số tiền', type: 'number', options: { style: { type: 'plain' } } },
    { index: 2, name: 'Mã', type: 'text', options: {} },
  ],
  rows: [
    ['Nguyễn Văn Ánh', '1.500.000', 'A1'],
    ['Trần Thị Bình', null, 'A2'],
    ['Lê Cường', 'abc', 'A3'],
  ],
};

const UPLOADED: ImportUploadDto = {
  id: UPLOAD,
  filename: 'Khách hàng.csv',
  format: 'csv',
  size: 120,
  expires_at: '2026-09-25T00:00:00.000Z',
  preview: PREVIEW,
};

function job(status: JobDto['status'], result: Record<string, unknown> | null = null): JobDto {
  return {
    id: JOB,
    type: 'table.import',
    status,
    progress: status === 'succeeded' ? 1 : 0.4,
    result,
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: status === 'running' ? null : NOW,
  };
}

type Access = 'admin' | 'sales' | 'reader';

function base(kind: Access) {
  return {
    id: BASE,
    name: 'Sales',
    permission_version: 1,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: false },
      tables: {
        [TABLE]: {
          perm: kind === 'reader' ? 'read_only' : 'edit',
          operations: kind === 'reader' ? [] : ['add'],
          view_rule: { allow_edit: false, visible_views: null },
          read_scope: 'all',
          fields: { [TITLE.id]: 'edit', [AMOUNT.id]: 'edit', [CODE.id]: 'read' },
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
      dashboards: {},
    },
  };
}

let currentJob: JobDto = job('running');

beforeEach(() => {
  currentJob = job('running');
  vi.mocked(uploadImportFile).mockReset();
  vi.mocked(importsApi.preview).mockReset();
  vi.mocked(importsApi.start).mockReset();
  vi.mocked(importsApi.cancel).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = new URL(input, 'http://localhost').pathname;
      if (path === `/api/v1/jobs/${JOB}`) return Promise.resolve(json(currentJob));
      return Promise.resolve(problem('NOT_FOUND', 404));
    }),
  );
});

afterEach(() => {
  untrackAllJobs();
  clearToasts();
  vi.unstubAllGlobals();
});

async function setup(kind: Access = 'admin') {
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  queryClient.setQueryData(keys.base(BASE), base(kind));
  queryClient.setQueryData(keys.tables(BASE), {
    items: [{ id: TABLE, name: 'Orders' }],
    total: 1,
    offset: 0,
    limit: 1000,
  });
  queryClient.setQueryData(keys.fields(TABLE), {
    items: [TITLE, AMOUNT, CODE],
    total: 3,
    offset: 0,
    limit: 1000,
  });
  return { i18n, queryClient };
}

async function renderWizard(target: ImportTarget, kind: Access = 'admin') {
  const { i18n, queryClient } = await setup(kind);
  const onClose = vi.fn();
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ImportWizard baseId={BASE} target={target} onClose={onClose} />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...utils, onClose, queryClient };
}

function chooseFile(name: string, size = 120) {
  const file = new File(['x'.repeat(size)], name, { type: 'text/csv' });
  fireEvent.change(screen.getByTestId('import-file-input'), { target: { files: [file] } });
  return file;
}

async function uploadAndPreview() {
  vi.mocked(uploadImportFile).mockImplementation((_base, _file, options) => {
    options?.onProgress?.(0.5);
    return Promise.resolve(UPLOADED);
  });
  chooseFile('Khách hàng.csv');
  await screen.findByRole('heading', { name: 'Check how the file is read' });
}

describe('ImportWizard: new table', () => {
  it('uploads, previews, maps and imports, then shows the result', async () => {
    const user = userEvent.setup();
    const { container } = await renderWizard({ mode: 'create_table' });
    expect(screen.getByRole('dialog', { name: 'Import as a new table' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Import steps' }))
        .getByText('File')
        .closest('li'),
    ).toHaveAttribute('aria-current', 'step');
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    await uploadAndPreview();
    expect(uploadImportFile).toHaveBeenCalledWith(BASE, expect.any(File), expect.anything());
    // Detected options, marked.
    expect(screen.getByLabelText('Encoding')).toHaveDisplayValue(
      'Windows-1258 (Vietnamese) (detected)',
    );
    expect(screen.getByLabelText('Delimiter')).toHaveDisplayValue('Semicolon ( ; ) (detected)');
    expect(screen.getByText('First 3 of 3 rows', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Nguyễn Văn Ánh' })).toBeInTheDocument();
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    // Forcing another encoding asks for a new preview with every option.
    vi.mocked(importsApi.preview).mockResolvedValue({ ...PREVIEW, encoding: 'utf-8' });
    await user.selectOptions(screen.getByLabelText('Encoding'), 'utf-8');
    expect(importsApi.preview).toHaveBeenCalledWith(
      BASE,
      UPLOAD,
      { encoding: 'utf-8', delimiter: ';', header_row: true },
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Encoding')).toHaveDisplayValue('UTF-8');
    });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose what each column becomes' });
    expect(screen.getByLabelText('Table name')).toHaveValue('Khách hàng');
    // The primary field is text; the second column keeps its guess.
    expect(screen.getByLabelText('Field type for column Tên khách')).toBeDisabled();
    expect(screen.getByLabelText('Field type for column Số tiền')).toHaveDisplayValue('Number');
    await user.click(screen.getByLabelText('Import column Mã'));
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    // A name already used in the base is refused before sending.
    await user.clear(screen.getByLabelText('Table name'));
    await user.type(screen.getByLabelText('Table name'), 'orders');
    expect(
      screen.getByText('A table with this name already exists in this base.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 3 rows' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Table name'));
    await user.type(screen.getByLabelText('Table name'), 'Khách hàng');

    vi.mocked(importsApi.start).mockResolvedValue({ job_id: JOB });
    await user.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    const body = vi.mocked(importsApi.start).mock.calls[0]?.[1] as StartImportRequest;
    expect(body).toEqual({
      upload_id: UPLOAD,
      mode: 'create_table',
      table: {
        name: 'Khách hàng',
        columns: [
          { column: 0, name: 'Tên khách', type: 'text' },
          { column: 1, name: 'Số tiền', type: 'number', options: { style: { type: 'plain' } } },
        ],
      },
    });

    await screen.findByRole('heading', { name: 'Importing' });
    act(() => {
      onJobProgress({ job_id: JOB, status: 'running', progress: 0.5 });
    });
    expect(screen.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    currentJob = job('succeeded', {
      mode: 'create_table',
      table_id: 'tbl_New0000000000001',
      rows: 3,
      imported: 2,
      failed: 1,
      errors: [
        {
          row: 4,
          data_row: 3,
          column: 1,
          column_name: 'Số tiền',
          field_id: AMOUNT.id,
          code: 'EXPECTED_NUMBER',
        },
      ],
      errors_truncated: false,
      download_url: `/api/v1/files/exports/${JOB}`,
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    act(() => {
      onJobProgress({ job_id: JOB, status: 'succeeded', progress: 1 });
    });
    await screen.findByRole('heading', { name: 'Import finished' });
    expect(screen.getByTestId('import-result-imported')).toHaveTextContent('2');
    expect(screen.getByTestId('import-result-skipped')).toHaveTextContent('1');
    const error = screen.getByTestId('import-error-row');
    expect(
      within(error)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Data row 3 (row 4 in the file)', 'Số tiền', 'Expected a number.']);
    expect(screen.getByRole('link', { name: 'Download the error report (CSV)' })).toHaveAttribute(
      'href',
      `/api/v1/files/exports/${JOB}`,
    );
    expect(screen.getByRole('button', { name: 'Open the table' })).toBeInTheDocument();
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);
  });

  it('checks the file before sending it and explains server refusals', async () => {
    await renderWizard({ mode: 'create_table' });
    chooseFile('old.xls');
    expect(screen.getByText(/older spreadsheet format/u)).toBeInTheDocument();
    chooseFile('big.csv', 0);
    expect(screen.getByText('big.csv is empty.')).toBeInTheDocument();
    expect(uploadImportFile).not.toHaveBeenCalled();

    vi.mocked(uploadImportFile).mockRejectedValue(
      new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'file', code: 'TOO_MANY_ROWS', message: '', params: { limit: 50000 } }],
      }),
    );
    chooseFile('many.csv');
    expect(await screen.findByText('The file has more than 50000 rows.')).toBeInTheDocument();

    vi.mocked(uploadImportFile).mockRejectedValue(
      new ApiError({ status: 413, code: 'UNEXPECTED_RESPONSE' }),
    );
    chooseFile('huge.csv');
    expect(await screen.findByText(/larger than 50 MB/u)).toBeInTheDocument();
  });

  it('cancels a running import after confirmation', async () => {
    const user = userEvent.setup();
    await renderWizard({ mode: 'create_table' });
    await uploadAndPreview();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    vi.mocked(importsApi.start).mockResolvedValue({ job_id: JOB });
    await user.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    await screen.findByRole('heading', { name: 'Importing' });

    await user.click(screen.getByRole('button', { name: 'Cancel import' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Cancel this import?' });
    expect(
      within(confirm).getByText(/new table and the rows already imported go to the trash/u),
    ).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Keep importing' })).toHaveFocus();
    vi.mocked(importsApi.cancel).mockResolvedValue(job('cancelled'));
    await user.click(within(confirm).getByRole('button', { name: 'Cancel import' }));
    expect(importsApi.cancel).toHaveBeenCalledWith(BASE, JOB);
    expect(await screen.findByText('The import was cancelled.')).toBeInTheDocument();
    expect(
      screen.getByText(/moved to the trash; you can restore it for 30 days/u),
    ).toBeInTheDocument();
  });
});

describe('ImportWizard: append', () => {
  it('maps columns to writable fields only and flags the others', async () => {
    const user = userEvent.setup();
    const { container } = await renderWizard(
      { mode: 'append', tableId: TABLE, tableName: 'Orders' },
      'sales',
    );
    await uploadAndPreview();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose what each column becomes' });

    const target = screen.getByLabelText('Field for column Tên khách');
    expect(target).toHaveDisplayValue('Tên khách');
    // `Mã` is an auto number: never offered, the column is flagged.
    expect(within(target).queryByRole('option', { name: 'Mã' })).toBeNull();
    expect(screen.getByText('Not imported: you cannot write Mã')).toBeInTheDocument();
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    // Two columns on one field block the import.
    await user.selectOptions(screen.getByLabelText('Field for column Mã'), AMOUNT.id);
    expect(screen.getAllByText('This field is already filled by another column.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Import 3 rows' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Field for column Mã'), '');

    vi.mocked(importsApi.start).mockResolvedValue({ job_id: JOB });
    await user.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    expect(vi.mocked(importsApi.start).mock.calls[0]?.[1]).toEqual({
      upload_id: UPLOAD,
      mode: 'append',
      table_id: TABLE,
      mapping: [
        { column: 0, field_id: TITLE.id },
        { column: 1, field_id: AMOUNT.id },
      ],
    });
  });

  it('explains link columns, lists file fields as not importable, and shows unmatched titles clearly (T419)', async () => {
    const user = userEvent.setup();
    const LINK = field('fld_Customer00000001', {
      name: 'Khách hàng',
      type: 'link',
      position: 3,
      options: { link_table: 'tbl_Customers0000001', allow_multiple: true },
    });
    const FILES = field('fld_Photos0000000001', { name: 'Ảnh', type: 'attachment', position: 4 });
    const { i18n, queryClient } = await setup('admin');
    queryClient.setQueryData(keys.fields(TABLE), {
      items: [TITLE, AMOUNT, CODE, LINK, FILES],
      total: 5,
      offset: 0,
      limit: 1000,
    });
    queryClient.setQueryData(keys.tables(BASE), {
      items: [
        { id: TABLE, name: 'Orders' },
        { id: 'tbl_Customers0000001', name: 'Customers' },
      ],
      total: 2,
      offset: 0,
      limit: 1000,
    });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ImportWizard
              baseId={BASE}
              target={{ mode: 'append', tableId: TABLE, tableName: 'Orders' }}
              onClose={vi.fn()}
            />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
    const preview: ImportPreview = {
      ...PREVIEW,
      columns: [
        { index: 0, name: 'Tên khách', type: 'text', options: {} },
        { index: 1, name: 'Khách hàng', type: 'text', options: {} },
        { index: 2, name: 'Ảnh', type: 'text', options: {} },
      ],
      rows: [['A', 'An Phát, "Nguyễn, An"', 'a.png']],
    };
    vi.mocked(uploadImportFile).mockResolvedValue({ ...UPLOADED, preview });
    chooseFile('Đơn.csv');
    await screen.findByRole('heading', { name: 'Check how the file is read' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose what each column becomes' });

    // The file field is listed, disabled, with its reason; the column says so too.
    const photos = within(screen.getByLabelText('Field for column Ảnh')).getByRole('option', {
      name: 'Ảnh (files cannot be imported)',
    });
    expect(photos).toBeDisabled();
    expect(
      screen.getByText('Not imported: Ảnh holds files, which cannot be imported'),
    ).toBeVisible();
    expect(screen.getByTestId('import-files-note')).toHaveTextContent(
      'Ảnh holds files: files cannot be imported from a sheet.',
    );
    // The link column: its table and the rules for titles.
    const hint = screen.getByTestId('import-title-hint');
    expect(hint).toHaveTextContent('Khách hàng → Khách hàng: titles of records of Customers');
    expect(hint).toHaveTextContent('separate the titles with commas');
    expect(hint).toHaveTextContent('An Phát, "Nguyễn, An"');
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);

    vi.mocked(importsApi.start).mockResolvedValue({ job_id: JOB });
    await user.click(screen.getByRole('button', { name: /^Import/u }));
    await screen.findByRole('heading', { name: 'Importing' });
    const linkError = (row: number, code: string) => ({
      row: row + 1,
      data_row: row,
      column: 1,
      column_name: 'Khách hàng',
      field_id: LINK.id,
      code,
    });
    currentJob = job('succeeded', {
      mode: 'append',
      table_id: TABLE,
      rows: 3,
      imported: 1,
      failed: 2,
      errors: [linkError(1, 'LINK_TARGET_NOT_FOUND'), linkError(2, 'LINK_TARGET_AMBIGUOUS')],
      errors_truncated: false,
      download_url: `/api/v1/files/exports/${JOB}`,
      expires_at: '2999-01-01T00:00:00.000Z',
    });
    act(() => {
      onJobProgress({ job_id: JOB, status: 'succeeded', progress: 1 });
    });
    await screen.findByRole('heading', { name: 'Import finished' });
    expect(screen.getByTestId('import-link-summary')).toHaveTextContent(
      '2 linked records not matched: 1 not found, 1 with a title several records share.',
    );
    const [notFound, ambiguous] = screen.getAllByTestId('import-error-row');
    expect(notFound).toHaveTextContent('No record with this title');
    expect(notFound).toHaveTextContent('Check the spelling');
    expect(ambiguous).toHaveTextContent('Several records have this title');
    expect(ambiguous).toHaveTextContent('write the record id (rec_…)');
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);
  });

  it('asks before leaving the column step (Escape or close), T320 QA', async () => {
    const user = userEvent.setup();
    const { onClose } = await renderWizard(
      { mode: 'append', tableId: TABLE, tableName: 'Orders' },
      'sales',
    );
    await uploadAndPreview();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose what each column becomes' });
    await user.keyboard('{Escape}');
    const confirm = screen.getByRole('alertdialog', { name: 'Leave the import?' });
    expect(within(confirm).getByRole('button', { name: 'Keep setting columns' })).toHaveFocus();
    // Escape again: back to the columns, nothing lost.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText('Field for column Tên khách')).toHaveDisplayValue('Tên khách');
    expect(onClose).not.toHaveBeenCalled();
    // The close button asks too; "Leave" closes.
    await user.click(screen.getByRole('button', { name: 'Close the import' }));
    await user.click(
      within(screen.getByRole('alertdialog', { name: 'Leave the import?' })).getByRole('button', {
        name: 'Leave',
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the job running in the background when closed', async () => {
    const user = userEvent.setup();
    const { onClose } = await renderWizard(
      { mode: 'append', tableId: TABLE, tableName: 'Orders' },
      'sales',
    );
    await uploadAndPreview();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    vi.mocked(importsApi.start).mockResolvedValue({ job_id: JOB });
    await user.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    await screen.findByRole('heading', { name: 'Importing' });
    await user.click(screen.getByRole('button', { name: 'Close the import' }));
    expect(onClose).toHaveBeenCalled();
    expect(importsApi.cancel).not.toHaveBeenCalled();
  });
});

describe('ImportMenu', () => {
  async function renderMenu(kind: Access, table?: { id: string; name: string }) {
    const { i18n, queryClient } = await setup(kind);
    return render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ImportMenu baseId={BASE} table={table} />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    );
  }

  it('offers both imports to base admins', async () => {
    const user = userEvent.setup();
    await renderMenu('admin', { id: TABLE, name: 'Orders' });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('menuitem', { name: 'Import into Orders…' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Import as a new table…' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('lets an editor with "add" append only, with the reason for the rest', async () => {
    const user = userEvent.setup();
    await renderMenu('sales', { id: TABLE, name: 'Orders' });
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(
      screen.getByRole('menuitem', {
        name: /Import as a new table…\s*Only base admins can create tables\./u,
      }),
    ).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'Import into Orders…' }));
    expect(await screen.findByRole('dialog', { name: 'Import into Orders' })).toBeInTheDocument();
  });

  it('is hidden from readers, and on a base only admins see it', async () => {
    const { unmount } = await renderMenu('reader', { id: TABLE, name: 'Orders' });
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    unmount();
    const sales = await renderMenu('sales');
    expect(screen.queryByRole('button', { name: 'Import a file' })).toBeNull();
    sales.unmount();
    await renderMenu('admin');
    expect(screen.getByRole('button', { name: 'Import a file' })).toBeInTheDocument();
  });
});
