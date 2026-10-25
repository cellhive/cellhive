import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { canAsk, EMPTY_FORM, fieldConfigOf } from '../model/questions';
import { writeValue } from '../model/values';
import { FormRenderer } from '../renderer/FormRenderer';

import type {
  FormLinkSource,
  FormRendererField,
  FormRendererProps,
  FormUploadSource,
} from '../../../lib/forms/renderer';
import type { StoredFormSettings } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

vi.mock('../../../lib/attachments/transfer', () => ({
  putFile: vi.fn(() => Promise.resolve()),
  TransferError: class TransferError extends Error {},
}));

const TITLE = 'fld_Title00000000001';
const CUSTOMER = 'fld_Customer00000001';
const FILES = 'fld_Files00000000001';
const PARENT = 'fld_Parent0000000001';

const FIELDS: FormRendererField[] = [
  { id: TITLE, name: 'Title', type: 'text', options: {}, description: null, is_primary: true },
  {
    id: CUSTOMER,
    name: 'Customer',
    type: 'link',
    options: { allow_multiple: false },
    description: null,
  },
  { id: FILES, name: 'Files', type: 'attachment', options: { max_files: 3 }, description: null },
  { id: PARENT, name: 'Parent', type: 'parent', options: {}, description: null },
];

const FORM: StoredFormSettings = {
  ...EMPTY_FORM,
  title: 'Order',
  fields: [
    { field: TITLE, required: true, label: null, help: null },
    { field: CUSTOMER, required: true, label: null, help: null },
    { field: FILES, required: false, label: null, help: null },
  ],
};

const CTX = { locale: 'en', timeZone: 'UTC' };
const ok = { success_message: '', redirect_url: null };

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function renderForm(props: Partial<FormRendererProps> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <FormRenderer form={FORM} fields={FIELDS} locale={CTX} {...props} />
    </I18nextProvider>,
  );
}

const links: FormLinkSource = {
  search: vi.fn((_field: string, query: { search: string }) =>
    Promise.resolve({
      items: [
        { id: 'rec_AnPhat0000000001', title: 'An Phát', details: ['KH-1049', 'Hà Nội'] },
        { id: 'rec_BinhMinh00000001', title: 'Bình Minh' },
      ].filter((item) => item.title.toLowerCase().includes(query.search.toLowerCase())),
      hasMore: false,
    }),
  ),
};

describe('form model: link and file questions (T410)', () => {
  it('asks link and attachment fields, never parent', () => {
    expect(FIELDS.map(canAsk)).toEqual([true, true, true, false]);
    expect(fieldConfigOf(FIELDS[1] as FormRendererField)).toEqual({
      type: 'link',
      options: { allow_multiple: false },
    });
  });

  it.each([
    ['link ids', 1, [{ id: 'rec_A', name: 'A' }], { ok: true, value: ['rec_A'] }],
    [
      'one link only',
      1,
      [
        { id: 'rec_A', name: 'A' },
        { id: 'rec_B', name: 'B' },
      ],
      { ok: false, issue: { code: 'TOO_MANY_VALUES', params: { limit: 1 } } },
    ],
    [
      'file ids',
      2,
      [{ id: 'att_A', name: 'a.pdf', size: 3 }],
      { ok: true, value: [{ id: 'att_A' }] },
    ],
  ])('writes %s', (_name, index, input, expected) => {
    const config = fieldConfigOf(FIELDS[index] as FormRendererField);
    expect(config).not.toBeNull();
    if (config !== null) expect(writeValue(config, input, CTX)).toEqual(expected);
  });
});

describe('FormRenderer: link and file questions (T410)', () => {
  it('picks a linked record and sends its id; no axe violations', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(ok);
    const { container } = renderForm({ submit, links });
    await user.type(screen.getByRole('textbox', { name: /Title/u }), 'Order 1');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).not.toHaveBeenCalled();

    await user.type(screen.getByRole('combobox', { name: 'Search records' }), 'minh');
    const option = await screen.findByRole('option', { name: /Bình Minh/u });
    await user.click(option);
    const picked = screen.getByRole('list', { name: 'Picked records' });
    expect(within(picked).getByText('Bình Minh')).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledWith({
      fields: { [TITLE]: 'Order 1', [CUSTOMER]: ['rec_BinhMinh00000001'] },
    });
  });

  it('is a combobox: ↑/↓ move, Enter picks and never submits, Escape closes (T421a)', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(ok);
    const { container } = renderForm({ submit, links });
    await user.type(screen.getByRole('textbox', { name: /Title/u }), 'Order 1');
    const box = screen.getByRole('combobox', { name: 'Search records' });
    await user.click(box);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const listbox = await screen.findByRole('listbox');
    expect(box).toHaveAttribute('aria-controls', listbox.id);
    await within(listbox).findAllByRole('option');
    // Nothing is active yet: Enter neither picks nor submits.
    expect(box).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Enter}');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Picked records' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowDown}{ArrowDown}');
    const options = within(listbox).getAllByRole('option');
    expect(box).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{ArrowUp}');
    expect(box).toHaveAttribute('aria-activedescendant', options[0]?.id);
    // The display values tell records with the same title apart.
    expect(options[0]).toHaveTextContent('KH-1049 · Hà Nội');
    expect(await axeViolations(container)).toEqual([]);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(submit).not.toHaveBeenCalled();
    const picked = screen.getByRole('list', { name: 'Picked records' });
    expect(within(picked).getByText('Bình Minh')).toBeVisible();
    // One record: the list closes once picked; Escape closes it too.
    expect(box).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(submit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledWith({
      fields: { [TITLE]: 'Order 1', [CUSTOMER]: ['rec_BinhMinh00000001'] },
    });
  });

  it('uploads files through the source with the submit token and sends them', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(ok);
    const uploads: FormUploadSource = {
      start: vi.fn(() =>
        Promise.resolve({
          id: 'att_Upload0000000001' as const,
          upload: {
            method: 'PUT' as const,
            url: 'https://storage.test/put',
            headers: {},
            expires_at: '2026-09-27T00:00:00.000Z',
          },
        }),
      ),
      complete: vi.fn(() =>
        Promise.resolve({
          id: 'att_Upload0000000001',
          name: 'a.pdf',
          size: 4,
          mime: 'application/pdf',
        }),
      ),
      maxFilesPerQuestion: 10,
    };
    const antiSpam = {
      fetchToken: vi.fn(() =>
        Promise.resolve({
          submit_token: 'v1.token',
          not_before: '2000-01-01T00:00:00.000Z',
          expires_at: '2100-01-01T00:00:00.000Z',
        }),
      ),
    };
    const { container } = renderForm({ submit, links, uploads, antiSpam });
    const group = screen.getByRole('group', { name: 'Files' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (input !== null) {
      await user.upload(input, new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));
    }
    expect(await within(group).findByText('a.pdf')).toBeVisible();
    expect(uploads.start).toHaveBeenCalledWith(
      { field_id: FILES, filename: 'a.pdf', size: 4, mime: 'application/pdf' },
      'v1.token',
      expect.anything(),
    );
    expect(uploads.complete).toHaveBeenCalledWith(
      'att_Upload0000000001',
      'v1.token',
      expect.anything(),
    );

    await user.type(screen.getByRole('textbox', { name: /Title/u }), 'Order 2');
    await user.type(screen.getByRole('combobox', { name: 'Search records' }), 'an');
    await user.click(await screen.findByRole('option', { name: /An Phát/u }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: {
            [TITLE]: 'Order 2',
            [CUSTOMER]: ['rec_AnPhat0000000001'],
            [FILES]: [{ id: 'att_Upload0000000001' }],
          },
          submit_token: 'v1.token',
        }),
      );
    });
  });

  it('says why an upload through a link was refused, with the limit (T419)', async () => {
    const user = userEvent.setup();
    const refusal = (code: string, params?: Record<string, unknown>) =>
      new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [
          { path: 'size', code, message: code, ...(params === undefined ? {} : { params }) },
        ],
      });
    const start = vi
      .fn()
      .mockRejectedValueOnce(refusal('UPLOAD_LIMIT_EXCEEDED', { limit: 100 * 1024 * 1024 }))
      .mockRejectedValueOnce(refusal('SUBMIT_TOKEN_INVALID'));
    const uploads: FormUploadSource = {
      start,
      complete: vi.fn(),
      maxFilesPerQuestion: 10,
      maxTotalBytes: 100 * 1024 * 1024,
    };
    const antiSpam = {
      fetchToken: vi.fn(() =>
        Promise.resolve({
          submit_token: 'v1.token',
          not_before: '2000-01-01T00:00:00.000Z',
          expires_at: '2100-01-01T00:00:00.000Z',
        }),
      ),
    };
    const { container } = renderForm({ links, uploads, antiSpam });
    const group = screen.getByRole('group', { name: 'Files' });
    // What the question takes, with the link's limits.
    expect(group).toHaveAccessibleDescription(
      'At most 3 files · up to 100 MB per file · 100 MB in all per submission',
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await user.upload(input, new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));
    expect(await within(group).findByText(/go over 100 MB in all/u)).toBeVisible();
    await user.upload(input, new File(['%PDF'], 'b.pdf', { type: 'application/pdf' }));
    expect(await within(group).findByText(/This form session has expired/u)).toBeVisible();
    const issues = within(group).getAllByTestId('form-upload-issue');
    expect(issues).toHaveLength(2);
    // Neither can be tried again as it is: only dismissed.
    expect(within(group).queryByRole('button', { name: /Upload .* again/u })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('refuses a file type the question does not take, naming the types', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const fields = FIELDS.map((field) =>
      field.id === FILES ? { ...field, options: { max_files: 3, accept: ['image/*'] } } : field,
    );
    const uploads: FormUploadSource = { start: vi.fn(), complete: vi.fn() };
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <FormRenderer form={FORM} fields={fields} locale={CTX} links={links} uploads={uploads} />
      </I18nextProvider>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await user.upload(input, new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }));
    const group = screen.getByRole('group', { name: 'Files' });
    expect(await within(group).findByText('This question only takes images.')).toBeVisible();
    expect(uploads.start).not.toHaveBeenCalled();
  });

  it('shows the cover image of the form through the given route (T419)', () => {
    const coverUrlOf = vi.fn((id: string) => `/covers/${id}`);
    const { unmount } = renderForm({
      form: { ...FORM, cover_attachment_id: 'att_Cover00000000001' },
      coverUrlOf,
    });
    const cover = screen.getByTestId('form-cover');
    expect(cover).toHaveAttribute('src', '/covers/att_Cover00000000001');
    // Decorative: the title names the form.
    expect(cover).toHaveAttribute('alt', '');
    unmount();
    renderForm({ form: { ...FORM, cover_attachment_id: null }, coverUrlOf });
    expect(screen.queryByTestId('form-cover')).toBeNull();
  });

  it('cannot add files in a preview', () => {
    renderForm({ links });
    expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled();
    expect(screen.getByText('Files can be added when the form is filled in.')).toBeVisible();
  });
});
