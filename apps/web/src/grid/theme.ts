import { useEffect, useState } from 'react';

import type { Theme } from '@glideapps/glide-data-grid';

/**
 * Grid theme from the design tokens (FRONTEND §9.3): the canvas cannot read
 * CSS variables, so the adapter reads them from `<html>` and maps them to
 * glide's `Theme`, again whenever `data-theme` or the system preference
 * changes. No color is hard-coded here.
 */

/** Number of select option colors in `styles/tokens.css` (`--option-N-bg/fg`). */
export const OPTION_COLOR_COUNT = 8;

const BASE_TOKENS = [
  'font-ui',
  'font-code',
  'surface',
  'surface-sunken',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-subtle',
  'accent',
  'accent-soft',
  'on-accent',
  'warning',
  'danger',
  'success',
] as const;

type OptionIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type OptionToken = `option-${OptionIndex}-${'bg' | 'fg'}`;
/** Solid user avatar colors (`--avatar-N`) and their initials (`--on-avatar`). */
type AvatarToken = `avatar-${OptionIndex}` | 'on-avatar';
export type GridTokenName = (typeof BASE_TOKENS)[number] | OptionToken | AvatarToken;
export type GridTokens = Readonly<Record<GridTokenName, string>>;

const optionToken = (index: number, part: 'bg' | 'fg') =>
  `option-${String(index)}-${part}` as OptionToken;
const avatarToken = (index: number) => `avatar-${String(index)}` as AvatarToken;

/** Token names (without `--`) the grid reads. */
export const GRID_TOKENS: readonly GridTokenName[] = [
  ...BASE_TOKENS,
  ...Array.from({ length: OPTION_COLOR_COUNT }, (_, index) => [
    optionToken(index, 'bg'),
    optionToken(index, 'fg'),
  ]).flat(),
  ...Array.from({ length: OPTION_COLOR_COUNT }, (_, index) => avatarToken(index)),
  'on-avatar',
];

/** Background and text color of a select chip or an avatar. */
export interface ChipColor {
  readonly bg: string;
  readonly fg: string;
}

/**
 * Colors and fonts the cell renderers need besides glide's `Theme`
 * (custom-drawn chips, avatars, progress bars, mono codes).
 */
export interface GridPalette {
  readonly options: readonly ChipColor[];
  /**
   * User avatars (T322a): the solid `--avatar-N` circles with white initials
   * of the panel, the kanban cards and the history (`grid/display/Avatar`).
   */
  readonly avatars: readonly ChipColor[];
  readonly fontCode: string;
  readonly accent: string;
  readonly track: string;
  readonly textSubtle: string;
  readonly warning: string;
  /** Border and icon of a cell whose value was refused (FRONTEND §4.1). */
  readonly danger: string;
  /** Group header rows (T312): texts, background and count badge. */
  readonly text: string;
  readonly textMuted: string;
  readonly sunken: string;
  readonly border: string;
  /** Group cards (T320a): card background and the tint of selected cells. */
  readonly surface: string;
  readonly selected: string;
  /** (Motion pass) The row under the pointer: between the cell and the header background. */
  readonly rowHover: string;
}

export interface GridAppearance {
  readonly theme: Partial<Theme>;
  readonly palette: GridPalette;
}

/** `#rrggbb` (or `#rgb`) with an alpha, as `rgba()` glide's color parser reads. */
export function withAlphaHex(hex: string, alpha: number): string {
  const value = hex.trim().replace(/^#/u, '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : value.slice(0, 6);
  const channel = (index: number) => Number.parseInt(full.slice(index, index + 2), 16);
  if (!/^[0-9a-f]{6}$/iu.test(full)) return hex;
  return `rgba(${String(channel(0))}, ${String(channel(2))}, ${String(channel(4))}, ${String(alpha)})`;
}

/** `#rrggbb` `from` moved toward `to` by `share` (0–1), as `#rrggbb`; another format comes back as `from`. */
export function mixHex(from: string, to: string, share: number): string {
  const parse = (hex: string) => /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
  const [a, b] = [parse(from), parse(to)];
  if (a === null || b === null) return from;
  const channel = (index: number) => {
    const start = Number.parseInt(a[index] ?? '0', 16);
    const end = Number.parseInt(b[index] ?? '0', 16);
    return Math.round(start + (end - start) * share)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(2)}${channel(3)}`;
}

/** Density of the grid rows (FRONTEND §9.3): 34 px compact, 44 px comfortable. */
export const ROW_HEIGHTS = { compact: 34, comfortable: 44 } as const;
export type GridDensity = keyof typeof ROW_HEIGHTS;
export const HEADER_HEIGHT = 36;

/** Maps design tokens to glide's theme and the renderers' palette. Pure. */
export function tokensToAppearance(tokens: GridTokens): GridAppearance {
  const theme: Partial<Theme> = {
    accentColor: tokens.accent,
    accentFg: tokens['on-accent'],
    accentLight: withAlphaHex(tokens.accent, 0.14),
    textDark: tokens.text,
    textMedium: tokens['text-muted'],
    textLight: tokens['text-subtle'],
    textBubble: tokens.text,
    bgIconHeader: tokens['text-subtle'],
    fgIconHeader: tokens.surface,
    textHeader: tokens['text-muted'],
    textGroupHeader: tokens['text-muted'],
    textHeaderSelected: tokens['on-accent'],
    bgCell: tokens.surface,
    bgCellMedium: tokens['surface-sunken'],
    bgHeader: tokens['surface-sunken'],
    bgHeaderHasFocus: tokens.border,
    bgHeaderHovered: tokens.border,
    bgBubble: tokens['surface-sunken'],
    bgBubbleSelected: tokens.surface,
    bgSearchResult: withAlphaHex(tokens.warning, 0.2),
    borderColor: tokens.border,
    horizontalBorderColor: tokens.border,
    headerBottomBorderColor: tokens['border-strong'],
    drilldownBorder: withAlphaHex(tokens.border, 0),
    linkColor: tokens.accent,
    resizeIndicatorColor: tokens.accent,
    cellHorizontalPadding: 8,
    cellVerticalPadding: 4,
    headerIconSize: 16,
    headerFontStyle: '500 12px',
    baseFontStyle: '13px',
    markerFontStyle: '12px',
    fontFamily: tokens['font-ui'],
    editorFontSize: '13px',
    lineHeight: 1.5,
    roundingRadius: 4,
  };
  const palette: GridPalette = {
    options: Array.from({ length: OPTION_COLOR_COUNT }, (_, index) => ({
      bg: tokens[optionToken(index, 'bg')],
      fg: tokens[optionToken(index, 'fg')],
    })),
    avatars: Array.from({ length: OPTION_COLOR_COUNT }, (_, index) => ({
      bg: tokens[avatarToken(index)],
      fg: tokens['on-avatar'],
    })),
    fontCode: tokens['font-code'],
    accent: tokens.accent,
    track: tokens['surface-sunken'],
    textSubtle: tokens['text-subtle'],
    warning: tokens.warning,
    danger: tokens.danger,
    text: tokens.text,
    textMuted: tokens['text-muted'],
    sunken: tokens['surface-sunken'],
    border: tokens.border,
    surface: tokens.surface,
    selected: withAlphaHex(tokens.accent, 0.14),
    rowHover: mixHex(tokens.surface, tokens['surface-sunken'], 0.8),
  };
  return { theme, palette };
}

/** Current token values on `<html>`. */
export function readTokens(element: Element = document.documentElement): GridTokens {
  const style = window.getComputedStyle(element);
  return Object.fromEntries(
    GRID_TOKENS.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  ) as GridTokens;
}

/**
 * The grid appearance, re-read when the theme changes: `data-theme` on
 * `<html>` (user choice) or the system preference (theme "system").
 */
export function useGridAppearance(): GridAppearance {
  const [appearance, setAppearance] = useState(() => tokensToAppearance(readTokens()));
  useEffect(() => {
    const refresh = () => {
      setAppearance(tokensToAppearance(readTokens()));
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    media?.addEventListener('change', refresh);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', refresh);
    };
  }, []);
  return appearance;
}
