import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { uploads, type UploadItem, type UploadTarget } from '../../lib/attachments/uploads';
import { moveFile, type CellFile } from '../../lib/attachments/value';
import { showToast } from '../../lib/toast/toast';

import type { AttachmentCellProps } from '../../lib/attachments/ui';

export interface CellFiles {
  readonly target: UploadTarget;
  /** Uploads of the cell (on their way, or stopped with a reason). */
  readonly items: readonly UploadItem[];
  /** Files the cell may still take (`max_files` minus files and uploads on their way). */
  readonly remaining: number;
  readonly full: boolean;
  readonly addFiles: (files: readonly File[]) => void;
  /** Removes a file from the cell; the toast offers to put it back (FRONTEND §6.1). */
  readonly remove: (file: CellFile) => void;
  /** Moves the file at `from` to `to` (order of the cell, CONTRACTS §2). */
  readonly move: (from: number, to: number) => void;
  readonly cancel: (itemKey: string) => void;
  readonly retry: (itemKey: string) => void;
}

/**
 * What the popover and the panel do with a cell's files (T418): add files
 * (checked, then uploaded with progress and appended as they finish),
 * remove one (undo from the toast, or Ctrl/⌘+Z on the grid: every write is
 * an undo step), reorder, cancel or retry an upload.
 */
export function useCellFiles(props: AttachmentCellProps): CellFiles {
  const { t } = useTranslation('attachment');
  const { tableId, recordId, field, options, files, write, host } = props;
  const target = useMemo<UploadTarget>(
    () => ({ tableId, recordId, fieldId: field.id }),
    [tableId, recordId, field.id],
  );
  const read = useCallback(() => uploads.items(target), [target]);
  const items = useSyncExternalStore(uploads.subscribe, read);
  const active = items.filter((item) => item.status !== 'failed').length;
  const remaining = Math.max(0, options.max_files - files.length - active);

  const addFiles = useCallback(
    (picked: readonly File[]) => {
      uploads.add(target, picked, options, files.length, host);
    },
    [target, options, files.length, host],
  );

  const remove = useCallback(
    (file: CellFile) => {
      const before = files;
      write(files.filter((item) => item.id !== file.id));
      showToast({
        variant: 'success',
        message: t('removed', { name: file.name }),
        actions: [
          {
            label: t('undo'),
            primary: true,
            onClick: () => {
              write(before);
            },
          },
        ],
      });
    },
    [files, write, t],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      write(moveFile(files, from, to));
    },
    [files, write],
  );

  return {
    target,
    items,
    remaining,
    full: remaining === 0,
    addFiles,
    remove,
    move,
    cancel: (itemKey) => {
      uploads.cancel(target, itemKey);
    },
    retry: (itemKey) => {
      uploads.retry(target, itemKey);
    },
  };
}
