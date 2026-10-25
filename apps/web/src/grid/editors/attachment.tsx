import { Suspense, useCallback, useMemo, useSyncExternalStore } from 'react';

import { cellFilesOf } from '../../lib/attachments/value';

import type { CellEditorProps, FileEditorContext } from './types';

/**
 * `attachment` "editor" (T418): the popover of `features/attachment`
 * (file list, uploads with progress, drop zone, preview) over the cell. It
 * writes the cell itself as files finish uploading, are removed or moved
 * (each an undo step), so it never hands a draft back: Escape, Enter or its
 * close button end it. Nothing shows without the popover component (the
 * route did not give one) or the record.
 */
export function AttachmentEditor({
  field,
  config,
  recordId,
  value,
  cellWidth,
  cellHeight,
  context,
  onCancel,
}: CellEditorProps<'attachment'>) {
  const files = context.files;
  if (files?.Editor === undefined || recordId === undefined) return null;
  return (
    <LiveAttachmentEditor
      files={files}
      fieldId={field.id}
      recordId={recordId}
      initial={value}
      render={(current) => {
        const Editor = files.Editor;
        if (Editor === undefined) return null;
        return (
          <Suspense fallback={null}>
            <Editor
              tableId={files.tableId}
              recordId={recordId}
              field={field}
              options={config.options}
              files={current}
              canEdit
              canDownload={files.canDownload(field.id)}
              recordTitle={files.recordTitle(recordId)}
              write={(next) => {
                files.write(recordId, field.id, next);
              }}
              host={files.host(recordId, field.id)}
              cellWidth={cellWidth}
              cellHeight={cellHeight}
              onClose={onCancel}
            />
          </Suspense>
        );
      }}
    />
  );
}

interface LiveProps {
  readonly files: FileEditorContext;
  readonly fieldId: string;
  readonly recordId: string;
  readonly initial: unknown;
  readonly render: (files: ReturnType<typeof cellFilesOf>) => React.ReactNode;
}

/** The files of the cell as the grid holds them now (uploads and writes land while open). */
function LiveAttachmentEditor({ files, fieldId, recordId, initial, render }: LiveProps) {
  const read = useCallback(() => {
    const value = files.read(recordId, fieldId);
    return value === undefined ? initial : value;
  }, [files, recordId, fieldId, initial]);
  const value = useSyncExternalStore(files.subscribe, read);
  const current = useMemo(() => cellFilesOf(value), [value]);
  return <>{render(current)}</>;
}
