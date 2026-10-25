import { Button, cn } from '@cellhive/ui';
import { TriangleAlert, Upload, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { isApplePlatform } from '../../../grid/undo/keys';
import { useIssueText, useLimitsText } from '../messages';
import { useCellFiles } from '../use-cell-files';

import { SortableFiles } from './FileList';
import { carriesFiles, DropZone, IconAction, useFilePicker } from './parts';
import { FileRow, UploadRow } from './rows';

import type { AttachmentCellEditorProps } from '../../../lib/attachments/ui';

const Lightbox = lazy(() => import('./Lightbox'));

/** `max_files` at its default (100, like Lark): the count then reads "3 files", not "3 / 100". */
const NO_VISIBLE_LIMIT = 100;
/** Space between the cell and the popover, and between the popover and the window's edge. */
const GAP = 4;
const MARGIN = 8;

interface Placement {
  readonly above: boolean;
  readonly maxHeight: number | undefined;
  /** Shift to the left so that the popover stays inside the window. */
  readonly left: number;
}

/**
 * The popover under the cell (board: the cell stays visible, outlined), or
 * above it when the window has no room below; shrunk (scrolling) when
 * neither side fits, moved left near the right edge.
 */
function PopoverFrame({
  cellWidth,
  cellHeight,
  children,
}: {
  cellWidth: number;
  cellHeight: number;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>({
    above: false,
    maxHeight: undefined,
    left: 0,
  });
  useLayoutEffect(() => {
    const cell = anchor.current;
    const element = popover.current;
    if (cell === null || element === null) return;
    const update = () => {
      const rect = cell.getBoundingClientRect();
      const height = element.scrollHeight;
      const below = window.innerHeight - rect.top - cellHeight - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      let next: Placement;
      if (height <= below || below >= above) {
        next = { above: false, maxHeight: height <= below ? undefined : below, left: 0 };
      } else {
        next = { above: true, maxHeight: height <= above ? undefined : above, left: 0 };
      }
      const overflow = rect.left + element.offsetWidth - (window.innerWidth - MARGIN);
      const left = overflow > 0 ? -Math.min(overflow, Math.max(0, rect.left - MARGIN)) : 0;
      setPlacement((current) =>
        current.above === next.above &&
        current.maxHeight === next.maxHeight &&
        current.left === left
          ? current
          : { ...next, left },
      );
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [cellHeight]);
  return (
    <div ref={anchor} className="relative" style={{ width: cellWidth, height: cellHeight }}>
      {/* The edited cell, outlined like the board (the grid's own ring is under the overlay). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 border-2 border-accent"
      />
      <div
        ref={popover}
        data-placement={placement.above ? 'above' : 'below'}
        className="absolute flex w-100 max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-line bg-surface text-body text-fg shadow-popover"
        style={{
          left: placement.left,
          ...(placement.above ? { bottom: cellHeight + GAP } : { top: cellHeight + GAP }),
          ...(placement.maxHeight === undefined ? {} : { maxHeight: placement.maxHeight }),
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The popover of an attachment cell (board S4 "Ô tệp đính kèm và tải
 * lên"): the files of the cell (drag to reorder, view, download, remove),
 * the uploads on their way with their progress (cancel) or what went wrong
 * (retry, dismiss), and a drop zone that also opens the file picker; files
 * dropped anywhere on the popover or pasted (Ctrl/⌘+V) are uploaded too.
 * Escape closes it; the grid keeps the selection.
 */
export default function AttachmentCellEditor(props: AttachmentCellEditorProps) {
  const {
    field,
    options,
    files,
    canEdit,
    canDownload,
    recordTitle,
    recordId,
    cellWidth,
    cellHeight,
    onClose,
  } = props;
  const { t, i18n } = useTranslation('attachment');
  const cell = useCellFiles(props);
  const issueText = useIssueText();
  const limitsText = useLimitsText();
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const picker = useFilePicker({ accept: options.accept, onFiles: cell.addFiles });
  const limited = options.max_files < NO_VISIBLE_LIMIT;
  const paste = isApplePlatform() ? '⌘V' : 'Ctrl+V';

  useEffect(() => {
    // Start on the first control (upload, or the first file for readers).
    root.current?.querySelector<HTMLElement>('[data-autofocus], button:not([disabled])')?.focus();
  }, []);

  const onDrop = (event: DragEvent) => {
    if (!canEdit || !carriesFiles(event)) return;
    event.preventDefault();
    setDragOver(false);
    cell.addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <PopoverFrame cellWidth={cellWidth} cellHeight={cellHeight}>
      <div
        ref={root}
        role="dialog"
        aria-labelledby={headingId}
        data-testid="attachment-popover"
        className={cn('flex min-h-0 flex-col', dragOver && 'bg-accent-soft/40')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files);
          if (!canEdit || pasted.length === 0) return;
          event.preventDefault();
          cell.addFiles(pasted);
        }}
        onDragOver={(event) => {
          if (!canEdit || !carriesFiles(event)) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) {
            return;
          }
          setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <div className="flex items-center gap-2 pt-3 pr-3 pb-2 pl-4">
          <h2 id={headingId} className="min-w-0 truncate text-body font-semibold">
            {field.name}
          </h2>
          <span
            className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
            data-testid="attachment-count"
          >
            {limited
              ? t('countOf', { count: files.length, max: options.max_files })
              : t('count', { count: files.length })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {canEdit ? (
              <>
                {picker.element}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cell.full}
                  onClick={picker.open}
                  data-autofocus
                  className="max-lg:h-11"
                >
                  <Upload aria-hidden="true" />
                  {t('upload')}
                </Button>
              </>
            ) : null}
            <IconAction label={t('close')} onClick={onClose} tone="muted">
              <X aria-hidden="true" />
            </IconAction>
          </span>
        </div>

        {files.length === 0 && cell.items.length === 0 && !canEdit ? (
          <p className="px-4 pb-4 text-fg-muted">{t('empty')}</p>
        ) : null}

        {files.length + cell.items.length > 0 ? (
          <div className="max-h-[min(22rem,50dvh)] overflow-y-auto px-2">
            <SortableFiles
              files={files}
              ids={files.map((file) => file.id)}
              layout="list"
              disabled={!canEdit || files.length < 2}
              onMove={cell.move}
            >
              <ul
                aria-label={t('listLabel', { field: field.name })}
                className="flex flex-col gap-0.5"
              >
                {files.map((file, index) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    canEdit={canEdit}
                    canDownload={canDownload}
                    sortable={canEdit && files.length > 1}
                    locale={i18n.language}
                    onPreview={() => {
                      setPreview(index);
                    }}
                    onRemove={() => {
                      cell.remove(file);
                    }}
                  />
                ))}
              </ul>
            </SortableFiles>
            {cell.items.length > 0 ? (
              <ul aria-label={t('uploadsLabel')} className="flex flex-col gap-0.5">
                {cell.items.map((item) => (
                  <UploadRow
                    key={item.key}
                    item={item}
                    message={item.status === 'failed' ? issueText(item, options) : null}
                    locale={i18n.language}
                    onCancel={() => {
                      cell.cancel(item.key);
                    }}
                    onRetry={() => {
                      cell.retry(item.key);
                    }}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {canEdit ? (
          <div className="px-3 pt-2.5 pb-3">
            {cell.full ? (
              <p
                role="status"
                className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-label font-normal text-fg"
                data-testid="attachment-full"
              >
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-warning"
                />
                <span>
                  <strong className="font-semibold">
                    {t('full.title', { count: files.length, max: options.max_files })}
                  </strong>{' '}
                  {t('full.body')}
                </span>
              </p>
            ) : (
              <DropZone
                title={files.length === 0 ? t('drop.empty') : t('drop.title', { paste })}
                helper={limitsText(options, limited ? cell.remaining : null)}
                accept={options.accept}
                onFiles={cell.addFiles}
                className="min-h-18"
              />
            )}
          </div>
        ) : null}
      </div>
      {preview === null ? null : (
        <Suspense fallback={null}>
          <Lightbox
            files={files}
            index={preview}
            onIndex={setPreview}
            onClose={() => {
              setPreview(null);
            }}
            recordTitle={recordTitle}
            recordId={recordId}
            fieldName={field.name}
            canDownload={canDownload}
            onRemove={
              canEdit
                ? (file) => {
                    cell.remove(file);
                  }
                : undefined
            }
          />
        </Suspense>
      )}
    </PopoverFrame>
  );
}
