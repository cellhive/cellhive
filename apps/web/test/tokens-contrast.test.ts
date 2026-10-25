import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DASHBOARD_PALETTE_IDS, DASHBOARD_PALETTES } from '../src/features/dashboard/model/theme';

import { allThemeTokens } from './tokens';

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

const indexCss = readFileSync(resolve(import.meta.dirname, '../src/styles/index.css'), 'utf8');

describe('control borders (WCAG 1.4.11, T322b)', () => {
  it.each(['light', 'dark'] as const)(
    'gives --border-control at least 3:1 against every surface a control sits on in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      const border = tokens['border-control'] ?? '';
      expect(border).toMatch(/^#[0-9a-f]{6}$/u);
      for (const surface of ['surface', 'bg', 'surface-sunken', 'accent-soft']) {
        expect(
          contrast(border, tokens[surface] ?? ''),
          `${border} on ${surface} (${tokens[surface] ?? ''})`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(['light', 'dark'] as const)(
    'keeps --border for dividers only: it is lighter than the control border in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      expect(contrast(tokens['border'] ?? '', tokens['surface'] ?? '')).toBeLessThan(3);
    },
  );

  it.each(['light', 'dark'] as const)(
    'keeps the switch thumb distinguishable from the off track (3:1) in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      expect(
        contrast(tokens['surface'] ?? '', tokens['border-control'] ?? ''),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it('exposes the token to Tailwind and draws native check boxes with it', () => {
    expect(indexCss).toContain('--color-line-control: var(--border-control);');
    expect(indexCss).toMatch(
      /input\[type='checkbox'\]:not\(\[role='switch'\]\) \{[^}]*border: 1px solid var\(--border-control\)/u,
    );
  });
});

describe('radios and the inverse bar (T421b)', () => {
  it('draws native radios with the tokens, not the browser blue', () => {
    expect(indexCss).toMatch(
      /input\[type='radio'\] \{[^}]*appearance: none;[^}]*border: 1px solid var\(--border-control\)/u,
    );
    expect(indexCss).toMatch(
      /input\[type='radio'\]::before \{[^}]*background-color: var\(--accent\)/u,
    );
    expect(indexCss).toMatch(/input\[type='radio'\]:checked \{[^}]*border-color: var\(--accent\)/u);
  });

  it.each(['light', 'dark'] as const)(
    'keeps the checked radio (accent) at 3:1 on the surfaces it sits on in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      for (const surface of ['surface', 'accent-soft']) {
        expect(contrast(tokens['accent'] ?? '', tokens[surface] ?? '')).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it.each(['light', 'dark'] as const)(
    'gives the outlined "Delete permanently" 4.5:1 on the inverse bar in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      expect(
        contrast(tokens['danger-on-inverse'] ?? '#000000', tokens['inverse'] ?? ''),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('motion tokens (T322b)', () => {
  it('enters in 150–200 ms and leaves faster', () => {
    const tokens = allThemeTokens('light');
    const enter = Number.parseInt(tokens['motion-enter'] ?? '', 10);
    const exit = Number.parseInt(tokens['motion-exit'] ?? '', 10);
    expect(enter).toBeGreaterThanOrEqual(150);
    expect(enter).toBeLessThanOrEqual(200);
    expect(exit).toBeLessThan(enter);
  });

  it('cuts every animation and transition when reduced motion is asked for', () => {
    expect(indexCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\{[^}]*animation-duration: 0\.01ms !important;[^}]*transition-duration: 0\.01ms !important;/u,
    );
  });
});

describe('accent buttons (T521b: hover was 4.48:1)', () => {
  const button = readFileSync(
    resolve(import.meta.dirname, '../../../packages/ui/src/components/button.tsx'),
    'utf8',
  );

  it.each(['light', 'dark'] as const)(
    'keeps the text of an accent button at 4.5:1, at rest and on hover, in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      for (const background of ['accent', 'accent-hover']) {
        expect(
          contrast(tokens['on-accent'] ?? '', tokens[background] ?? ''),
          `on-accent on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('hovers with the token, not a see-through accent', () => {
    expect(indexCss).toContain('--color-accent-hover: var(--accent-hover);');
    expect(button).toContain('hover:bg-accent-hover');
    expect(button).not.toMatch(/hover:bg-accent\/\d+/u);
  });
});

describe('dashboard palettes (WCAG 1.4.11, T812)', () => {
  it.each(DASHBOARD_PALETTE_IDS.filter((id) => DASHBOARD_PALETTES[id] !== null))(
    'gives every series color of %s at least 3:1 on the light and the dark surface',
    (id) => {
      for (const theme of ['light', 'dark'] as const) {
        const surface = allThemeTokens(theme)['surface'] ?? '';
        for (const color of DASHBOARD_PALETTES[id] ?? []) {
          expect(
            contrast(color, surface),
            `${color} on ${theme} ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );
});
