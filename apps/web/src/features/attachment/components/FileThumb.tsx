import { cn } from '@cellhive/ui';
import { File as FileIcon, Image as ImageIcon } from 'lucide-react';

import {
  badgeLabel,
  fileKindOf,
  imageSourceOf,
  kindColorIndex,
} from '../../../lib/attachments/kinds';
import { useRetryingImage } from '../../../lib/attachments/use-retrying-image';

/**
 * Data colors of the badges (`--option-N`, FRONTEND §9.3): literal class
 * names so that Tailwind generates them.
 */
const BADGE_COLORS = [
  'bg-option-0 text-on-option-0',
  'bg-option-1 text-on-option-1',
  'bg-option-2 text-on-option-2',
  'bg-option-3 text-on-option-3',
  'bg-option-4 text-on-option-4',
  'bg-option-5 text-on-option-5',
  'bg-option-6 text-on-option-6',
  'bg-option-7 text-on-option-7',
] as const;

export interface ThumbFile {
  /** Attachment id (a stored file): an image uploaded in this tab shows its local copy. */
  readonly id?: string;
  readonly name: string;
  readonly mime: string;
  /** `url` of a stored file (`/api/v1/files/att_…`), absent for a local file. */
  readonly url?: string;
  readonly thumbnail_url?: string | null;
}

export interface FileThumbProps {
  readonly file: ThumbFile;
  /**
   * Whether the user may download the file (`file_download_fields`): without
   * it an image still shows through its thumbnail (T407), else a placeholder.
   */
  readonly canView: boolean;
  /** A local preview (`blob:` URL of an image being uploaded). */
  readonly preview?: string | null;
  /** Classes of the box: size and radius (e.g. `size-9 rounded-md`). */
  readonly className?: string;
  /** Badge text size: `sm` for boxes under 44 px. */
  readonly labelSize?: 'sm' | 'md' | 'lg';
  /** Alternative text; empty when the name is written next to it (default). */
  readonly alt?: string;
}

/**
 * A file as a square (board S4): a raster image through its thumbnail
 * (T407: read permission is enough), else the file itself when the user may
 * download it (never SVG or HTML, CONTRACTS §20), lazily; else a type badge
 * ("PDF", "XLS") in a data color. An image that fails to load (no thumbnail
 * yet for a user who may not download) shows a picture placeholder and is
 * tried again with backoff (T421b); one uploaded in this tab shows its
 * local copy.
 */
export function FileThumb({
  file,
  canView,
  preview = null,
  className,
  labelSize = 'sm',
  alt = '',
}: FileThumbProps) {
  const kind = fileKindOf(file.mime, file.name);
  // A thumbnail not rendered yet (404) is asked again with backoff (T421b).
  const image = useRetryingImage(preview ?? imageSourceOf(file, canView));
  if (image.src !== null) {
    return (
      <img
        src={image.src}
        alt={alt}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={image.onError}
        className={cn('shrink-0 bg-surface-sunken object-cover', className)}
      />
    );
  }
  if (kind === 'image') {
    return (
      <span
        role={alt === '' ? undefined : 'img'}
        aria-label={alt === '' ? undefined : alt}
        aria-hidden={alt === '' ? true : undefined}
        className={cn(
          'inline-flex shrink-0 items-center justify-center bg-surface-sunken text-fg-muted',
          className,
        )}
      >
        <ImageIcon aria-hidden="true" className="size-1/2 max-h-7 max-w-7" strokeWidth={1.6} />
      </span>
    );
  }
  const label = badgeLabel(file.mime, file.name);
  return (
    <span
      role={alt === '' ? undefined : 'img'}
      aria-label={alt === '' ? undefined : alt}
      aria-hidden={alt === '' ? true : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold tracking-wide',
        BADGE_COLORS[kindColorIndex(kind)],
        labelSize === 'sm' ? 'text-[10px]' : labelSize === 'md' ? 'text-label' : 'text-heading',
        className,
      )}
    >
      {kind === 'other' && label === 'FILE' ? (
        <FileIcon aria-hidden="true" className="size-1/2 max-h-7 max-w-7" strokeWidth={1.6} />
      ) : (
        label
      )}
    </span>
  );
}
