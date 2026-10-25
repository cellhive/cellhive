import { buttonVariants, cn, Tooltip } from '@cellhive/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Download, GripVertical, TriangleAlert, X, ZoomIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatBytes, formatProgress } from '../../../lib/attachments/format';

import { FileThumb } from './FileThumb';
import { IconAction, ProgressBar } from './parts';

import type { UploadItem } from '../../../lib/attachments/uploads';
import type { CellFile } from '../../../lib/attachments/value';

/**
 * Download of a file (`GET /files/:id`: permission check, then a URL valid
 * 60 s, CONTRACTS §20). `download` keeps inline types (images, video) from
 * replacing the page when storage is the app's origin (`local` driver).
 */
export function DownloadLink({
  file,
  className,
  children,
  label,
  bare = false,
}: {
  file: CellFile;
  className?: string;
  children: React.ReactNode;
  label?: string;
  bare?: boolean;
}) {
  const link = (
    <a
      href={file.url}
      download={file.name}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      data-testid="attachment-download"
      onClick={(event) => {
        event.stopPropagation();
      }}
      className={className}
    >
      {children}
    </a>
  );
  return bare || label === undefined ? link : <Tooltip content={label}>{link}</Tooltip>;
}

export interface FileRowProps {
  readonly file: CellFile;
  readonly canEdit: boolean;
  readonly canDownload: boolean;
  /** Reordering is on (at least two files, the user may edit). */
  readonly sortable: boolean;
  readonly onPreview: () => void;
  readonly onRemove: () => void;
  readonly locale: string;
}

/**
 * A file of the cell in the popover list (board S4 "Ô tệp đính kèm"):
 * drag handle, thumbnail, name and size, view / download / remove.
 */
export function FileRow({
  file,
  canEdit,
  canDownload,
  sortable,
  onPreview,
  onRemove,
  locale,
}: FileRowProps) {
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
        'flex min-h-12 items-center gap-2 rounded-md bg-surface py-1.5 pr-2 pl-1 hover:bg-surface-sunken',
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
      ) : (
        <span aria-hidden="true" className="w-5 shrink-0" />
      )}
      <button
        type="button"
        onClick={onPreview}
        aria-label={t('view', { name: file.name })}
        className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        tabIndex={-1}
      >
        <FileThumb file={file} canView={canDownload} className="size-9 rounded-md" />
      </button>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate" title={file.name}>
          {file.name}
        </span>
        <span className="text-label font-normal text-fg-muted tabular-nums">
          {formatBytes(file.size, locale)}
        </span>
      </span>
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
            label={t('remove', { name: file.name })}
            onClick={onRemove}
            tone="muted"
            data-testid="attachment-remove"
          >
            <X aria-hidden="true" />
          </IconAction>
        ) : null}
      </span>
    </li>
  );
}

export interface UploadRowProps {
  readonly item: UploadItem;
  readonly message: string | null;
  readonly locale: string;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}

/**
 * An upload in the popover list: progress while it travels (cancel), or
 * what went wrong on a soft red row (retry when it may work, dismiss).
 */
export function UploadRow({ item, message, locale, onCancel, onRetry }: UploadRowProps) {
  const { t } = useTranslation('attachment');
  const failed = item.status === 'failed';
  const progress = item.size === 0 ? 1 : item.loaded / item.size;
  return (
    <li
      data-testid="attachment-upload"
      data-status={item.status}
      className={cn(
        'flex min-h-12 items-center gap-2 rounded-md py-1.5 pr-2 pl-1',
        failed ? 'bg-danger/8' : 'bg-surface',
      )}
    >
      <span aria-hidden="true" className="w-5 shrink-0" />
      <FileThumb
        file={item}
        canView={false}
        preview={item.preview}
        className={cn('size-9 rounded-md', !failed && 'opacity-70')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate" title={item.name}>
          {item.name}
        </span>
        {failed ? (
          <span
            role="alert"
            className="flex items-start gap-1 text-label font-normal text-danger"
            data-testid="attachment-upload-error"
          >
            <TriangleAlert aria-hidden="true" className="mt-px size-3 shrink-0" />
            <span>{message}</span>
          </span>
        ) : (
          <span className="flex items-center gap-2 text-label font-normal text-fg-muted">
            <ProgressBar value={progress} className="w-30 shrink-0" />
            <span className="tabular-nums" data-testid="attachment-upload-progress">
              {item.status === 'queued'
                ? t('queued')
                : item.status === 'completing'
                  ? t('checking')
                  : formatProgress(item.loaded, item.size, locale)}
            </span>
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {failed && item.retryable ? (
          <button
            type="button"
            onClick={onRetry}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-lg:h-11')}
          >
            {t('retry')}
          </button>
        ) : null}
        <IconAction
          label={failed ? t('dismiss', { name: item.name }) : t('cancel', { name: item.name })}
          onClick={onCancel}
          tone="muted"
          data-testid={failed ? 'attachment-dismiss' : 'attachment-cancel'}
        >
          <X aria-hidden="true" />
        </IconAction>
      </span>
    </li>
  );
}
