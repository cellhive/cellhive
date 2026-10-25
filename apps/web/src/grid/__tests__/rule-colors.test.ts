import { COLOR_RULE_COLORS } from '@cellhive/contracts';
import { describe, expect, it, vi } from 'vitest';

import { allThemeTokens, darkBlocks } from '../../../test/tokens';
import { drawRuleColor, RULE_MARK_WIDTH, type GridCellPaint } from '../rule-colors';
import { rulePainter, type RuleColorTokens } from '../rule-painter';

import type { GridRecord } from '../types';

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

const STATUS = 'fld_Status0000000001';
const TITLE = 'fld_Title00000000001';
const ROW_RULE = 'clr_Row0000000000001';
const CELL_RULE = 'clr_Cell000000000001';

const TOKENS = Object.fromEntries(
  COLOR_RULE_COLORS.map((color) => [color, { bg: `${color}-bg`, mark: `${color}-mark` }]),
) as RuleColorTokens;

function record(meta: GridRecord['meta']): GridRecord {
  const base: GridRecord = {
    id: 'rec_A000000000000001',
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
    version: 1,
    fields: {},
  };
  return meta === undefined ? base : { ...base, meta };
}

describe('rule color tokens (styles/tokens.css, T816)', () => {
  it.each(['light', 'dark'] as const)(
    'keeps text readable on every rule background and the mark visible in %s',
    (theme) => {
      const tokens = allThemeTokens(theme);
      for (const color of COLOR_RULE_COLORS) {
        const bg = tokens[`rule-${color}-bg`] ?? '';
        const mark = tokens[`rule-${color}-mark`] ?? '';
        expect(bg, color).toMatch(/^#[0-9a-f]{6}$/u);
        for (const text of ['text', 'text-muted']) {
          expect(contrast(tokens[text] ?? '', bg), `${text} on ${color}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
        expect(contrast(mark, bg), `${color} mark`).toBeGreaterThanOrEqual(3);
      }
    },
  );

  it('defines the rule colors in both dark blocks', () => {
    const { explicit, system } = darkBlocks();
    expect(explicit.filter((line) => line.startsWith('rule-'))).toHaveLength(
      COLOR_RULE_COLORS.length * 2,
    );
    expect(system).toEqual(explicit);
  });
});

describe('rulePainter', () => {
  const rules = [
    { id: ROW_RULE, color: 'red', target: 'row' },
    { id: CELL_RULE, color: 'blue', target: 'cell' },
  ] as const;

  it('paints nothing without rules', () => {
    expect(rulePainter(undefined, TOKENS)).toBeUndefined();
    expect(rulePainter([], TOKENS)).toBeUndefined();
  });

  it.each([
    ['no meta', undefined, STATUS, null],
    ['no matching rule', { color: {} }, STATUS, null],
    [
      'a row rule',
      { color: { row: ROW_RULE } },
      TITLE,
      { bg: 'red-bg', mark: 'red-mark', row: true },
    ],
    [
      'a cell rule winning over the row rule',
      { color: { row: ROW_RULE, cells: { [STATUS]: CELL_RULE } } },
      STATUS,
      { bg: 'blue-bg', mark: 'blue-mark', row: false },
    ],
    [
      'the row rule in the other cells',
      { color: { row: ROW_RULE, cells: { [STATUS]: CELL_RULE } } },
      TITLE,
      { bg: 'red-bg', mark: 'red-mark', row: true },
    ],
    ['a rule id the rules no longer know', { color: { row: 'clr_Gone000000000001' } }, TITLE, null],
  ] as const)('%s', (_name, meta, fieldId, expected) => {
    const paint = rulePainter(rules, TOKENS);
    expect(paint?.(record(meta as GridRecord['meta']), fieldId)).toEqual(expected);
  });

  it('returns the same paint object for every cell (no allocation while drawing)', () => {
    const paint = rulePainter(rules, TOKENS);
    const colored = record({ color: { row: ROW_RULE } });
    expect(paint?.(colored, STATUS)).toBe(paint?.(colored, TITLE));
  });
});

describe('drawRuleColor', () => {
  function context() {
    const fills: { style: string; rect: number[] }[] = [];
    const ctx = {
      fillStyle: 'original',
      fillRect: vi.fn((...rect: number[]) => {
        fills.push({ style: ctx.fillStyle, rect });
      }),
    };
    return { ctx, fills };
  }
  const rect = { x: 10, y: 20, width: 100, height: 34 };
  const row: GridCellPaint = { bg: 'bg', mark: 'mark', row: true };
  const cell: GridCellPaint = { bg: 'bg', mark: 'mark', row: false };

  it.each([
    ['row rule, first column', row, true, false, ['bg', 'mark']],
    ['row rule, other column', row, false, false, ['bg']],
    ['cell rule', cell, false, false, ['bg', 'mark']],
    ['selected cell keeps the selection fill', row, true, true, ['mark']],
  ] as const)('%s', (_name, paint, first, highlighted, styles) => {
    const { ctx, fills } = context();
    drawRuleColor(ctx as unknown as CanvasRenderingContext2D, rect, paint, first, highlighted);
    expect(fills.map((fill) => fill.style)).toEqual(styles);
    for (const fill of fills) {
      expect(fill.rect).toEqual(
        fill.style === 'mark' ? [10, 20, RULE_MARK_WIDTH, 34] : [10, 20, 100, 34],
      );
    }
    expect(ctx.fillStyle).toBe('original');
  });
});
