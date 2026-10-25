import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import ReadOnlyFiles from '../components/ReadOnlyFiles';
import ReadOnlyViewer from '../components/ReadOnlyViewer';

import type { ReactElement } from 'react';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';
const FILES = [
  {
    id: 'att_Photo00000000001',
    name: 'front.png',
    size: 2048,
    mime: 'image/png',
    url: `/api/v1/shares/${TOKEN}/files/att_Photo00000000001`,
    thumbnail_url: `/api/v1/shares/${TOKEN}/files/att_Photo00000000001/thumbnail`,
  },
  {
    id: 'att_Doc0000000000001',
    name: 'contract.pdf',
    size: 1024,
    mime: 'application/pdf',
    url: `/api/v1/shares/${TOKEN}/files/att_Doc0000000000001`,
    thumbnail_url: null,
  },
];

async function renderWith(ui: ReactElement) {
  const i18n = await createTestI18n('en');
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

/** T409: the files of a cell on the share page (thumbnails, viewer, download only when allowed). */
describe('read-only files (T409)', () => {
  it('shows thumbnails and badges; the viewer has no download without the right', async () => {
    const user = userEvent.setup();
    await renderWith(
      <ReadOnlyFiles value={FILES} fieldName="Files" recordTitle="r1" canDownload={false} />,
    );
    const list = screen.getByRole('list', { name: 'Files of Files' });
    // The image through its thumbnail (T407: no download right needed), the PDF as a badge.
    expect(list.querySelector('img')).toHaveAttribute('src', FILES[0]?.thumbnail_url);
    expect(within(list).getByText('PDF')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'View front.png' }));
    expect(await screen.findByTestId('attachment-lightbox')).toBeVisible();
    expect(screen.queryByTestId('attachment-lightbox-download')).toBeNull();
    // No "copy link to record" menu without a record page.
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });

  it('offers the download of the share route when allowed', async () => {
    const user = userEvent.setup();
    await renderWith(
      <ReadOnlyFiles value={FILES} fieldName="Files" recordTitle="r1" canDownload />,
    );
    await user.click(screen.getByRole('button', { name: 'View contract.pdf' }));
    expect(await screen.findByTestId('attachment-lightbox-download')).toHaveAttribute(
      'href',
      FILES[1]?.url,
    );
  });

  it('renders nothing for an empty cell', async () => {
    const { container } = await renderWith(
      <ReadOnlyFiles value={null} fieldName="Files" recordTitle="r1" canDownload />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

/** T419: the viewer alone, opened from a cell or a card of the share grid. */
describe('read-only viewer (T419)', () => {
  it('opens on the chosen file and closes; downloads only when allowed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await renderWith(
      <ReadOnlyViewer
        value={FILES}
        fieldName="Files"
        recordTitle="r1"
        canDownload={false}
        index={1}
        onClose={onClose}
      />,
    );
    const viewer = await screen.findByTestId('attachment-lightbox');
    expect(viewer).toHaveTextContent('contract.pdf');
    expect(viewer).toHaveTextContent('2 / 2');
    expect(screen.queryByTestId('attachment-lightbox-download')).toBeNull();
    await user.keyboard('{Home}');
    expect(viewer).toHaveTextContent('1 / 2');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('offers the download of the share route when allowed', async () => {
    await renderWith(
      <ReadOnlyViewer
        value={FILES}
        fieldName="Files"
        recordTitle="r1"
        canDownload
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByTestId('attachment-lightbox-download')).toHaveAttribute(
      'href',
      FILES[0]?.url,
    );
  });

  it('renders nothing without files', async () => {
    const { container } = await renderWith(
      <ReadOnlyViewer
        value={[]}
        fieldName="Files"
        recordTitle="r1"
        canDownload
        onClose={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
