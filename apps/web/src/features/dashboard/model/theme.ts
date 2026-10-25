import type { DashboardTheme } from '@cellhive/contracts';
import type { CSSProperties } from 'react';

/**
 * The look of a dashboard (T812, SPEC §10.1, CONTRACTS §28.1 `theme`):
 * light or dark whatever the viewer's app theme (`system`, the default,
 * follows it), a series palette from a fixed set, and the density of the
 * grid. Pure: the page turns it into attributes of its root element.
 */

/**
 * Series palettes offered by the editor: 8 colors each, every one at least
 * 3:1 against both the light (#ffffff) and the dark (#181b1e) surface
 * (WCAG 1.4.11 graphical objects), so one palette serves both themes.
 * `default` is the app's own `--chart-*` tokens (FRONTEND §9.3).
 */
export const DASHBOARD_PALETTES = {
  default: null,
  colorblind: [
    '#0072b2',
    '#d55e00',
    '#009e73',
    '#cc79a7',
    '#b8860b',
    '#3a8fc7',
    '#8e6bbf',
    '#7a8a1f',
  ],
  classic: ['#4e79a7', '#e15759', '#59a14f', '#b07aa1', '#d37d1f', '#3f9a94', '#c45a8a', '#9c755f'],
  cool: ['#1d6fd1', '#0e8f8a', '#5b5bd6', '#2f8f46', '#b5651d', '#c2417a', '#7b61c9', '#4f8a9e'],
} as const satisfies Record<string, readonly string[] | null>;

export type DashboardPaletteId = keyof typeof DASHBOARD_PALETTES;
export const DASHBOARD_PALETTE_IDS = Object.keys(DASHBOARD_PALETTES) as DashboardPaletteId[];

/** The preset a saved palette is (`default` for none or one not in the set). */
export function paletteIdOf(palette: readonly string[] | null | undefined): DashboardPaletteId {
  if (palette === null || palette === undefined) return 'default';
  const wanted = palette.map((color) => color.toLowerCase()).join(',');
  return (
    DASHBOARD_PALETTE_IDS.find((id) => DASHBOARD_PALETTES[id]?.join(',') === wanted) ?? 'default'
  );
}

/** Gap between widgets, in pixels. */
export const DENSITY_GAP = { comfortable: 16, compact: 8 } as const;
export type DashboardDensity = keyof typeof DENSITY_GAP;

export function densityOf(theme: DashboardTheme): DashboardDensity {
  return theme.density ?? 'comfortable';
}

export interface DashboardSurface {
  /** `data-dashboard-theme` of the page root (tokens.css), absent to follow the app. */
  readonly mode: 'light' | 'dark' | undefined;
  readonly density: DashboardDensity;
  /** `--chart-0…7` of the palette (inline custom properties), when not the default. */
  readonly style: CSSProperties | undefined;
}

export function dashboardSurface(theme: DashboardTheme): DashboardSurface {
  const palette = theme.palette ?? null;
  const style =
    palette === null || palette.length === 0
      ? undefined
      : (Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `--chart-${String(index)}`,
            palette[index % palette.length],
          ]),
        ) as CSSProperties);
  return {
    mode: theme.mode === 'light' || theme.mode === 'dark' ? theme.mode : undefined,
    density: densityOf(theme),
    style,
  };
}
