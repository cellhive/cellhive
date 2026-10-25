import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import {
  CoverPicker,
  checkCoverFile,
  coverIssueOf,
  type CoverUploader,
} from '../components/CoverPicker';
import { QuestionSettings, hasRecordFilter } from '../components/QuestionSettings';
import { questionsOf, EMPTY_FORM } from '../model/questions';

import type { FormRendererField } from '../../../lib/forms/renderer';
import type { i18n as I18n } from 'i18next';
import type { ReactElement } from 'react';

const VIEW = 'viw_Form000000000001';
const COVER = 'att_Cover00000000001' as const;

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function renderWith(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function uploader(overrides: Partial<CoverUploader> = {}): CoverUploader {
  return {
    start: vi.fn(() =>
      Promise.resolve({
        id: COVER,
        upload: {
          method: 'PUT' as const,
          url: 'https://storage.test/put',
          headers: {},
          expires_at: '2026-09-27T00:00:00.000Z',
        },
      }),
    ),
    put: vi.fn((_target, _file, onProgress: (loaded: number) => void) => {
      onProgress(2);
      return Promise.resolve();
    }),
    complete: vi.fn(() =>
      Promise.resolve({
        id: COVER,
        name: 'cover.png',
        size: 4,
        mime: 'image/png',
        url: `/api/v1/views/${VIEW}/form-cover/${COVER}`,
      }),
    ),
    ...overrides,
  };
}

const png = () => new File(['\u0089PNG'], 'cover.png', { type: 'image/png' });

/** T419: the cover image of a form in the builder. */
describe('form builder: cover image (T419)', () => {
  it('checks files like the server before sending anything', () => {
    expect(checkCoverFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toBe(
      'MIME_NOT_ACCEPTED',
    );
    expect(checkCoverFile({ name: 'a.png', type: 'image/png', size: 6 * 1024 * 1024 })).toBe(
      'FILE_TOO_LARGE',
    );
    expect(checkCoverFile({ name: 'a.jpg', type: '', size: 10 })).toBeNull();
    expect(
      coverIssueOf(
        new ApiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [{ path: '', code: 'CONTENT_MISMATCH', message: '' }],
        }),
      ),
    ).toBe('CONTENT_MISMATCH');
    expect(coverIssueOf(new ApiError({ status: 403, code: 'PERMISSION_DENIED' }))).toBe('DENIED');
  });

  it('uploads a cover through the view and names it in the form', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const upload = uploader();
    const { container } = renderWith(
      <CoverPicker viewId={VIEW} coverId={null} canUpload onChange={onChange} uploader={upload} />,
    );
    const group = screen.getByRole('group', { name: 'Cover image' });
    expect(
      within(group).getByRole('button', { name: 'Add a cover image' }),
    ).toHaveAccessibleDescription(/PNG, JPG, GIF or WebP, up to 5 MB/u);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no input');
    await user.upload(input, png());
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(COVER);
    });
    expect(upload.start).toHaveBeenCalledWith(
      VIEW,
      { filename: 'cover.png', size: 5, mime: 'image/png' },
      expect.anything(),
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it('shows the cover with change and remove; says why a file is refused', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onChange = vi.fn();
    const upload = uploader();
    const { container } = renderWith(
      <CoverPicker viewId={VIEW} coverId={COVER} canUpload onChange={onChange} uploader={upload} />,
    );
    expect(screen.getByRole('img', { name: 'Cover image of the form' })).toHaveAttribute(
      'src',
      `/api/v1/views/${VIEW}/form-cover/${COVER}`,
    );
    await user.click(screen.getByRole('button', { name: 'Remove cover' }));
    expect(onChange).toHaveBeenCalledWith(null);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no input');
    await user.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'logo.svg is not a PNG, JPG, GIF or WebP image.',
    );
    expect(upload.start).not.toHaveBeenCalled();
  });

  it('reports a refusal of the server under the picker', async () => {
    const user = userEvent.setup();
    const upload = uploader({
      complete: vi.fn(() =>
        Promise.reject(
          new ApiError({
            status: 422,
            code: 'VALIDATION_FAILED',
            errors: [{ path: '', code: 'CONTENT_MISMATCH', message: '' }],
          }),
        ),
      ),
    });
    const onChange = vi.fn();
    const { container } = renderWith(
      <CoverPicker viewId={VIEW} coverId={null} canUpload onChange={onChange} uploader={upload} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no input');
    await user.upload(input, png());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cover.png is not an image of the type its name says.',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('explains instead of offering uploads without the right to change the view', () => {
    renderWith(<CoverPicker viewId={VIEW} coverId={null} canUpload={false} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add a cover image' })).toBeNull();
    expect(screen.getByText(/Only people who can change this view/u)).toBeVisible();
  });
});

const FILES: FormRendererField = {
  id: 'fld_Files00000000001',
  name: 'Photos',
  type: 'attachment',
  options: { accept: ['image/*', 'application/pdf'], max_files: 20 },
  description: null,
};
const CUSTOMER: FormRendererField = {
  id: 'fld_Customer00000001',
  name: 'Customer',
  type: 'link',
  options: {
    link_table: 'tbl_Customers0000001',
    allow_multiple: true,
    record_filter: { op: 'and', items: [{ field: 'fld_Tier', operator: 'eq', value: 'Gold' }] },
  },
  description: null,
};

/** T419: what link and file questions take, in the builder. */
describe('form builder: question settings (T419)', () => {
  const [files, customer] = questionsOf(
    {
      ...EMPTY_FORM,
      fields: [
        { field: FILES.id, required: false, label: null, help: null },
        { field: CUSTOMER.id, required: false, label: null, help: null },
      ],
    },
    [FILES, CUSTOMER],
  );

  it('lists the types, the file limits and the limits of form links', async () => {
    if (files === undefined) throw new Error('no question');
    const { container } = renderWith(<QuestionSettings question={files} />);
    const settings = screen.getByTestId('form-question-settings');
    expect(settings).toHaveTextContent('File typesimages, PDF');
    expect(settings).toHaveTextContent('At most 20 files (through a link: 10)');
    expect(settings).toHaveTextContent(
      '100 MB per file; through a link, 100 MB in all per submission',
    );
    expect(settings).toHaveTextContent('Set on the field “Photos”');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('names the linked table, how many records and the record filter', () => {
    if (customer === undefined) throw new Error('no question');
    renderWith(<QuestionSettings question={customer} linkTableName="Customers" />);
    const settings = screen.getByTestId('form-question-settings');
    expect(settings).toHaveTextContent('TableCustomers');
    expect(settings).toHaveTextContent('Several records (at most 500)');
    expect(settings).toHaveTextContent(
      'Only records that match the field’s condition can be picked',
    );
    expect(hasRecordFilter({ record_filter: null })).toBe(false);
    expect(hasRecordFilter({ record_filter: { op: 'and', items: [] } })).toBe(false);
  });
});
