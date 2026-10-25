import { withAlphaHex, type GridPalette } from './theme';

import type { GridField } from './types';
import type { SizedGridColumn, SpriteMap, Theme } from '@glideapps/glide-data-grid';

/**
 * Header icons of the field types (T322a): the stroke icons of the rest of
 * the app (lucide, 24 px grid, 2 px stroke, round caps — drawn at 16 px like
 * `size-4` icons, same glyph per type as the field dialog), instead of
 * glide's filled squares. Path data copied from lucide (ISC license, already
 * a dependency through `lucide-react`); the canvas needs SVG strings.
 */
const GLYPHS = {
  text: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  url:
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  email:
    '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  phone:
    '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>',
  barcode:
    '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/>' +
    '<path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 7v10"/><path d="M12 7v10"/><path d="M17 7v10"/>',
  number:
    '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/>' +
    '<line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  select: '<circle cx="12" cy="12" r="10"/><path d="m16 10-4 4-4-4"/>',
  multiSelect:
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
  datetime:
    '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
  checkbox: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m16 9-5.5 5.5L8 12"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  createdBy:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
    '<line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  updatedBy:
    '<path d="M11.5 15H7a4 4 0 0 0-4 4v2"/>' +
    '<path d="M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>' +
    '<circle cx="10" cy="7" r="4"/>',
  createdAt:
    '<path d="M16 18h6"/><path d="M16 2v3"/><path d="M19 15v6"/>' +
    '<path d="M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"/><path d="M3 9h18"/><path d="M8 2v3"/>',
  updatedAt:
    '<path d="M16 14v2.2l1.6 1"/><path d="M16 2v3"/>' +
    '<path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"/><path d="M3 9h5.859"/>' +
    '<path d="M8 2v3"/><circle cx="16" cy="16" r="6"/>',
  autoNumber:
    '<path d="M11 5h10"/><path d="M11 12h10"/><path d="M11 19h10"/><path d="M4 4h1v5"/><path d="M4 9h2"/>' +
    '<path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
  lookup:
    '<path d="M21 5H3"/><path d="M10 12H3"/><path d="M10 19H3"/><circle cx="17" cy="15" r="3"/><path d="m21 19-1.9-1.9"/>',
  formula:
    '<path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2"/>',
  attachment:
    '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  /** Button fields (T525): lucide `mouse-pointer-click`, as in the field dialog. */
  button:
    '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/>' +
    '<path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
  /** (T554) A date field with a reminder: lucide `alarm-clock`. */
  alarm:
    '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/>' +
    '<path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/>',
  /** (T554) Its reminder is not sent (recipient field gone): lucide `alarm-clock-off`. */
  alarmOff:
    '<path d="M6.87 6.87a8 8 0 1 0 11.26 11.26"/><path d="M19.9 14.25a8 8 0 0 0-9.15-9.15"/>' +
    '<path d="m22 6-3-3"/><path d="M6.26 18.67 4 21"/><path d="m2 2 20 20"/><path d="M4 4 2 6"/>',
  /** A field being converted (T414): its structure and values are locked. */
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
} as const;

export type HeaderGlyph = keyof typeof GLYPHS;

/** Sprite id of a glyph (glide looks header icons up by name). */
export function headerIcon(glyph: HeaderGlyph): string {
  return `ob-${glyph}`;
}

/**
 * The header sprites. Glide passes the icon colors of the theme: in a plain
 * header `bgColor` is `bgIconHeader` (the icon color, `text-subtle`), in a
 * selected one white on the accent — the stroke takes it.
 */
export const HEADER_ICONS: SpriteMap = Object.fromEntries(
  (Object.keys(GLYPHS) as HeaderGlyph[]).map((glyph) => [
    headerIcon(glyph),
    ({ bgColor }: { bgColor: string }) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" ` +
      `stroke="${bgColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `${GLYPHS[glyph]}</svg>`,
  ]),
);

/** Header icon of a field: its type, refined by the style (FRONTEND §1.3 header). */
export function headerIconOf(field: GridField): string {
  return headerIcon(headerGlyphOf(field));
}

function headerGlyphOf(field: GridField): HeaderGlyph {
  const config = field.config;
  if (config === null) {
    switch (field.field.type) {
      case 'link':
      case 'parent':
        return 'link';
      case 'lookup':
        return 'lookup';
      case 'formula':
        return 'formula';
      case 'attachment':
        return 'attachment';
      case 'button':
        return 'button';
      default:
        return 'text';
    }
  }
  switch (config.type) {
    case 'text':
      switch (config.options.style.type) {
        case 'url':
          return 'url';
        case 'email':
          return 'email';
        case 'phone':
          return 'phone';
        case 'barcode':
          return 'barcode';
        default:
          return 'text';
      }
    case 'number':
      return 'number';
    case 'select':
      return config.options.multiple ? 'multiSelect' : 'select';
    case 'datetime':
      // (T554) A reminding date field shows an alarm clock (its hint says what it does).
      return config.options.reminder == null ? 'datetime' : 'alarm';
    case 'checkbox':
      return 'checkbox';
    case 'user':
      return 'user';
    case 'created_by':
      return 'createdBy';
    case 'updated_by':
      return 'updatedBy';
    case 'created_at':
      return 'createdAt';
    case 'updated_at':
      return 'updatedAt';
    case 'auto_number':
      return 'autoNumber';
    case 'attachment':
      return 'attachment';
  }
}

/** Default column width by type until widths are saved per view (T207/S3). */
export function defaultColumnWidth(field: GridField): number {
  if (field.field.is_primary) return 240;
  if (field.button !== undefined) return 160;
  switch (field.config?.type) {
    case 'checkbox':
      return 96;
    case 'number':
    case 'auto_number':
      return 140;
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 160;
    case 'select':
    case 'user':
    case 'created_by':
    case 'updated_by':
    case 'attachment':
      return 180;
    default:
      return 200;
  }
}

/** How the column of a field being converted looks (T414, board "Đổi kiểu, đang chạy nền"). */
export interface ConvertingColumnTheme {
  /** Header of the column: accent tint, accent text, a lock for an icon. */
  readonly header: Partial<Theme>;
  /** Cells while their values are locked: muted, like disabled controls. */
  readonly cells: Partial<Theme>;
}

const convertingThemes = new WeakMap<GridPalette, ConvertingColumnTheme>();

/** The converting look for a palette (one object per palette: glide compares by reference). */
export function convertingColumnTheme(palette: GridPalette): ConvertingColumnTheme {
  let theme = convertingThemes.get(palette);
  if (theme === undefined) {
    theme = {
      header: {
        bgHeader: withAlphaHex(palette.accent, 0.1),
        bgHeaderHovered: withAlphaHex(palette.accent, 0.16),
        textHeader: palette.accent,
        bgIconHeader: palette.accent,
      },
      cells: {
        bgHeader: withAlphaHex(palette.accent, 0.1),
        bgHeaderHovered: withAlphaHex(palette.accent, 0.16),
        textHeader: palette.accent,
        bgIconHeader: palette.accent,
        textDark: palette.textMuted,
        textMedium: palette.textSubtle,
      },
    };
    convertingThemes.set(palette, theme);
  }
  return theme;
}

export interface ColumnOptions {
  /** Show the header menu button (only when a header-menu handler exists, T207). */
  readonly hasMenu: boolean;
  /** Width overrides by field id (column resize, T207). */
  readonly widths?: Readonly<Record<string, number>>;
  /** Look of the columns of fields being converted (T414); absent: like any column. */
  readonly converting?: ConvertingColumnTheme;
  /** (T554) Fields whose reminder is not sent (header hint warning): crossed-out alarm. */
  readonly reminderOff?: ReadonlySet<string>;
}

/** Glide columns of the fields, in the given order. */
export function toGridColumns(
  fields: readonly GridField[],
  options: ColumnOptions,
): SizedGridColumn[] {
  return fields.map((field) => {
    const column: SizedGridColumn = {
      id: field.field.id,
      title: field.field.name,
      icon:
        options.reminderOff?.has(field.field.id) === true
          ? headerIcon('alarmOff')
          : headerIconOf(field),
      width: options.widths?.[field.field.id] ?? defaultColumnWidth(field),
      hasMenu: options.hasMenu,
    };
    const conversion = field.field.conversion;
    if (options.converting === undefined || conversion?.status !== 'running') return column;
    // Link conversions keep taking writes (CONTRACTS §4.4): only the header is marked.
    const values = conversion.link_change === undefined;
    return {
      ...column,
      icon: headerIcon('lock'),
      themeOverride: values ? options.converting.cells : options.converting.header,
    };
  });
}
