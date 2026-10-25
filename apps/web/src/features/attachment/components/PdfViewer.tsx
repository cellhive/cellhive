import { cn } from '@cellhive/ui';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import type { CellFile } from '../../../lib/attachments/value';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/**
 * The PDF.js worker ships in the app's own bundle (an asset of this chunk,
 * same origin: `worker-src 'self'`), never from a CDN.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

/** PDFs larger than this are only downloaded (the viewer reads the file whole into memory). */
export const PDF_VIEW_LIMIT = 50 * 1024 * 1024;
/** Zoom steps of + / −, relative to "fit width". */
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
/** Largest image PDF.js decodes (pixels): a bound against decompression bombs in PDFs. */
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
/** Largest canvas drawn for a page (pixels), whatever the zoom and screen density. */
const MAX_CANVAS_PIXELS = 32 * 1024 * 1024;

/** What the lightbox's keys drive in the viewer. */
export interface PdfViewerHandle {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly nextPage: () => void;
  readonly previousPage: () => void;
}

export interface PdfViewerProps {
  readonly file: CellFile;
  /** The file could not be read or shown: the lightbox shows its download card instead. */
  readonly onFailed: () => void;
  readonly ref?: Ref<PdfViewerHandle>;
}

const BUTTON =
  'inline-flex size-8 items-center justify-center rounded-md text-viewer-fg hover:bg-viewer-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-viewer-fg disabled:opacity-40 max-lg:size-11';

/**
 * PDFs in the lightbox (BACKLOG T407 note, board "Xem PDF và tệp khác"),
 * with PDF.js loaded only when a PDF is opened (this module is a chunk of its
 * own). The file is read through the API (`GET /files/:id` checks
 * permissions, then storage) into memory and handed to PDF.js as bytes: it
 * is never embedded from storage in the app's origin (no `iframe`, no
 * `object`). Pages are drawn one at a time on a canvas — no text or
 * annotation layer, so a PDF's links and scripts never run; PDF.js itself
 * evaluates no code (`isEvalSupported: false`) and uses no WebAssembly
 * (`script-src 'self'` has no `wasm-unsafe-eval`). A page first fits the
 * stage (100%); "Page N / M", previous / next page (PageUp / PageDown), zoom
 * (+ / − / 0) from the lightbox.
 */
export default function PdfViewer({ file, onFailed, ref }: PdfViewerProps) {
  const { t } = useTranslation('attachment');
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onFailedRef.current = onFailed;
  });

  // Read the file through the API, then open it with PDF.js.
  useEffect(() => {
    const controller = new AbortController();
    let loading: PDFDocumentLoadingTask | null = null;
    const run = { cancelled: false };
    const fail = () => {
      if (!run.cancelled) onFailedRef.current();
    };
    if (file.size > PDF_VIEW_LIMIT) {
      fail();
      return;
    }
    void (async () => {
      try {
        const response = await fetch(file.url, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength > PDF_VIEW_LIMIT) throw new Error('too large');
        // `isEvalSupported` is gone from PDF.js 6 (it never evaluates code); kept for older builds.
        const parameters = {
          data,
          isEvalSupported: false,
          useWasm: false,
          enableXfa: false,
          maxImageSize: MAX_IMAGE_PIXELS,
          stopAtErrors: false,
        };
        // Closed while the file was read: PDF.js is never started.
        if (run.cancelled) return;
        const task = getDocument(parameters);
        loading = task;
        const loaded = await task.promise;
        setPdf((current) => (run.cancelled ? current : loaded));
      } catch {
        fail();
      }
    })();
    return () => {
      run.cancelled = true;
      controller.abort();
      // Stops the worker and frees the document.
      if (loading !== null) void loading.destroy();
    };
  }, [file.url, file.size]);

  // The room pages fit in (zoom 1 = the whole page visible).
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const measure = () => {
      setBox({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [pdf]);

  // Draw the current page.
  useEffect(() => {
    const target = canvas.current;
    if (pdf === null || target === null || box.width === 0) return;
    let task: RenderTask | null = null;
    const run = { cancelled: false };
    void (async () => {
      try {
        const current = await pdf.getPage(page);
        if (run.cancelled) return;
        const natural = current.getViewport({ scale: 1 });
        const fit = Math.max(
          0.1,
          Math.min(
            (box.width - 32) / natural.width,
            box.height > 32 ? (box.height - 32) / natural.height : Number.POSITIVE_INFINITY,
          ),
        );
        const cssScale = fit * zoom;
        const density = Math.min(window.devicePixelRatio || 1, 2);
        let scale = cssScale * density;
        const pixels = natural.width * natural.height * scale * scale;
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = current.getViewport({ scale });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${String(Math.floor(natural.width * cssScale))}px`;
        target.style.height = `${String(Math.floor(natural.height * cssScale))}px`;
        task = current.render({ canvas: target, viewport });
        await task.promise;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === 'RenderingCancelledException') return;
        if (!run.cancelled) onFailedRef.current();
      }
    })();
    return () => {
      run.cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, zoom, box]);

  const count = pdf?.numPages ?? 0;
  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;
      setPage(Math.min(Math.max(next, 1), count));
      if (stage.current !== null) stage.current.scrollTop = 0;
    },
    [count],
  );
  const zoomBy = useCallback((factor: number) => {
    setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value * factor)));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => {
        zoomBy(ZOOM_STEP);
      },
      zoomOut: () => {
        zoomBy(1 / ZOOM_STEP);
      },
      resetZoom: () => {
        setZoom(1);
      },
      nextPage: () => {
        goTo(page + 1);
      },
      previousPage: () => {
        goTo(page - 1);
      },
    }),
    [goTo, page, zoomBy],
  );

  return (
    <div className="absolute inset-0 flex flex-col" data-testid="attachment-pdf-viewer">
      {/* Scrolls with the keyboard too once zoomed (axe: scrollable regions are focusable). */}
      <div
        ref={stage}
        role="region"
        aria-label={file.name}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-viewer-fg"
      >
        <div className="flex min-h-full min-w-full items-start justify-center p-4">
          {pdf === null ? (
            <p
              role="status"
              className="self-center text-viewer-muted"
              data-testid="attachment-pdf-loading"
            >
              {t('viewer.pdfLoading')}
            </p>
          ) : null}
          <canvas
            ref={canvas}
            role="img"
            aria-label={t('viewer.pdfPage', { page, count, name: file.name })}
            data-testid="attachment-pdf-page"
            className={cn('rounded-sm bg-white shadow-popover', pdf === null && 'hidden')}
          />
        </div>
      </div>
      {pdf === null ? null : (
        <div className="flex shrink-0 items-center justify-center gap-1 pb-1">
          <button
            type="button"
            aria-label={t('viewer.previousPage')}
            aria-keyshortcuts="PageUp"
            className={BUTTON}
            disabled={page <= 1}
            onClick={() => {
              goTo(page - 1);
            }}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          <span
            className="min-w-24 text-center text-label font-normal tabular-nums"
            aria-live="polite"
            data-testid="attachment-pdf-position"
          >
            {t('viewer.page', { page, count })}
          </span>
          <button
            type="button"
            aria-label={t('viewer.nextPage')}
            aria-keyshortcuts="PageDown"
            className={BUTTON}
            disabled={page >= count}
            onClick={() => {
              goTo(page + 1);
            }}
          >
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
          <span className="mx-2 h-5 w-px bg-viewer-line" aria-hidden="true" />
          <button
            type="button"
            aria-label={t('viewer.zoomOut')}
            aria-keyshortcuts="-"
            className={BUTTON}
            onClick={() => {
              zoomBy(1 / ZOOM_STEP);
            }}
          >
            <ZoomOut aria-hidden="true" className="size-4" />
          </button>
          <span className="w-12 text-center text-label font-normal tabular-nums">
            {`${String(Math.round(zoom * 100))}%`}
          </span>
          <button
            type="button"
            aria-label={t('viewer.zoomIn')}
            aria-keyshortcuts="+"
            className={BUTTON}
            onClick={() => {
              zoomBy(ZOOM_STEP);
            }}
          >
            <ZoomIn aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
