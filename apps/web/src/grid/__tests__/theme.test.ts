import { describe, expect, it } from 'vitest';

import { allThemeTokens, darkBlocks, themeTokens } from '../../../test/tokens';
import {
  GRID_TOKENS,
  mixHex,
  OPTION_COLOR_COUNT,
  tokensToAppearance,
  withAlphaHex,
} from '../theme';

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((value) =>
    value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe('grid tokens (styles/tokens.css)', () => {
  it.each(['light', 'dark'] as const)('defines every token the grid reads in %s', (theme) => {
    const tokens = themeTokens(theme);
    for (const name of GRID_TOKENS) expect(tokens[name], name).not.toBe('');
  });

  it.each(['light', 'dark'] as const)(
    'gives every select option color at least 4.5:1 text contrast in %s (FRONTEND §9.3)',
    (theme) => {
      const { palette } = tokensToAppearance(themeTokens(theme));
      expect(palette.options).toHaveLength(OPTION_COLOR_COUNT);
      for (const color of palette.options) {
        expect(contrast(color.fg, color.bg), `${color.fg} on ${color.bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
});

describe('design board colors (T320b)', () => {
  it('uses the design board values for the gray, leaf, pink and jade options', () => {
    const tokens = allThemeTokens('light');
    expect(
      [0, 2, 4, 5].map((index) => [
        tokens[`option-${String(index)}-bg`],
        tokens[`option-${String(index)}-fg`],
      ]),
    ).toEqual([
      ['#eef1f4', '#3f4854'],
      ['#dcfce7', '#166534'],
      ['#ffe4e6', '#9f1239'],
      ['#ccfbf1', '#115e59'],
    ]);
  });

  it.each(['light', 'dark'] as const)(
    'gives avatar initials and the inverse bar at least 4.5:1 in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      for (let index = 0; index < OPTION_COLOR_COUNT; index += 1) {
        const bg = tokens[`avatar-${String(index)}`] ?? '';
        expect(
          contrast(tokens['on-avatar'] ?? '', bg),
          `avatar-${String(index)}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokens['on-inverse'] ?? '', tokens['inverse'] ?? '')).toBeGreaterThanOrEqual(
        4.5,
      );
      // The inverse bar stands out from the page.
      expect(contrast(tokens['inverse'] ?? '', tokens['bg'] ?? '')).toBeGreaterThanOrEqual(3);
    },
  );

  it('keeps the system-preference dark block equal to the explicit dark block', () => {
    const { explicit, system } = darkBlocks();
    expect(explicit.length).toBeGreaterThan(0);
    expect(system).toEqual(explicit);
  });
});

describe('text tokens (FRONTEND §9.3)', () => {
  it.each(['light', 'dark'] as const)(
    'gives muted and subtle text at least 4.5:1 on every surface in %s (S2 QA axe)',
    (theme) => {
      const tokens = themeTokens(theme);
      for (const text of ['text-muted', 'text-subtle'] as const) {
        for (const surface of ['surface', 'surface-sunken', 'accent-soft'] as const) {
          expect(
            contrast(tokens[text], tokens[surface]),
            `${text} ${tokens[text]} on ${surface} ${tokens[surface]}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
});

describe('tokensToAppearance', () => {
  it('maps the light tokens to the glide theme', () => {
    const { theme, palette } = tokensToAppearance(themeTokens('light'));
    expect(theme).toMatchObject({
      accentColor: '#0f766e',
      accentFg: '#ffffff',
      accentLight: 'rgba(15, 118, 110, 0.14)',
      textDark: '#16191d',
      textMedium: '#5b6470',
      bgCell: '#ffffff',
      bgHeader: '#f1f3f5',
      borderColor: '#e1e4e8',
      headerBottomBorderColor: '#c9ced6',
      linkColor: '#0f766e',
      baseFontStyle: '13px',
      headerFontStyle: '500 12px',
      roundingRadius: 4,
    });
    expect(theme.fontFamily).toContain('Be Vietnam Pro');
    expect(palette.fontCode).toContain('JetBrains Mono');
    expect(palette.options[1]).toEqual({ bg: '#e0f2fe', fg: '#075985' });
  });

  it('maps the dark tokens (no light value leaks into the dark theme)', () => {
    const light = tokensToAppearance(themeTokens('light'));
    const dark = tokensToAppearance(themeTokens('dark'));
    expect(dark.theme).toMatchObject({
      accentColor: '#4fb8ab',
      accentFg: '#111315',
      textDark: '#e7eaee',
      bgCell: '#181b1e',
      bgHeader: '#1f2327',
      borderColor: '#2a2f35',
    });
    const colorKeys = Object.entries(dark.theme)
      .filter(([, value]) => typeof value === 'string' && value.startsWith('#'))
      .map(([key]) => key as keyof typeof dark.theme);
    for (const key of colorKeys) expect(dark.theme[key], key).not.toBe(light.theme[key]);
    expect(dark.palette.options).not.toEqual(light.palette.options);
  });
});

describe('withAlphaHex', () => {
  it.each([
    ['#0f766e', 0.14, 'rgba(15, 118, 110, 0.14)'],
    ['#fff', 0.5, 'rgba(255, 255, 255, 0.5)'],
    [' #FDB022 ', 0.2, 'rgba(253, 176, 34, 0.2)'],
    ['not-a-color', 0.2, 'not-a-color'],
  ])('%s at %d → %s', (hex, alpha, expected) => {
    expect(withAlphaHex(hex, alpha)).toBe(expected);
  });
});

describe('mixHex (row hover, motion pass)', () => {
  it.each([
    ['#ffffff', '#f1f3f5', 0.6, '#f7f8f9'],
    ['#000000', '#ffffff', 0.5, '#808080'],
    ['#181b1e', '#1f2327', 0, '#181b1e'],
    ['#181B1E', '#1F2327', 1, '#1f2327'],
    ['rgb(0 0 0)', '#ffffff', 0.5, 'rgb(0 0 0)'],
  ])('%s → %s by %d: %s', (from, to, share, expected) => {
    expect(mixHex(from, to, share)).toBe(expected);
  });
});
