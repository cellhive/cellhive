import { attachmentOptionsSchema } from '@cellhive/field-types';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { clearToasts } from '../../../lib/toast/toast';
import { Toaster } from '../../../lib/toast/Toaster';
import AttachmentCellEditor from '../components/AttachmentCellEditor';
import AttachmentSection from '../components/AttachmentSection';
import Lightbox from '../components/Lightbox';

import type { AttachmentCellProps } from '../../../lib/attachments/ui';
import type { CellFile } from '../../../lib/attachments/value';
import type { PdfViewerHandle, PdfViewerProps } from '../components/PdfViewer';
import type { FieldDto } from '@cellhive/contracts';

/** The PDF viewer (PDF.js, its own lazy chunk) is replaced: it has tests of its own. */
const pdfViewer = vi.hoisted(() => ({
  handle: {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    nextPage: vi.fn(),
    previousPage: vi.fn(),
  },
  rendered: vi.fn(),
}));
vi.mock('../components/PdfViewer', async () => {
  const { useImperativeHandle } = await import('react');
  return {
    default: function FakePdfViewer({ file, onFailed, ref }: PdfViewerProps) {
      pdfViewer.rendered(file.id);
      useImperativeHandle(ref, (): PdfViewerHandle => pdfViewer.handle);
      return (
        <button type="button" data-testid="attachment-pdf-viewer" onClick={onFailed}>
          {file.name}
        </button>
      );
    },
  };
});

const NOW = '2026-09-25T00:00:00.000Z';

function fieldDto(options: Record<string, unknown>): FieldDto {
  return {
    id: 'fld_Photos0000000001',
    table_id: 'tbl_Products00000001',
    name: 'Ảnh sản phẩm',
    type: 'attachment',
    options,
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 2,
    created_at: NOW,
    updated_at: NOW,
  };
}

function cellFile(id: string, name: string, mime: string, size = 412_000): CellFile {
  const full = `att_${id.padEnd(16, '0')}`;
  return { id: full, name, size, mime, url: `/api/v1/files/${full}`, thumbnail_url: null };
}

const FRONT = cellFile('Front', 'mat-truoc.jpg', 'image/jpeg');
const SIDE = cellFile('Side', 'canh-ben.jpg', 'image/jpeg');
const GUIDE = cellFile('Guide', 'huong-dan-lap-dat.pdf', 'application/pdf', 1_887_437);

let recordSequence = 0;

function props(overrides: Partial<AttachmentCellProps> = {}) {
  recordSequence += 1;
  const options = attachmentOptionsSchema.parse({
    accept: ['image/jpeg', 'image/png', 'image/webp'],
    max_files: 8,
  });
  const write = vi.fn();
  const attach = vi.fn();
  return {
    tableId: 'tbl_Products00000001',
    // A new record per test: the upload store is shared by the tab.
    recordId: `rec_${String(recordSequence).padStart(16, '0')}`,
    field: fieldDto(options),
    options,
    files: [FRONT, SIDE, GUIDE],
    canEdit: true,
    canDownload: true,
    recordTitle: 'Máy in nhiệt 80mm',
    write,
    host: { attach },
    ...overrides,
  } satisfies AttachmentCellProps;
}

async function renderWith(ui: React.ReactElement, language: 'en' | 'vi' = 'en') {
  const i18n = await createTestI18n(language);
  return render(
    <I18nextProvider i18n={i18n}>
      {ui}
      <Toaster />
    </I18nextProvider>,
  );
}

afterEach(() => {
  clearToasts();
});

describe('record panel section (board S4 "Tệp trong chi tiết record")', () => {
  it('shows images as cards and documents as a list, with the count and upload', async () => {
    await renderWith(<AttachmentSection {...props()} narrow={false} />);
    const section = screen.getByTestId('attachment-section');
    expect(within(section).getByRole('heading', { name: 'Ảnh sản phẩm' })).toBeVisible();
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('3 / 8 files');
    expect(screen.getAllByTestId('attachment-tile')).toHaveLength(2);
    expect(screen.getAllByTestId('attachment-row')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Download huong-dan-lap-dat.pdf' })).toHaveAttribute(
      'href',
      GUIDE.url,
    );
    expect(await axeViolations(section)).toEqual([]);
  });

  it('checks files before any upload: blocked type, not accepted, too many', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const cell = props({ files: [FRONT, SIDE, GUIDE, FRONT, SIDE, GUIDE, FRONT] });
    await renderWith(<AttachmentSection {...cell} narrow={false} />, 'vi');
    const [input] = screen.getAllByTestId('attachment-file-input');
    if (input === undefined) throw new Error('no file input');
    await user.upload(input, [
      new File(['MZ'], 'setup-driver.exe', { type: 'application/x-msdownload' }),
      new File(['x'], 'tem-nhan.heic', { type: 'image/heic' }),
    ]);
    const errors = await screen.findAllByTestId('attachment-upload-error');
    expect(errors.map((error) => error.textContent)).toEqual([
      'Trường này chặn tệp .exe',
      'Không nhận HEIC. Đổi sang JPG rồi tải lại.',
    ]);
    // Dismissing a refused file leaves nothing behind.
    await user.click(screen.getByRole('button', { name: 'Bỏ setup-driver.exe' }));
    expect(screen.getAllByTestId('attachment-upload-error')).toHaveLength(1);
  });

  it('removes a file with one write, and the toast puts it back', async () => {
    const user = userEvent.setup();
    const cell = props();
    await renderWith(<AttachmentSection {...cell} narrow={false} />);
    await user.click(screen.getByRole('button', { name: 'Delete canh-ben.jpg' }));
    expect(cell.write).toHaveBeenLastCalledWith([FRONT, GUIDE]);
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(cell.write).toHaveBeenLastCalledWith([FRONT, SIDE, GUIDE]);
  });

  it('readers see the files but cannot upload, remove or reorder', async () => {
    await renderWith(<AttachmentSection {...props({ canEdit: false })} narrow={false} />);
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.queryByTestId('attachment-drop-zone')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reorder / })).toBeNull();
  });

  it('without the download right: no download link and no image requested', async () => {
    const { container } = await renderWith(
      <AttachmentSection {...props({ canDownload: false })} narrow={false} />,
    );
    expect(screen.queryByTestId('attachment-download')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('phones: two columns, "Take photo" with the camera and a sort mode with move buttons', async () => {
    const user = userEvent.setup();
    const cell = props();
    await renderWith(<AttachmentSection {...cell} narrow />);
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeVisible();
    expect(screen.getByTestId('attachment-camera-input')).toHaveAttribute('capture', 'environment');
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.click(screen.getByRole('button', { name: 'Move canh-ben.jpg up' }));
    expect(cell.write).toHaveBeenLastCalledWith([SIDE, FRONT, GUIDE]);
  });
});

describe('cell popover (board S4 "Ô tệp đính kèm và tải lên")', () => {
  it('lists the files, closes on Escape, opens the viewer', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await renderWith(
      <AttachmentCellEditor {...props()} cellWidth={180} cellHeight={34} onClose={onClose} />,
      'vi',
    );
    const popover = screen.getByTestId('attachment-popover');
    expect(within(popover).getByText('3 / 8 tệp')).toBeVisible();
    expect(within(popover).getAllByTestId('attachment-row')).toHaveLength(3);
    expect(screen.getByTestId('attachment-drop-zone')).toHaveTextContent(
      'JPG, PNG, WEBP · tối đa 100 MB mỗi tệp · còn 5 tệp',
    );
    const [, side] = within(popover).getAllByTestId('attachment-row');
    if (side === undefined) throw new Error('no second row');
    await user.click(within(side).getByTestId('attachment-view'));
    const viewer = await screen.findByTestId('attachment-lightbox');
    expect(within(viewer).getByRole('img', { name: 'canh-ben.jpg' })).toBeInTheDocument();
    // Escape closes the viewer only.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('attachment-lightbox')).toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(await axeViolations(popover)).toEqual([]);
  });

  it('says when the cell is full', async () => {
    const full = [FRONT, SIDE, GUIDE, FRONT, SIDE, GUIDE, FRONT, SIDE].map((file, index) => ({
      ...file,
      id: `${file.id.slice(0, 19)}${String(index)}`,
    }));
    await renderWith(
      <AttachmentCellEditor
        {...props({ files: full })}
        cellWidth={180}
        cellHeight={34}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('attachment-full')).toHaveTextContent('8 / 8 files.');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });
});

describe('viewer (boards S4 "Xem ảnh đính kèm", "Xem PDF và tệp khác")', () => {
  function Viewer(overrides: Partial<React.ComponentProps<typeof Lightbox>> = {}) {
    return (
      <Lightbox
        files={[FRONT, SIDE, GUIDE]}
        index={0}
        onIndex={vi.fn()}
        onClose={vi.fn()}
        recordTitle="Máy in nhiệt 80mm"
        recordId="rec_0000000000000001"
        fieldName="Ảnh sản phẩm"
        canDownload
        {...overrides}
      />
    );
  }

  it('goes through the files with the arrow keys, Home and End, and wraps', async () => {
    const user = userEvent.setup();
    const onIndex = vi.fn();
    await renderWith(<Viewer onIndex={onIndex} index={1} />);
    expect(screen.getByTestId('attachment-lightbox-index')).toHaveTextContent('2 / 3');
    await user.keyboard('{ArrowRight}');
    expect(onIndex).toHaveBeenLastCalledWith(2);
    await user.keyboard('{ArrowLeft}');
    expect(onIndex).toHaveBeenLastCalledWith(0);
    await user.keyboard('{End}');
    expect(onIndex).toHaveBeenLastCalledWith(2);
    await user.keyboard('{Home}');
    expect(onIndex).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole('button', { name: 'File 2 of 3: canh-ben.jpg' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('shows a PDF in the viewer (lazy PDF.js) driven by the keyboard (T407)', async () => {
    const user = userEvent.setup();
    const onIndex = vi.fn();
    await renderWith(<Viewer index={2} onIndex={onIndex} />);
    expect(await screen.findByTestId('attachment-pdf-viewer')).toHaveTextContent(GUIDE.name);
    await user.keyboard('{PageDown}');
    expect(pdfViewer.handle.nextPage).toHaveBeenCalledTimes(1);
    await user.keyboard('{PageUp}');
    expect(pdfViewer.handle.previousPage).toHaveBeenCalledTimes(1);
    await user.keyboard('+-0');
    expect(pdfViewer.handle.zoomIn).toHaveBeenCalledTimes(1);
    expect(pdfViewer.handle.zoomOut).toHaveBeenCalledTimes(1);
    expect(pdfViewer.handle.resetZoom).toHaveBeenCalledTimes(1);
    // ← / → still go through the files of the cell.
    await user.keyboard('{ArrowRight}');
    expect(onIndex).toHaveBeenLastCalledWith(0);
    expect(screen.getByTestId('attachment-lightbox-download')).toBeVisible();
    // Never embedded: no frame, no object.
    expect(document.querySelector('iframe, object, embed')).toBeNull();
  });

  it('falls back to the card (new tab, download) when the PDF cannot be shown', async () => {
    const user = userEvent.setup();
    await renderWith(<Viewer index={2} />);
    await user.click(await screen.findByTestId('attachment-pdf-viewer'));
    const card = screen.getByTestId('attachment-file-card');
    expect(card).toHaveTextContent('The PDF could not be shown here.');
    expect(within(card).getByRole('button', { name: 'Open in a new tab' })).toBeEnabled();
    expect(within(card).getByRole('link', { name: 'Download' })).toHaveAttribute('href', GUIDE.url);
    expect(document.querySelector('iframe, object, embed')).toBeNull();
  });

  it('only offers the download of a PDF over 50 MB (never read into memory)', async () => {
    pdfViewer.rendered.mockClear();
    const huge = { ...GUIDE, size: 60 * 1024 * 1024 };
    await renderWith(<Viewer files={[huge]} index={0} />);
    const card = screen.getByTestId('attachment-file-card');
    expect(card).toHaveTextContent('This PDF is too large to show here.');
    expect(within(card).queryByRole('button', { name: 'Open in a new tab' })).toBeNull();
    expect(within(card).getByRole('link', { name: 'Download' })).toBeVisible();
    expect(pdfViewer.rendered).not.toHaveBeenCalled();
  });

  it('without the download right says so instead of requesting the file', async () => {
    await renderWith(<Viewer canDownload={false} />);
    expect(screen.getByTestId('attachment-file-card')).toHaveTextContent(
      'You can see this field but not open its files.',
    );
    expect(screen.queryByTestId('attachment-lightbox-download')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('without the download right shows images through their thumbnails, no download (T407)', async () => {
    const user = userEvent.setup();
    const withThumbnails = [FRONT, SIDE].map((file) => ({
      ...file,
      thumbnail_url: `${file.url}/thumbnail`,
    }));
    await renderWith(<Viewer canDownload={false} files={[...withThumbnails, GUIDE]} />);
    const image = screen.getByTestId('attachment-lightbox-image');
    expect(image).toHaveAttribute('src', `${FRONT.url}/thumbnail?size=1280`);
    expect(image).toHaveAttribute('alt', FRONT.name);
    expect(screen.queryByTestId('attachment-lightbox-download')).toBeNull();
    // The strip shows the small thumbnails; the original is never requested.
    const sources = [...document.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toContain(`${SIDE.url}/thumbnail`);
    expect(sources.some((source) => source === FRONT.url || source === SIDE.url)).toBe(false);
    await user.keyboard('{End}');
  });

  it('offers "Remove from cell" in its menu when the user may edit', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    await renderWith(<Viewer onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from cell' }));
    expect(onRemove).toHaveBeenCalledWith(FRONT);
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await renderWith(<Viewer onClose={onClose} />);
    await act(async () => {
      await userEvent.keyboard('{Escape}');
    });
    expect(onClose).toHaveBeenCalled();
  });
});
