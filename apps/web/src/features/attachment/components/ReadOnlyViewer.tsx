import { useState } from 'react';

import { cellFilesOf } from '../../../lib/attachments/value';

import Lightbox from './Lightbox';

import type { ReadOnlyViewerProps } from '../../../lib/attachments/ui';

/**
 * The viewer on the files of a cell of the share page (BACKLOG T419): what
 * a click on a thumbnail of the record detail opens (T409), reachable from
 * the grid cell and the card itself, so files can be seen even when the
 * link hides the record detail. Downloads only with `canDownload`
 * (`meta.download_fields`); no menu to copy a link to the record.
 */
export default function ReadOnlyViewer({
  value,
  fieldName,
  recordTitle,
  canDownload,
  index = 0,
  onClose,
}: ReadOnlyViewerProps) {
  const files = cellFilesOf(value);
  const [current, setCurrent] = useState(Math.min(Math.max(index, 0), files.length - 1));
  if (files.length === 0) return null;
  return (
    <Lightbox
      files={files}
      index={current}
      onIndex={setCurrent}
      onClose={onClose}
      recordTitle={recordTitle}
      fieldName={fieldName}
      canDownload={canDownload}
    />
  );
}
