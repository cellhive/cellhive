import { collectImages, IMAGE_SOURCES, parseTemplate } from '@cellhive/markdown';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { EmailImageContext, type EmailImageOptions } from '../actions/send-email/image-context';
import { EmailImageButton } from '../actions/send-email/image-hook';
import {
  acceptsEmailImages,
  assetImageText,
  bodyImageAlt,
  bodyImageCount,
  emailImageFields,
  fieldImageText,
} from '../actions/send-email/images';
import { escapeTemplateText } from '../model/values';

import type { EmailImageUploader } from '../../../../lib/email-images/InsertImageButton';
import type { i18n as I18n } from 'i18next';
import type { ReactElement } from 'react';

/** T534 in the `send_email` body editor (T522): "Insert image". */

const AUTOMATION = 'aut_Email00000000001';
const ASSET = 'att_Body000000000001' as const;
const FIELD = 'fld_Photos0000000001';

/** What the server reads from a body the editor stored after inserting `text`. */
function storedImages(text: string) {
  return collectImages(parseTemplate(escapeTemplateText(text), { images: IMAGE_SOURCES }).blocks);
}

describe('email image rules', () => {
  it.each<[unknown, boolean]>([
    [{}, true],
    [{ accept: null }, true],
    [{ accept: ['image/*'] }, true],
    [{ accept: ['application/pdf', 'image/png'] }, true],
    [{ accept: ['image/svg+xml'] }, false],
    [{ accept: ['application/pdf'] }, false],
    [null, true],
  ])('acceptsEmailImages(%j) = %s', (options, expected) => {
    expect(acceptsEmailImages(options)).toBe(expected);
  });

  it('offers attachment fields with images the editor may download', () => {
    const fields = [
      { id: 'fld_a', name: 'A', type: 'attachment', options: {} },
      { id: 'fld_b', name: 'B', type: 'attachment', options: { accept: ['application/pdf'] } },
      { id: 'fld_c', name: 'C', type: 'attachment', options: { accept: ['image/*'] } },
      { id: 'fld_d', name: 'D', type: 'text', options: {} },
    ] as const;
    expect(emailImageFields(fields, (id) => id !== 'fld_c')).toEqual([{ id: 'fld_a', name: 'A' }]);
  });

  it.each<[string, string, string]>([
    // name, text inserted in the editor, alt the server reads
    ['Ảnh', '![Ảnh]', 'Ảnh'],
    ['Ảnh [chính]', '![Ảnh (chính)]', 'Ảnh (chính)'],
    [
      'x](https://evil.test/a.png) ![y',
      '![x)(https://evil.test/a.png) !(y]',
      'x)(https://evil.test/a.png) !(y',
    ],
    ['C:\\ảnh\\', '![C:\\ảnh\\]', 'C:\\ảnh\\'],
    ['{{ [fld_x] }} \\{', '![{{ (fld_x) }} \\{]', '{{ (fld_x) }} \\{'],
    ['two\nlines', '![two lines]', 'two lines'],
  ])('a field named %j stays one image', (name, prefix, alt) => {
    const text = fieldImageText({ id: FIELD, name });
    expect(text).toBe(`${prefix}(field:${FIELD})`);
    expect(storedImages(text)).toEqual([
      { type: 'image', source: 'field', id: FIELD, alt, width: null },
    ]);
  });

  it('caps the alt text at 200 characters', () => {
    expect(Array.from(bodyImageAlt('ả'.repeat(300)))).toHaveLength(200);
  });

  it("rewrites the alt text of the server's Markdown of an upload", () => {
    const text = assetImageText({ markdown: `![logo \\[1\\]](asset:${ASSET} =240)` });
    expect(text).toBe(`![logo (1)](asset:${ASSET} =240)`);
    expect(storedImages(text)).toEqual([
      { type: 'image', source: 'asset', id: ASSET, alt: 'logo (1)', width: 240 },
    ]);
  });

  it('counts each asset and each field once, like the server', () => {
    const body = `![a](asset:${ASSET}) ![b](asset:${ASSET})\n![c](field:${FIELD})\n![d](https://x.test/a.png)`;
    expect(bodyImageCount(body)).toBe(2);
  });
});

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function renderWith(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function uploader(): EmailImageUploader {
  return {
    start: vi.fn(() =>
      Promise.resolve({
        id: ASSET,
        upload: {
          method: 'PUT' as const,
          url: 'https://storage.test/put',
          headers: {},
          expires_at: '2026-10-17T00:00:00.000Z',
        },
      }),
    ),
    put: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() =>
      Promise.resolve({
        id: ASSET,
        kind: 'automation' as const,
        name: 'banner [new].png',
        mime: 'image/png' as const,
        size: 4,
        width: 1200,
        height: 400,
        markdown: `![banner \\[new\\]](asset:${ASSET} =552)`,
        url: `/api/v1/automations/${AUTOMATION}/email-assets/${ASSET}`,
      }),
    ),
  };
}

describe('EmailImageButton', () => {
  const base: EmailImageOptions = { automationId: AUTOMATION, fields: [], count: 0, max: 5 };

  function renderButton(options: EmailImageOptions, onInsert = vi.fn()) {
    return renderWith(
      <EmailImageContext.Provider value={options}>
        <EmailImageButton onInsert={onInsert} tabIndex={0} toolId="image" />
      </EmailImageContext.Provider>,
    );
  }

  it('uploads an image for the automation and inserts it', async () => {
    const onInsert = vi.fn();
    const upload = uploader();
    renderButton({ ...base, uploader: upload }, onInsert);
    const file = new File(['\u0089PNG'], 'banner [new].png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('email-image-input'), file);
    await waitFor(() => {
      expect(onInsert).toHaveBeenCalledWith(`![banner (new)](asset:${ASSET} =552)`);
    });
    expect(upload.start).toHaveBeenCalledWith(
      { kind: 'automation', automationId: AUTOMATION },
      expect.objectContaining({ filename: 'banner [new].png', mime: 'image/png' }),
      expect.anything(),
    );
    expect(screen.getByTestId('email-image-status')).toHaveTextContent(
      'banner [new].png inserted.',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it.each<[string | null, number, string]>([
    [null, 0, 'Save the automation first: its images are stored with it.'],
    [AUTOMATION, 5, 'An email has at most 5 images.'],
  ])('is off with its reason (automation %s, %i images)', (automationId, count, reason) => {
    renderButton({ ...base, automationId, count });
    const button = screen.getByTestId('email-image-insert');
    expect(button).toBeDisabled();
    // T527: the reason is visible text (a disabled button never shows a
    // tooltip) and describes the button.
    expect(screen.getByTestId('email-image-disabled-reason')).toHaveTextContent(reason);
    expect(button).toHaveAccessibleDescription(reason);
  });

  it('shows no reason while the button is usable', () => {
    renderButton({ ...base, automationId: AUTOMATION, count: 1 });
    expect(screen.getByTestId('email-image-insert')).toBeEnabled();
    expect(screen.queryByTestId('email-image-disabled-reason')).toBeNull();
  });

  it('renders nothing outside the send_email editor', () => {
    const { container } = renderWith(
      <EmailImageButton onInsert={vi.fn()} tabIndex={0} toolId="image" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
