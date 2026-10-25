import { mimeAccepted } from '@cellhive/field-types';
import {
  Button,
  buttonVariants,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Download,
  GripVertical,
  MoreHorizontal,
  Paperclip,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApplePlatform } from '../../../grid/undo/keys';
import { formatBytes, formatProgress } from '../../../lib/attachments/format';
import { isPreviewImage } from '../../../lib/attachments/kinds';
import { useIssueText, useLimitsText } from '../messages';
import { useCellFiles } from '../use-cell-files';

import { SortableFiles } from './FileList';
import { FileThumb } from './FileThumb';
import { carriesFiles, DropZone, IconAction, ProgressBar, useFilePicker } from './parts';
import { DownloadLink, UploadRow } from './rows';

import type { AttachmentSectionProps } from '../../../lib/attachments/ui';
import type { UploadItem } from '../../../lib/attachments/uploads';
import type { CellFile } from '../../../lib/attachments/value';

const Lightbox = lazy(() => import('./Lightbox'));

const NO_VISIBLE_LIMIT = 100;

interface TileActions {
  readonly canEdit: boolean;
  readonly canDownload: boolean;
  readonly sortable: boolean;
  readonly onPreview: () => void;
  readonly onRemove: () => void;
}

/**
 * An image of the panel's grid (board S4 "Tệp trong chi tiết record"):
 * thumbnail, name, size; on hover or focus a drag handle, download and
 * delete. The thumbnail opens the viewer.
 */
function ImageTile({
  file,
  locale,
  canEdit,
  canDownload,
  sortable,
  onPreview,
  onRemove,
}: TileActions & { file: CellFile; locale: string }) {
  const { t } = useTranslation('attachment');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
    disabled: !sortable,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="attachment-tile"
      data-file-id={file.id}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border border-line bg-surface',
        isDragging && 'z-10 -rotate-2 border-accent shadow-popover',
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        aria-label={t('view', { name: file.name })}
        className="block h-24 w-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <FileThumb file={file} canView={canDownload} className="h-24 w-full" labelSize="lg" />
      </button>
      <span className="flex min-h-14 flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate text-label" title={file.name}>
          {file.name}
        </span>
        <span className="text-label font-normal text-fg-muted tabular-nums">
          {formatBytes(file.size, locale)}
        </span>
      </span>
      {sortable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('reorder', { name: file.name })}
          className={cn(
            'absolute top-1.5 left-1.5 flex size-7 cursor-grab touch-none items-center justify-center rounded-md bg-surface text-fg-muted shadow-popover active:cursor-grabbing',
            // Touch screens have no hover: the actions stay shown there (44 px).
            'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 max-lg:size-11 max-lg:opacity-100',
          )}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      <span
        className={cn(
          'absolute top-1.5 right-1.5 flex gap-1',
          'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100',
        )}
      >
        {canDownload ? (
          <DownloadLink
            file={file}
            label={t('download', { name: file.name })}
            className={cn(
              buttonVariants({ variant: 'secondary', size: null }),
              'size-7 border-0 shadow-popover max-lg:size-11 [&_svg]:size-3.5',
            )}
          >
            <Download aria-hidden="true" />
          </DownloadLink>
        ) : null}
        {canEdit ? (
          <IconAction
            label={t('delete', { name: file.name })}
            onClick={onRemove}
            tone="danger"
            className="bg-surface shadow-popover hover:bg-surface-sunken"
            data-testid="attachment-remove"
          >
            <Trash2 aria-hidden="true" />
          </IconAction>
        ) : null}
      </span>
    </li>
  );
}

/** An image being uploaded (or refused) in the grid of the panel. */
function UploadTile({
  item,
  message,
  locale,
  onCancel,
  onRetry,
}: {
  item: UploadItem;
  message: string | null;
  locale: string;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('attachment');
  const failed = item.status === 'failed';
  return (
    <li
      data-testid="attachment-upload"
      data-status={item.status}
      className={cn(
        'relative flex flex-col overflow-hidden rounded-lg border bg-surface',
        failed ? 'border-danger/50' : 'border-line',
      )}
    >
      <FileThumb
        file={item}
        canView={false}
        preview={item.preview}
        className={cn('h-24 w-full', !failed && 'opacity-60')}
        labelSize="lg"
      />
      <span className="flex min-h-14 flex-col gap-1 px-2.5 py-2">
        <span className="truncate text-label" title={item.name}>
          {item.name}
        </span>
        {failed ? (
          <span role="alert" className="text-label leading-snug font-normal text-danger">
            {message}
          </span>
        ) : (
          <>
            <ProgressBar value={item.size === 0 ? 1 : item.loaded / item.size} />
            <span className="text-label font-normal text-fg-muted tabular-nums">
              {item.status === 'queued'
                ? t('queued')
                : item.status === 'completing'
                  ? t('checking')
                  : formatProgress(item.loaded, item.size, locale)}
            </span>
          </>
        )}
        {failed && item.retryable ? (
          <Button variant="ghost" size="sm" className="self-start px-0" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </span>
      <IconAction
        label={failed ? t('dismiss', { name: item.name }) : t('cancel', { name: item.name })}
        onClick={onCancel}
        tone="muted"
        className="absolute top-1.5 right-1.5 bg-surface shadow-popover"
        data-testid={failed ? 'attachment-dismiss' : 'attachment-cancel'}
      >
        <X aria-hidden="true" />
      </IconAction>
    </li>
  );
}

/** A document of the panel (board: 48 px rows; phones 56 px with a "⋯" menu). */
function DocumentRow({
  file,
  locale,
  narrow,
  canEdit,
  canDownload,
  sortable,
  onPreview,
  onRemove,
}: TileActions & { file: CellFile; locale: string; narrow: boolean }) {
  const { t } = useTranslation('attachment');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id,
    disabled: !sortable,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="attachment-row"
      data-file-id={file.id}
      className={cn(
        'flex items-center gap-2.5 border-t border-line bg-surface pr-2 pl-1',
        narrow ? 'min-h-14' : 'min-h-12',
        isDragging && 'relative z-10 shadow-popover',
      )}
    >
      {sortable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('reorder', { name: file.name })}
          className="inline-flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-subtle hover:text-fg active:cursor-grabbing max-lg:h-11 max-lg:w-8"
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      ) : narrow ? null : (
        <span aria-hidden="true" className="w-5 shrink-0" />
      )}
      <FileThumb
        file={file}
        canView={canDownload}
        className={cn('rounded-md', narrow ? 'size-9' : 'size-8')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate', narrow && 'text-[15px]')} title={file.name}>
          {file.name}
        </span>
        <span className="text-label font-normal text-fg-muted tabular-nums">
          {formatBytes(file.size, locale)}
        </span>
      </span>
      {narrow ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('actionsFor', { name: file.name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onPreview}>
              <ZoomIn aria-hidden="true" />
              {t('viewShort')}
            </DropdownMenuItem>
            {canDownload ? (
              <DropdownMenuItem asChild>
                <a href={file.url} download={file.name} target="_blank" rel="noopener noreferrer">
                  <Download aria-hidden="true" />
                  {t('viewer.download')}
                </a>
              </DropdownMenuItem>
            ) : null}
            {canEdit ? (
              <DropdownMenuItem onSelect={onRemove} className="text-danger">
                <Trash2 aria-hidden="true" />
                {t('deleteShort')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="flex shrink-0 items-center gap-0.5">
          <IconAction
            label={t('view', { name: file.name })}
            onClick={onPreview}
            data-testid="attachment-view"
          >
            <ZoomIn aria-hidden="true" />
          </IconAction>
          {canDownload ? (
            <DownloadLink
              file={file}
              label={t('download', { name: file.name })}
              className={cn(
                buttonVariants({ variant: 'ghost', size: null }),
                'size-7 rounded-md max-lg:size-11 [&_svg]:size-3.5',
              )}
            >
              <Download aria-hidden="true" />
            </DownloadLink>
          ) : null}
          {canEdit ? (
            <IconAction
              label={t('delete', { name: file.name })}
              onClick={onRemove}
              tone="muted"
              data-testid="attachment-remove"
            >
              <Trash2 aria-hidden="true" />
            </IconAction>
          ) : null}
        </span>
      )}
    </li>
  );
}

/** Up / down buttons of the phone's sort mode (dragging would fight the scroll). */
function MoveButtons({
  name,
  index,
  count,
  onMove,
}: {
  name: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
}) {
  const { t } = useTranslation('attachment');
  return (
    <span className="flex shrink-0 gap-1">
      <Button
        variant="secondary"
        size="icon"
        aria-label={t('moveUp', { name })}
        disabled={index === 0}
        onClick={() => {
          onMove(index - 1);
        }}
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        variant="secondary"
        size="icon"
        aria-label={t('moveDown', { name })}
        disabled={index === count - 1}
        onClick={() => {
          onMove(index + 1);
        }}
      >
        <ArrowDown aria-hidden="true" />
      </Button>
    </span>
  );
}

/**
 * An attachment field in the record panel (board S4 "Tệp trong chi tiết
 * record", "Tệp trên mobile"): a heading with the count and "Upload";
 * images as a grid of cards (4 columns on the side panel, 2 on phones),
 * other files as a list; uploads with their progress where their file
 * will be; a drop zone (files dropped anywhere on the section, or pasted
 * while it has the focus, are uploaded too). Phones get "Take photo"
 * (camera input) and "Choose files", and a sort mode with up / down
 * buttons instead of dragging inside the scrolling panel.
 */
export default function AttachmentSection(props: AttachmentSectionProps) {
  const { field, options, files, canEdit, canDownload, recordTitle, recordId, narrow, state } =
    props;
  const { t, i18n } = useTranslation('attachment');
  const cell = useCellFiles(props);
  const issueText = useIssueText();
  const limitsText = useLimitsText();
  const headingId = useId();
  const section = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [sorting, setSorting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const picker = useFilePicker({ accept: options.accept, onFiles: cell.addFiles });
  const camera = useFilePicker({ accept: options.accept, onFiles: cell.addFiles, capture: true });
  const limited = options.max_files < NO_VISIBLE_LIMIT;
  const locale = i18n.language;
  const paste = isApplePlatform() ? '⌘V' : 'Ctrl+V';

  const images = files.filter((file) => isPreviewImage(file.mime));
  const documents = files.filter((file) => !isPreviewImage(file.mime));
  const imageUploads = cell.items.filter((item) => isPreviewImage(item.mime));
  const otherUploads = cell.items.filter((item) => !isPreviewImage(item.mime));
  const sortable = canEdit && files.length > 1 && (!narrow || sorting);
  const acceptsImages = mimeAccepted('image/jpeg', options.accept);
  const indexOf = (file: CellFile) => files.indexOf(file);

  const onDrop = (event: DragEvent) => {
    if (!canEdit || !carriesFiles(event)) return;
    event.preventDefault();
    setDragOver(false);
    cell.addFiles(Array.from(event.dataTransfer.files));
  };

  const upload = canEdit ? (
    <Button
      variant="secondary"
      size="sm"
      disabled={cell.full}
      onClick={picker.open}
      className="max-lg:h-11"
      aria-describedby={headingId}
    >
      <Upload aria-hidden="true" />
      {t('upload')}
    </Button>
  ) : null;

  const tileProps = (file: CellFile) => ({
    canEdit,
    canDownload,
    sortable: sortable && !narrow,
    onPreview: () => {
      setPreview(indexOf(file));
    },
    onRemove: () => {
      cell.remove(file);
    },
  });

  return (
    <section
      ref={section}
      aria-labelledby={headingId}
      data-testid="attachment-section"
      data-field-id={field.id}
      className={cn(
        'flex flex-col gap-2.5 rounded-lg py-2',
        dragOver && 'bg-accent-soft/50 outline-2 outline-offset-4 outline-accent outline-dashed',
        state?.status === 'pending' && 'opacity-80',
      )}
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
        if (event.relatedTarget instanceof Node && section.current?.contains(event.relatedTarget)) {
          return;
        }
        setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {picker.element}
      {camera.element}
      <div className="flex min-h-7 items-center gap-2">
        {narrow ? null : (
          <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
        )}
        <h3
          id={headingId}
          className={cn(
            'min-w-0 truncate',
            narrow ? 'text-label font-normal text-fg-muted' : 'text-body font-semibold',
          )}
        >
          {field.name}
        </h3>
        <span
          className="shrink-0 text-label font-normal text-fg-muted tabular-nums"
          data-testid="attachment-count"
        >
          {limited
            ? narrow
              ? `${String(files.length)} / ${String(options.max_files)}`
              : t('countOf', { count: files.length, max: options.max_files })
            : t('count', { count: files.length })}
        </span>
        <span className="ml-auto flex items-center">
          {narrow ? (
            canEdit && files.length > 1 ? (
              <Button
                variant="link"
                className="min-h-11"
                aria-pressed={sorting}
                onClick={() => {
                  setSorting((on) => !on);
                }}
              >
                {sorting ? t('sortDone') : t('sort')}
              </Button>
            ) : null
          ) : (
            upload
          )}
        </span>
      </div>

      {state?.status === 'error' ? (
        <p role="alert" className="flex items-center gap-1 text-label font-normal text-danger">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {state.message}
        </p>
      ) : null}

      {images.length + imageUploads.length > 0 ? (
        narrow && sorting ? (
          <ol aria-label={t('imagesLabel', { field: field.name })} className="flex flex-col gap-2">
            {images.map((file, position) => (
              <li
                key={file.id}
                className="flex items-center gap-3 rounded-lg border border-line p-2"
                data-testid="attachment-tile"
              >
                <FileThumb file={file} canView={canDownload} className="size-14 rounded-md" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <MoveButtons
                  name={file.name}
                  index={position}
                  count={images.length}
                  onMove={(to) => {
                    const target = images[to];
                    if (target !== undefined) cell.move(indexOf(file), indexOf(target));
                  }}
                />
              </li>
            ))}
          </ol>
        ) : (
          <SortableFiles
            files={files}
            ids={images.map((file) => file.id)}
            layout="grid"
            disabled={!sortable || narrow}
            onMove={cell.move}
          >
            <ol
              aria-label={t('imagesLabel', { field: field.name })}
              className={cn(
                'grid gap-2.5',
                narrow ? 'grid-cols-2 gap-2' : 'grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]',
              )}
            >
              {images.map((file) => (
                <ImageTile key={file.id} file={file} locale={locale} {...tileProps(file)} />
              ))}
              {imageUploads.map((item) => (
                <UploadTile
                  key={item.key}
                  item={item}
                  message={item.status === 'failed' ? issueText(item, options) : null}
                  locale={locale}
                  onCancel={() => {
                    cell.cancel(item.key);
                  }}
                  onRetry={() => {
                    cell.retry(item.key);
                  }}
                />
              ))}
            </ol>
          </SortableFiles>
        )
      ) : null}

      {canEdit && narrow ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            {acceptsImages ? (
              <Button
                variant="secondary"
                className="h-11"
                disabled={cell.full}
                onClick={camera.open}
              >
                <Camera aria-hidden="true" />
                {t('takePhoto')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              className={cn('h-11', !acceptsImages && 'col-span-2')}
              disabled={cell.full}
              onClick={picker.open}
            >
              <Upload aria-hidden="true" />
              {t('chooseFiles')}
            </Button>
          </div>
          <span className="text-label font-normal text-fg-muted">{limitsText(options, null)}</span>
        </div>
      ) : null}

      {canEdit && !narrow && cell.full ? (
        <p
          role="status"
          className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-label font-normal text-fg"
          data-testid="attachment-full"
        >
          <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            <strong className="font-semibold">
              {t('full.title', { count: files.length, max: options.max_files })}
            </strong>{' '}
            {t('full.body')}
          </span>
        </p>
      ) : null}
      {canEdit && !narrow && !cell.full && (images.length > 0 || files.length === 0) ? (
        <DropZone
          title={
            files.length === 0
              ? t('drop.empty')
              : t(acceptsImages && options.accept !== null ? 'drop.titleImages' : 'drop.title', {
                  paste,
                })
          }
          helper={limitsText(options, limited ? cell.remaining : null)}
          accept={options.accept}
          onFiles={cell.addFiles}
          className="min-h-16"
        />
      ) : null}
      {!canEdit && files.length === 0 ? <p className="text-fg-subtle">{t('empty')}</p> : null}

      {documents.length + otherUploads.length > 0 ? (
        narrow && sorting ? (
          <ol aria-label={t('documentsLabel', { field: field.name })} className="flex flex-col">
            {documents.map((file, position) => (
              <li
                key={file.id}
                className="flex min-h-14 items-center gap-3 border-t border-line"
                data-testid="attachment-row"
              >
                <FileThumb file={file} canView={canDownload} className="size-9 rounded-md" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <MoveButtons
                  name={file.name}
                  index={position}
                  count={documents.length}
                  onMove={(to) => {
                    const target = documents[to];
                    if (target !== undefined) cell.move(indexOf(file), indexOf(target));
                  }}
                />
              </li>
            ))}
          </ol>
        ) : (
          <SortableFiles
            files={files}
            ids={documents.map((file) => file.id)}
            layout="list"
            disabled={!sortable || narrow}
            onMove={cell.move}
          >
            <ol
              aria-label={t('documentsLabel', { field: field.name })}
              className="flex flex-col border-b border-line"
            >
              {documents.map((file) => (
                <DocumentRow
                  key={file.id}
                  file={file}
                  locale={locale}
                  narrow={narrow}
                  {...tileProps(file)}
                />
              ))}
              {otherUploads.map((item) => (
                <UploadRow
                  key={item.key}
                  item={item}
                  message={item.status === 'failed' ? issueText(item, options) : null}
                  locale={locale}
                  onCancel={() => {
                    cell.cancel(item.key);
                  }}
                  onRetry={() => {
                    cell.retry(item.key);
                  }}
                />
              ))}
            </ol>
          </SortableFiles>
        )
      ) : null}

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
    </section>
  );
}
