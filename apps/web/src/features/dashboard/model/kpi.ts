import type { WidgetDataDto } from '@cellhive/contracts';

/**
 * A KPI widget (SPEC §10.2, CONTRACTS §28.3; T811): the value, the change
 * against the previous period, the threshold color and the progress toward
 * a target. Pure; the widget draws it in the DOM (no ECharts).
 */

export interface KpiThreshold {
  /** Applies when the value is below this (`null`: every value — the last resort). */
  readonly below: number | null;
  readonly color: string;
}

export interface KpiDisplay {
  readonly target?: number | null | undefined;
  readonly thresholds?: readonly KpiThreshold[] | undefined;
}

export interface KpiModel {
  readonly value: number | null;
  /** Previous period: its value and the relative change (`null` when not comparable). */
  readonly compare: {
    readonly previous: number | null;
    readonly change: number | null;
    readonly direction: 'up' | 'down' | 'flat' | null;
  } | null;
  /** Color of the first threshold the value is below (thresholds by `below`, `null` last). */
  readonly color: string | null;
  /** Progress toward `target`: the fraction reached (may pass 1), `null` without target. */
  readonly progress: number | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The threshold that applies to `value` (`null` when none does). */
export function thresholdColor(
  value: number | null,
  thresholds: readonly KpiThreshold[] | undefined,
): string | null {
  if (value === null || thresholds === undefined || thresholds.length === 0) return null;
  const ordered = [...thresholds].sort((a, b) => {
    if (a.below === null) return b.below === null ? 0 : 1;
    if (b.below === null) return -1;
    return a.below - b.below;
  });
  const hit = ordered.find((item) => item.below === null || value < item.below);
  return hit?.color ?? null;
}

export function buildKpiModel(
  data: Pick<WidgetDataDto, 'rows' | 'compare'>,
  display: KpiDisplay,
): KpiModel {
  const value = numberOrNull(data.rows[0]?.[0]);
  const compare =
    data.compare === undefined
      ? null
      : {
          previous: data.compare.previous,
          change: data.compare.change,
          direction:
            data.compare.change === null
              ? null
              : data.compare.change > 0
                ? ('up' as const)
                : data.compare.change < 0
                  ? ('down' as const)
                  : ('flat' as const),
        };
  const target = display.target ?? null;
  return {
    value,
    compare,
    color: thresholdColor(value, display.thresholds),
    progress: target === null || target === 0 || value === null ? null : value / target,
  };
}
