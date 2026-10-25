import { GridCellKind } from '@glideapps/glide-data-grid';

import { badgeLabel, fileKindOf, imageSourceOf, kindColorIndex } from '../../lib/attachments/kinds';
import { cellFilesOf } from '../../lib/attachments/value';

import { colorAt, type CellRenderer } from './common';

import type { AttachmentTile, AttachmentsCell } from '../customCells/attachments';

/**
 * `attachment` (CONTRACTS §2): `[{ id, name, size, mime, url, thumbnail_url }]`.
 * Raster images become thumbnails through `thumbnail_url` (T407: read
 * permission is enough, so users without `file_download_fields` see them
 * too), else the file itself through `url` for users who may download it
 * (never SVG or HTML, CONTRACTS §20); other files a type badge. The copied /
 * announced text is the file names, as `cell_format=text`.
 */
export const renderAttachment: CellRenderer<'attachment'> = (value, _config, ctx, field) => {
  const files = cellFilesOf(value);
  const canView = ctx.files?.canView(field.field.id) === true;
  const tiles: AttachmentTile[] = files.map((file) => {
    const source = imageSourceOf(file, canView);
    if (source !== null) return { type: 'image', url: source, name: file.name };
    const kind = fileKindOf(file.mime, file.name);
    return {
      type: 'badge',
      label: badgeLabel(file.mime, file.name),
      color: colorAt(kindColorIndex(kind), ctx.palette.options),
      name: file.name,
      picture: kind === 'image',
    };
  });
  const cell: AttachmentsCell = {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: files.map((file) => file.name).join(', '),
    data: {
      kind: 'ob-attachments',
      tiles,
      colors: {
        sunken: ctx.palette.sunken,
        muted: ctx.palette.textMuted,
        text: ctx.palette.text,
        accent: ctx.palette.accent,
      },
      hint: ctx.labels.uploadHint ?? null,
    },
  };
  return cell;
};
