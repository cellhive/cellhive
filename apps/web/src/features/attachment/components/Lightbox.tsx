import { cn } from '@cellhive/ui';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Link as LinkIcon,
  MoreHorizontal,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { formatBytes } from '../../../lib/attachments/format';
import {
  badgeLabel,
  largeThumbnailOf,
  previewModeOf,
  type PreviewMode,
} from '../../../lib/attachments/kinds';
import { localPreviews } from '../../../lib/attachments/previews';
import { RECORD_PARAM } from '../../../lib/records/detail';
import { showToast } from '../../../lib/toast/toast';

import { FileThumb } from './FileThumb';

import type { PdfViewerHandle } from './PdfViewer';
import type { CellFile } from '../../../lib/attachments/value';

/** PDF.js and its viewer: a chunk of their own, loaded only when a PDF is opened (T407). */
const PdfViewer = lazy(() => import('./PdfViewer'));

/** PDFs larger than this are only downloaded (viewing one reads it whole into memory). */
export const PDF_OPEN_LIMIT = 50 * 1024 * 1024;
/** Zoom steps of + / −, and the bounds relative to the image's own size. */
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

export interface LightboxProps {
  readonly files: readonly CellFile[];
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
  /** "Máy in nhiệt 80mm · Ảnh sản phẩm": the record and the field of the files. */
  readonly recordTitle: string;
  /** The record of the files; absent on a share page (no "copy link to record", T409). */
  readonly recordId?: string | undefined;
  readonly fieldName: string;
  readonly canDownload: boolean;
  /** "Remove from cell" in the "⋯" menu (the user may edit the field). */
  readonly onRemove?: ((file: CellFile) => void) | undefined;
}

const MENU_LINK = 'link';
const MENU_REMOVE = 'remove';

const VIEWER_BUTTON =
  'inline-flex items-center justify-center rounded-md text-viewer-fg hover:bg-viewer-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-fg disabled:opacity-50';

/** Whether this browser plays a type (`<video>`/`<audio>` `canPlayType`). */
function playable(kind: 'video' | 'audio', mime: string): boolean {
  if (typeof document === 'undefined') return false;
  const element = document.createElement(kind);
  return typeof element.canPlayType !== 'function' || element.canPlayType(mime) !== '';
}

/** The link to the record (`?record=`, FRONTEND §10.1). */
function recordLink(recordId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set(RECORD_PARAM, recordId);
  url.hash = '';
  return url.toString();
}

/**
 * The file viewer (board S4 "Xem ảnh đính kèm", "Xem PDF và tệp khác"): a
 * modal `<dialog>` on a dark stage in every theme — the browser traps the
 * focus in it and Escape closes it. ← / → (and the side buttons, the strip
 * of thumbnails) go through the files of the cell, + / − / 0 zoom images,
 * Home / End jump to the first / last file. Images show with their name as
 * alternative text; video and audio play in the browser's own players (a
 * download card when the codec is not supported, BACKLOG S4 decision #6);
 * PDFs up to 50 MB show in the viewer with PDF.js, loaded lazily (T407:
 * "Page N / M", PageUp / PageDown, zoom), read through the API — never
 * embedded from storage in the app's origin — with the download card
 * (open in a new tab, download) when they are larger or cannot be shown;
 * anything else is downloaded. Without the right to download
 * (`file_download_fields`) the API refuses the file itself: images still
 * show through their large thumbnail (T407, no download button), other
 * files get a card that says so.
 */
export default function Lightbox({
  files,
  index,
  onIndex,
  onClose,
  recordTitle,
  recordId,
  fieldName,
  canDownload,
  onRemove,
}: LightboxProps) {
  const { t, i18n } = useTranslation('attachment');
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const count = files.length;
  const current = files[Math.min(Math.max(index, 0), Math.max(count - 1, 0))];
  const [zoom, setZoom] = useState<{ fit: number; scale: number } | null>(null);
  const pdf = useRef<PdfViewerHandle>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    element.focus();
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
      if (previous?.isConnected === true) previous.focus({ preventScroll: true });
    };
  }, []);

  // The files changed under the viewer (removed): stay inside the list, close when empty.
  useEffect(() => {
    if (count === 0) onCloseRef.current();
    else if (index >= count) onIndex(count - 1);
  }, [count, index, onIndex]);

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setZoom(null);
      setMenuOpen(false);
      onIndex(((next % count) + count) % count);
    },
    [count, onIndex],
  );

  if (current === undefined) return null;
  const mode: PreviewMode = previewModeOf(current.mime, current.name);
  const isImage = mode === 'image' && (canDownload || largeThumbnailOf(current) !== null);

  const zoomBy = (factor: number) => {
    setZoom((state) =>
      state === null
        ? state
        : { ...state, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor)) },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    const target = event.target;
    // Media controls and the menu keep their own keys.
    if (target instanceof HTMLMediaElement) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (menuOpen) setMenuOpen(false);
      else onClose();
      return;
    }
    if (menuOpen || event.altKey || event.ctrlKey || event.metaKey) return;
    // The PDF viewer, once shown, takes + / − / 0 and PageUp / PageDown.
    const viewer = mode === 'pdf' ? pdf.current : null;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        go(index - 1);
        break;
      case 'ArrowRight':
        go(index + 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(count - 1);
        break;
      case '+':
      case '=':
        if (isImage) zoomBy(ZOOM_STEP);
        else viewer?.zoomIn();
        break;
      case '-':
        if (isImage) zoomBy(1 / ZOOM_STEP);
        else viewer?.zoomOut();
        break;
      case '0':
        if (isImage) setZoom((state) => (state === null ? state : { ...state, scale: state.fit }));
        else viewer?.resetZoom();
        break;
      case 'PageDown':
        if (viewer === null) handled = false;
        else viewer.nextPage();
        break;
      case 'PageUp':
        if (viewer === null) handled = false;
        else viewer.previousPage();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const menuItems: MenuItem[] = [];
  if (recordId !== undefined) {
    menuItems.push({
      key: MENU_LINK,
      icon: <LinkIcon aria-hidden="true" className="size-4" />,
      label: t('viewer.copyRecordLink'),
      onSelect: () => {
        void navigator.clipboard.writeText(recordLink(recordId)).then(
          () => {
            showToast({ variant: 'success', message: t('viewer.linkCopied') });
          },
          () => {
            showToast({ variant: 'error', message: t('viewer.copyFailed') });
          },
        );
      },
    });
  }
  if (onRemove !== undefined) {
    menuItems.push({
      key: MENU_REMOVE,
      icon: <Trash2 aria-hidden="true" className="size-4" />,
      label: t('viewer.removeFromCell'),
      danger: true,
      onSelect: () => {
        onRemove(current);
      },
    });
  }

  const meta = [recordTitle, fieldName, formatBytes(current.size, i18n.language)]
    .filter((part) => part !== '')
    .join(' · ');

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      data-testid="attachment-lightbox"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        // Escape is handled above (the menu closes first); the browser must not close it alone.
        event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      className={cn(
        'fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-viewer p-0 text-body text-viewer-fg',
        'animate-fade-in outline-none backdrop:bg-transparent',
      )}
    >
      <header className="flex min-h-14 shrink-0 items-center gap-3 py-2 pr-3 pl-5 max-sm:flex-wrap max-sm:pl-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="truncate font-medium" data-testid="attachment-lightbox-name">
            {current.name}
          </h2>
          <span className="truncate text-label font-normal text-viewer-muted">{meta}</span>
        </span>
        <span
          className="ml-2 shrink-0 text-label font-normal text-viewer-muted tabular-nums"
          aria-live="polite"
          data-testid="attachment-lightbox-index"
        >
          {t('viewer.position', { index: index + 1, count })}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {isImage && zoom !== null ? (
            <span className="mr-2 flex items-center gap-0.5 max-sm:hidden">
              <button
                type="button"
                aria-label={t('viewer.zoomOut')}
                aria-keyshortcuts="-"
                className={cn(VIEWER_BUTTON, 'size-8')}
                onClick={() => {
                  zoomBy(1 / ZOOM_STEP);
                }}
              >
                <ZoomOut aria-hidden="true" className="size-4" />
              </button>
              <span className="w-11 text-center text-label font-normal tabular-nums">
                {`${String(Math.round(zoom.scale * 100))}%`}
              </span>
              <button
                type="button"
                aria-label={t('viewer.zoomIn')}
                aria-keyshortcuts="+"
                className={cn(VIEWER_BUTTON, 'size-8')}
                onClick={() => {
                  zoomBy(ZOOM_STEP);
                }}
              >
                <ZoomIn aria-hidden="true" className="size-4" />
              </button>
            </span>
          ) : null}
          {canDownload ? (
            <a
              href={current.url}
              download={current.name}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="attachment-lightbox-download"
              className={cn(
                VIEWER_BUTTON,
                'h-8 gap-1.5 border border-viewer-line px-3 max-lg:h-11 max-sm:w-11 max-sm:px-0',
              )}
            >
              <Download aria-hidden="true" className="size-4" />
              <span className="max-sm:sr-only">{t('viewer.download')}</span>
            </a>
          ) : null}
          {menuItems.length > 0 ? (
            <span className="relative">
              <button
                type="button"
                aria-label={t('viewer.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={cn(VIEWER_BUTTON, 'size-8 max-lg:size-11')}
                onClick={() => {
                  setMenuOpen((open) => !open);
                }}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </button>
              {menuOpen ? (
                <ViewerMenu
                  onClose={() => {
                    setMenuOpen(false);
                  }}
                  items={menuItems}
                />
              ) : null}
            </span>
          ) : null}
          <button
            type="button"
            aria-label={t('viewer.close')}
            aria-keyshortcuts="Escape"
            data-testid="attachment-lightbox-close"
            className={cn(VIEWER_BUTTON, 'size-8 max-lg:size-11')}
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-[18px]" />
          </button>
        </span>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <Stage
          key={current.id}
          file={current}
          mode={mode}
          canDownload={canDownload}
          zoom={zoom}
          onFit={(fit) => {
            setZoom({ fit, scale: fit });
          }}
          pdf={pdf}
        />
        {count > 1 ? (
          <>
            <button
              type="button"
              aria-label={t('viewer.previous')}
              aria-keyshortcuts="ArrowLeft"
              data-testid="attachment-lightbox-previous"
              className="absolute top-1/2 left-6 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-viewer-control text-viewer-fg hover:bg-viewer-line focus-visible:outline-2 focus-visible:outline-viewer-fg max-sm:left-2"
              onClick={() => {
                go(index - 1);
              }}
            >
              <ChevronLeft aria-hidden="true" className="size-5" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={t('viewer.next')}
              aria-keyshortcuts="ArrowRight"
              data-testid="attachment-lightbox-next"
              className="absolute top-1/2 right-6 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-viewer-control text-viewer-fg hover:bg-viewer-line focus-visible:outline-2 focus-visible:outline-viewer-fg max-sm:right-2"
              onClick={() => {
                go(index + 1);
              }}
            >
              <ChevronRight aria-hidden="true" className="size-5" strokeWidth={2} />
            </button>
          </>
        ) : null}
      </div>

      <footer className="flex h-22 shrink-0 items-center justify-center">
        {count > 1 ? (
          <ul
            aria-label={t('viewer.strip')}
            className="flex max-w-full items-center gap-2.5 overflow-x-auto px-4 py-2"
          >
            {files.map((file, position) => (
              <li key={file.id} className="shrink-0">
                <button
                  type="button"
                  aria-label={t('viewer.fileAt', {
                    index: position + 1,
                    count,
                    name: file.name,
                  })}
                  aria-current={position === index ? 'true' : undefined}
                  className={cn(
                    'block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-fg',
                    // Full opacity (T421b: type labels keep their contrast); the ring marks the current one.
                    position === index
                      ? 'ring-2 ring-viewer-fg'
                      : 'ring-1 ring-viewer-line hover:ring-viewer-fg',
                  )}
                  onClick={() => {
                    go(position);
                  }}
                >
                  <FileThumb
                    file={file}
                    canView={canDownload}
                    className="size-13 rounded-md"
                    labelSize="md"
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </footer>
    </dialog>
  );
}

interface MenuItem {
  readonly key: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

/** The "⋯" menu of the viewer, inside the dialog (a portal would sit behind the modal). */
function ViewerMenu({ items, onClose }: { items: readonly MenuItem[]; onClose: () => void }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const entries = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      entries[(at + step + entries.length) % entries.length]?.focus();
    } else if (event.key === 'Tab') {
      onClose();
    }
  };
  return (
    <ul
      ref={list}
      role="menu"
      onKeyDown={onKeyDown}
      className="absolute top-full right-0 z-10 mt-1 min-w-52 rounded-lg border border-viewer-card-line bg-viewer-card p-1 shadow-popover"
    >
      {items.map((item) => (
        <li key={item.key} role="none">
          <button
            type="button"
            role="menuitem"
            className={cn(
              'flex min-h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-body outline-none hover:bg-viewer-control focus-visible:bg-viewer-control max-lg:min-h-11',
              item.danger === true ? 'text-viewer-danger' : 'text-viewer-fg',
            )}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

interface StageProps {
  readonly file: CellFile;
  readonly mode: PreviewMode;
  readonly canDownload: boolean;
  readonly zoom: { fit: number; scale: number } | null;
  readonly onFit: (fit: number) => void;
  readonly pdf: RefObject<PdfViewerHandle | null>;
}

/** What the viewer shows of one file. */
function Stage({ file, mode, canDownload, zoom, onFit, pdf }: StageProps) {
  const { t } = useTranslation('attachment');
  const [failed, setFailed] = useState(false);
  // An image uploaded in this tab: its local copy (T421b), before the server has it in the cell.
  const local = mode === 'image' ? localPreviews.get(file.id) : null;
  if (local !== null && !failed) {
    return (
      <ZoomableImage
        file={file}
        src={local}
        zoom={zoom}
        onFit={onFit}
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  if (!canDownload) {
    // T407: the large thumbnail only needs read permission ("view but no download").
    const preview = mode === 'image' ? largeThumbnailOf(file) : null;
    if (preview !== null && !failed) {
      return (
        <ZoomableImage
          file={file}
          src={preview}
          zoom={zoom}
          onFit={onFit}
          onError={() => {
            setFailed(true);
          }}
        />
      );
    }
    return <FileCard file={file} message={t('viewer.noAccess')} />;
  }
  if (mode === 'image' && !failed) {
    return (
      <ZoomableImage
        file={file}
        src={file.url}
        zoom={zoom}
        onFit={onFit}
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  if (mode === 'video' && !failed && playable('video', file.mime)) {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={file.url}
        aria-label={file.name}
        data-testid="attachment-video"
        className="max-h-[calc(100%-2rem)] max-w-[calc(100%-8rem)] rounded-sm max-sm:max-w-full"
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }
  if (mode === 'audio' && !failed && playable('audio', file.mime)) {
    return (
      <FileCard file={file}>
        <audio
          controls
          preload="metadata"
          src={file.url}
          aria-label={file.name}
          data-testid="attachment-audio"
          className="w-full"
          onError={() => {
            setFailed(true);
          }}
        />
      </FileCard>
    );
  }
  if (mode === 'pdf') {
    const onFailed = () => {
      setFailed(true);
    };
    if (file.size <= PDF_OPEN_LIMIT && !failed) {
      return (
        <LoadBoundary onError={onFailed}>
          <Suspense
            fallback={
              <p role="status" className="text-viewer-muted">
                {t('viewer.pdfLoading')}
              </p>
            }
          >
            <PdfViewer ref={pdf} file={file} onFailed={onFailed} />
          </Suspense>
        </LoadBoundary>
      );
    }
    return (
      <FileCard file={file} message={failed ? t('viewer.pdfFailed') : t('viewer.pdf')} download>
        {file.size <= PDF_OPEN_LIMIT ? <OpenPdf file={file} /> : null}
      </FileCard>
    );
  }
  const message =
    (mode === 'video' || mode === 'audio') && (failed || !playable(mode, file.mime))
      ? t('viewer.cannotPlay')
      : mode === 'image'
        ? t('viewer.imageFailed')
        : t('viewer.noPreview');
  return <FileCard file={file} message={message} download />;
}

/** Reports a chunk that failed to load (the PDF viewer offline): the card replaces it. */
class LoadBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A card for a file the viewer does not render (board "Xem PDF và tệp
 * khác"): badge, name, size and type, what to do, the actions.
 */
function FileCard({
  file,
  message,
  download = false,
  children,
}: {
  file: CellFile;
  message?: string;
  download?: boolean;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation('attachment');
  return (
    <div
      className="mx-4 flex w-90 max-w-full flex-col items-center gap-3 rounded-lg border border-viewer-card-line bg-viewer-card p-8 text-center"
      data-testid="attachment-file-card"
    >
      <FileThumb file={file} canView={false} className="size-22 rounded-lg" labelSize="lg" />
      <span className="text-heading break-all">{file.name}</span>
      <span className="text-label font-normal text-viewer-muted">
        {`${formatBytes(file.size, i18n.language)} · ${badgeLabel(file.mime, file.name)}`}
      </span>
      {message === undefined ? null : <p className="leading-normal text-viewer-muted">{message}</p>}
      {children}
      {download ? (
        <a
          href={file.url}
          download={file.name}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-viewer-accent px-3.5 font-medium text-on-viewer-accent hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-fg max-lg:h-11"
        >
          <Download aria-hidden="true" className="size-4" />
          {t('viewer.download')}
        </a>
      ) : null}
    </div>
  );
}

/**
 * Opens a PDF in the browser's own viewer, in a new tab: the file is read
 * (the API checks permissions, then storage) and shown from a `blob:` copy
 * typed `application/pdf`, so storage never renders it in the app's origin
 * (the API serves PDFs as downloads, CONTRACTS §20). The tab is opened at
 * the click (popup blockers), then pointed at the copy.
 */
function OpenPdf({ file }: { file: CellFile }) {
  const { t } = useTranslation('attachment');
  const [busy, setBusy] = useState(false);
  const open = () => {
    const tab = window.open('', '_blank');
    if (tab === null) {
      showToast({ variant: 'error', message: t('viewer.popupBlocked') });
      return;
    }
    setBusy(true);
    fetch(file.url, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = new Blob([await response.blob()], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        tab.location.href = url;
        window.setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 60_000);
      })
      .catch(() => {
        tab.close();
        showToast({ variant: 'error', message: t('viewer.openFailed') });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="attachment-open-pdf"
      onClick={open}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-viewer-line px-3.5 text-viewer-fg hover:bg-viewer-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-fg disabled:opacity-60 max-lg:h-11"
    >
      <ExternalLink aria-hidden="true" className="size-4" />
      {t('viewer.openPdf')}
    </button>
  );
}

interface ZoomableImageProps {
  readonly file: CellFile;
  /** The file itself, or its large thumbnail for users who may not download it. */
  readonly src: string;
  readonly zoom: { fit: number; scale: number } | null;
  readonly onFit: (fit: number) => void;
  readonly onError: () => void;
}

/**
 * The image at "fit" first (never enlarged past its own size), then at the
 * zoom asked; larger than the stage it scrolls, and dragging pans it.
 */
function ZoomableImage({ file, src, zoom, onFit, onError }: ZoomableImageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const measure = useCallback(
    (size: { width: number; height: number }) => {
      const element = stage.current;
      if (element === null || size.width === 0 || size.height === 0) return;
      const fit = Math.min(
        1,
        (element.clientWidth - 32) / size.width,
        (element.clientHeight - 32) / size.height,
      );
      onFit(Math.max(MIN_SCALE, fit));
    },
    [onFit],
  );

  const scale = zoom?.scale ?? null;
  const width = natural === null || scale === null ? undefined : natural.width * scale;
  const height = natural === null || scale === null ? undefined : natural.height * scale;
  const pannable = zoom !== null && scale !== null && scale > zoom.fit + 1e-6;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = stage.current;
    if (!pannable || element === null || event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    element.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    const element = stage.current;
    if (start === null || element === null) return;
    element.scrollLeft = start.left - (event.clientX - start.x);
    element.scrollTop = start.top - (event.clientY - start.y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={stage}
      className={cn(
        'absolute inset-0 overflow-auto',
        pannable && 'cursor-grab active:cursor-grabbing',
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="flex min-h-full min-w-full items-center justify-center p-4">
        <img
          src={src}
          alt={file.name}
          draggable={false}
          data-testid="attachment-lightbox-image"
          onLoad={(event) => {
            const size = {
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            };
            setNatural(size);
            measure(size);
          }}
          onError={onError}
          className={cn('max-w-none rounded-sm select-none', natural === null && 'invisible')}
          style={width === undefined ? undefined : { width, height }}
        />
      </div>
    </div>
  );
}
