import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../../test/i18n';
import PdfViewer, { PDF_VIEW_LIMIT, type PdfViewerHandle } from '../components/PdfViewer';

import type { CellFile } from '../../../lib/attachments/value';

const pdfjs = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(() =>
    Promise.resolve({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render,
    }),
  );
  const destroy = vi.fn(() => Promise.resolve());
  const getDocument = vi.fn(() => ({
    promise: Promise.resolve({ numPages: 3, getPage }),
    destroy,
  }));
  return { getDocument, getPage, render, destroy, GlobalWorkerOptions: { workerSrc: '' } };
});
vi.mock('pdfjs-dist', () => ({
  getDocument: pdfjs.getDocument,
  GlobalWorkerOptions: pdfjs.GlobalWorkerOptions,
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker-abc123.mjs',
}));

const FILE: CellFile = {
  id: 'att_Guide00000000000',
  name: 'huong-dan.pdf',
  size: 2048,
  mime: 'application/pdf',
  url: '/api/v1/files/att_Guide00000000000',
  thumbnail_url: null,
};

async function renderViewer(file: CellFile, onFailed = vi.fn(), language: 'en' | 'vi' = 'en') {
  const i18n = await createTestI18n(language);
  const ref = createRef<PdfViewerHandle>();
  render(
    <I18nextProvider i18n={i18n}>
      <PdfViewer ref={ref} file={file} onFailed={onFailed} />
    </I18nextProvider>,
  );
  return { ref, onFailed };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 632 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** The PDF viewer of the lightbox (BACKLOG T407 note): PDF.js, read through the API. */
describe('PdfViewer', () => {
  it('reads the file through the API and opens it without eval or WebAssembly', async () => {
    await renderViewer(FILE);
    expect(await screen.findByTestId('attachment-pdf-position')).toHaveTextContent('Page 1 / 3');
    expect(fetchMock).toHaveBeenCalledWith(
      FILE.url,
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Uint8Array) as Uint8Array,
        isEvalSupported: false,
        useWasm: false,
        enableXfa: false,
      }),
    );
    // The worker comes from the app's own bundle.
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker-abc123.mjs');
    await waitFor(() => {
      expect(pdfjs.render).toHaveBeenCalled();
    });
    expect(screen.getByRole('img', { name: 'Page 1 of 3, huong-dan.pdf' })).toBeInTheDocument();
    expect(document.querySelector('iframe, object, embed')).toBeNull();
  });

  it('turns pages with its buttons and the lightbox keys, and zooms', async () => {
    const user = userEvent.setup();
    const { ref } = await renderViewer(FILE, vi.fn(), 'vi');
    const position = await screen.findByTestId('attachment-pdf-position');
    expect(position).toHaveTextContent('Trang 1 / 3');
    expect(screen.getByRole('button', { name: 'Trang trước' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Trang sau' }));
    expect(position).toHaveTextContent('Trang 2 / 3');
    await waitFor(() => {
      expect(pdfjs.getPage).toHaveBeenLastCalledWith(2);
    });
    ref.current?.nextPage();
    await waitFor(() => {
      expect(position).toHaveTextContent('Trang 3 / 3');
    });
    ref.current?.nextPage();
    expect(screen.getByRole('button', { name: 'Trang sau' })).toBeDisabled();
    ref.current?.previousPage();
    await waitFor(() => {
      expect(position).toHaveTextContent('Trang 2 / 3');
    });
    await user.click(screen.getByRole('button', { name: 'Phóng to' }));
    expect(screen.getByText('125%')).toBeVisible();
    ref.current?.resetZoom();
    await waitFor(() => {
      expect(screen.getByText('100%')).toBeVisible();
    });
  });

  it('reports a file it cannot read or open (the lightbox falls back to its card)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const { onFailed } = await renderViewer(FILE);
    await waitFor(() => {
      expect(onFailed).toHaveBeenCalled();
    });

    pdfjs.getDocument.mockReturnValueOnce({
      promise: Promise.reject(new Error('Invalid PDF structure.')),
      destroy: pdfjs.destroy,
    });
    const second = await renderViewer({ ...FILE, id: 'att_Broken0000000000' });
    await waitFor(() => {
      expect(second.onFailed).toHaveBeenCalled();
    });
  });

  it('never reads a file over 50 MB', async () => {
    const { onFailed } = await renderViewer({ ...FILE, size: PDF_VIEW_LIMIT + 1 });
    expect(onFailed).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
