import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cellFilesOf } from '../../../lib/attachments/value';

import { FileThumb } from './FileThumb';

import type { ReadOnlyFilesProps } from '../../../lib/attachments/ui';

/** The file viewer, loaded when a file is opened (T407/T418). */
const Lightbox = lazy(() => import('./Lightbox'));

/**
 * The files of an attachment cell, read-only (share page, BACKLOG T409): a
 * thumbnail (images, T407 — shown without the right to download) or a type
 * badge with the name; a click opens the viewer, whose download button is
 * there only with `canDownload`. Nothing can be removed or added, and the
 * viewer offers no link to the record.
 */
export default function ReadOnlyFiles({
  value,
  fieldName,
  recordTitle,
  canDownload,
}: ReadOnlyFilesProps) {
  const { t } = useTranslation('attachment');
  const files = cellFilesOf(value);
  const [open, setOpen] = useState<number | null>(null);
  if (files.length === 0) return null;
  return (
    <>
      <ul
        className="flex flex-wrap gap-2"
        aria-label={t('listLabel', { field: fieldName })}
        data-testid="read-only-files"
      >
        {files.map((file, index) => (
          <li key={file.id} className="min-w-0">
            <button
              type="button"
              className="flex max-w-60 min-w-0 items-center gap-2 rounded-md border border-line bg-surface p-1 pr-2 text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label={t('view', { name: file.name })}
              onClick={() => {
                setOpen(index);
              }}
            >
              <FileThumb file={file} canView={canDownload} className="size-9 rounded-sm" />
              <span className="truncate text-label">{file.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {open === null ? null : (
        <Suspense fallback={null}>
          <Lightbox
            files={files}
            index={open}
            onIndex={setOpen}
            onClose={() => {
              setOpen(null);
            }}
            recordTitle={recordTitle}
            fieldName={fieldName}
            canDownload={canDownload}
          />
        </Suspense>
      )}
    </>
  );
}
