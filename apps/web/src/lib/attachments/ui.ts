import type { UploadHost } from './uploads';
import type { CellFile } from './value';
import type { FieldDto } from '@cellhive/contracts';
import type { AttachmentOptions } from '@cellhive/field-types';
import type { ComponentType } from 'react';

/**
 * The attachment screens of `features/attachment` (T418): the cell
 * popover of the grid, the section of the record panel, the lightbox they
 * open. Features do not import each other (FRONTEND §1.2): the route loads
 * them lazily and hands them to the grid page and the record panel, which
 * talk to them through these types only.
 */

/** One attachment cell as the screens see it. */
export interface AttachmentCellProps {
  readonly tableId: string;
  readonly recordId: string;
  readonly field: FieldDto;
  readonly options: AttachmentOptions;
  /** The files of the cell now (optimistic writes included). */
  readonly files: readonly CellFile[];
  /** Upload, remove and reorder (field permission, online, no schema lock). */
  readonly canEdit: boolean;
  /**
   * `file_download_fields` (CONTRACTS §5A): without it the API answers
   * `403` to `GET /files/:id`, so neither the download button nor an image
   * (thumbnails of T407 aside) is shown.
   */
  readonly canDownload: boolean;
  /** Title of the record (the lightbox header). */
  readonly recordTitle: string;
  /** Writes the cell (FRONTEND §4.1: optimistic, `version`, undo step). */
  readonly write: (files: readonly CellFile[]) => void;
  /** Appends a finished upload to the cell (reads the files it holds at that moment). */
  readonly host: UploadHost;
}

export interface AttachmentCellEditorProps extends AttachmentCellProps {
  /** Size of the cell under the popover. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Escape, Enter or the close button: the grid takes the focus back. */
  readonly onClose: () => void;
}

export interface AttachmentSectionProps extends AttachmentCellProps {
  /** The write of this field is on its way (pending) or was refused (message). */
  readonly state?:
    | { readonly status: 'pending' }
    | { readonly status: 'error'; readonly message: string }
    | undefined;
  /** Phones (< 640 px): two columns, "Take photo", sort mode (board "Tệp trên mobile"). */
  readonly narrow: boolean;
}

/** The files of a cell, read-only, with the viewer (share page, T409). */
export interface ReadOnlyFilesProps {
  /** The attachment cell as read (CONTRACTS §2; share links: their file routes). */
  readonly value: unknown;
  readonly fieldName: string;
  /** Title of the record (the viewer header). */
  readonly recordTitle: string;
  /** Downloads offered in the viewer (share links: `meta.download_fields`). */
  readonly canDownload: boolean;
}

/**
 * The viewer alone on the files of a cell, read-only (share grid cells and
 * cards, T419): open while mounted, `onClose` when closed. Downloads only
 * with `canDownload`; no link to the record.
 */
export interface ReadOnlyViewerProps extends ReadOnlyFilesProps {
  /** The file shown first. */
  readonly index?: number | undefined;
  readonly onClose: () => void;
}

export interface AttachmentUi {
  readonly CellEditor: ComponentType<AttachmentCellEditorProps>;
  readonly Section: ComponentType<AttachmentSectionProps>;
}
