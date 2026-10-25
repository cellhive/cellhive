import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { ApiError } from '../../../../lib/api/client';
import {
  checkEmailImageFile,
  emailImageIssueOf,
  type EmailImageUploader,
} from '../../../../lib/email-images/InsertImageButton';
import { SignatureEditor } from '../components/SignatureEditor';

import type { i18n as I18n } from 'i18next';
import type { ReactElement } from 'react';

const ORG = 'org_0000000000000001';
const ASSET = 'att_Logo000000000001' as const;

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function renderWith(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function uploader(overrides: Partial<EmailImageUploader> = {}): EmailImageUploader {
  return {
    start: vi.fn(() =>
      Promise.resolve({
        id: ASSET,
        upload: {
          method: 'PUT' as const,
          url: 'https://storage.test/put',
          headers: {},
          expires_at: '2026-10-07T00:00:00.000Z',
        },
      }),
    ),
    put: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() =>
      Promise.resolve({
        id: ASSET,
        kind: 'signature' as const,
        name: 'logo.png',
        mime: 'image/png' as const,
        size: 4,
        width: 120,
        height: 40,
        markdown: `![logo](asset:${ASSET} =120)`,
        url: `/api/v1/orgs/${ORG}/email-assets/${ASSET}`,
      }),
    ),
    ...overrides,
  };
}

function Editor({ initial, upload }: { initial: string; upload: EmailImageUploader }) {
  const [value, setValue] = useState(initial);
  return (
    <SignatureEditor
      value={value}
      onChange={setValue}
      imageTarget={{ kind: 'org', orgId: ORG }}
      imageUploader={upload}
    />
  );
}

const png = () => new File(['\u0089PNG'], 'logo.png', { type: 'image/png' });

/** T534: "Insert image" in the signature editors (T526/T533). */
describe('email images: insert image', () => {
  it('checks files like the server before sending anything', () => {
    expect(checkEmailImageFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toBe(
      'MIME_NOT_ACCEPTED',
    );
    expect(checkEmailImageFile({ name: 'a.png', type: 'image/png', size: 11 * 1024 * 1024 })).toBe(
      'FILE_TOO_LARGE',
    );
    expect(checkEmailImageFile({ name: 'a.webp', type: '', size: 10 })).toBeNull();
    expect(
      emailImageIssueOf(
        new ApiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [{ path: '', code: 'IMAGE_UNREADABLE', message: '' }],
        }),
      ),
    ).toBe('IMAGE_UNREADABLE');
    expect(emailImageIssueOf(new ApiError({ status: 403, code: 'PERMISSION_DENIED' }))).toBe(
      'DENIED',
    );
  });

  it('uploads a logo to the organization, inserts it and previews it from the API', async () => {
    const user = userEvent.setup();
    const upload = uploader();
    const { container } = renderWith(<Editor initial="**HR**" upload={upload} />);
    const input = screen.getByTestId('email-image-input');
    await user.upload(input, png());
    await waitFor(() => {
      expect(screen.getByLabelText('Signature')).toHaveValue(
        `**HR**\n![logo](asset:${ASSET} =120)`,
      );
    });
    expect(upload.start).toHaveBeenCalledWith(
      { kind: 'org', orgId: ORG },
      { filename: 'logo.png', size: 5, mime: 'image/png' },
      expect.anything(),
    );
    const image = screen.getByRole('img', { name: 'logo' });
    expect(image).toHaveAttribute('src', `/api/v1/orgs/${ORG}/email-assets/${ASSET}`);
    expect(image).toHaveAttribute('width', '120');
    expect(screen.getByRole('status')).toHaveTextContent('logo.png inserted.');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('refuses SVG before sending, and stops at two images', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const upload = uploader();
    renderWith(<Editor initial={`![a](asset:${ASSET})\n![b](asset:${ASSET})`} upload={upload} />);
    expect(screen.getByRole('button', { name: 'Insert image' })).toBeDisabled();
    expect(upload.start).not.toHaveBeenCalled();

    const other = renderWith(<Editor initial="" upload={upload} />);
    const input = other.getAllByTestId('email-image-input').at(-1);
    await user.upload(
      input as HTMLInputElement,
      new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }),
    );
    expect(other.getByRole('alert')).toHaveTextContent(
      'Choose a PNG, JPEG, GIF or WebP image (SVG is not allowed).',
    );
    expect(upload.start).not.toHaveBeenCalled();
  });

  it('says why a link to an image is refused, and shows its alt text only', async () => {
    const user = userEvent.setup();
    renderWith(<Editor initial="" upload={uploader()} />);
    await user.click(screen.getByLabelText('Signature'));
    await user.paste('Logo ![Acme](https://x.test/a.png)');
    expect(screen.getByText(/links to images and data: images are not sent/u)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
