import { COLOR_RULE_COLORS, type ColorRuleColor } from '@cellhive/contracts';
import { useEffect, useMemo, useState } from 'react';

import type { GridCellPaint, GridColorPaint } from './rule-colors';
import type { GridRecord } from './types';

/**
 * Colors of a grid view's rows and cells (T816, FRONTEND §6.9). The server
 * evaluates the color rules for the reader and names the winning rule in
 * `record.meta.color` (`row`, `cells[fieldId]`); this maps rule ids to the
 * paint of their color token. Built once per rules × theme: drawing a cell
 * is two map lookups and never allocates.
 */

/** What a paint needs of a rule (a shared view config has no filter). */
export interface PaintedRule {
  readonly id: string;
  readonly color: ColorRuleColor;
  readonly target: 'row' | 'cell';
}

/** Background and mark of each palette color, read from `--rule-<color>-bg|mark`. */
export type RuleColorTokens = Readonly<Record<ColorRuleColor, { bg: string; mark: string }>>;

export function readRuleColorTokens(element: Element = document.documentElement): RuleColorTokens {
  const style = window.getComputedStyle(element);
  return Object.fromEntries(
    COLOR_RULE_COLORS.map((color) => [
      color,
      {
        bg: style.getPropertyValue(`--rule-${color}-bg`).trim(),
        mark: style.getPropertyValue(`--rule-${color}-mark`).trim(),
      },
    ]),
  ) as RuleColorTokens;
}

/** The rule colors of the current theme, read again when `data-theme` or the system preference changes. */
export function useRuleColorTokens(): RuleColorTokens {
  const [tokens, setTokens] = useState(() => readRuleColorTokens());
  useEffect(() => {
    const refresh = () => {
      setTokens(readRuleColorTokens());
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
  return tokens;
}

/**
 * The cell painter of a view's rules; `undefined` without any rule (the
 * grid then draws without a cell callback). A cell rule wins over the row
 * rule in its cell; a rule id the rules no longer know (a rule removed,
 * colors not refetched yet) paints nothing.
 */
export function rulePainter(
  rules: readonly PaintedRule[] | undefined,
  tokens: RuleColorTokens,
): GridColorPaint | undefined {
  if (rules === undefined || rules.length === 0) return undefined;
  const paints = new Map<string, GridCellPaint>();
  for (const rule of rules) {
    const token = tokens[rule.color];
    paints.set(rule.id, { bg: token.bg, mark: token.mark, row: rule.target === 'row' });
  }
  return (record: GridRecord, fieldId: string) => {
    const color = record.meta?.color;
    if (color === undefined) return null;
    const cell = color.cells?.[fieldId as keyof typeof color.cells];
    if (cell !== undefined) {
      const paint = paints.get(cell);
      if (paint !== undefined) return paint;
    }
    return color.row === undefined ? null : (paints.get(color.row) ?? null);
  };
}

/** {@link rulePainter} of the current theme, rebuilt when the rules or the theme change. */
export function useRulePainter(
  rules: readonly PaintedRule[] | undefined,
): GridColorPaint | undefined {
  const tokens = useRuleColorTokens();
  return useMemo(() => rulePainter(rules, tokens), [rules, tokens]);
}
