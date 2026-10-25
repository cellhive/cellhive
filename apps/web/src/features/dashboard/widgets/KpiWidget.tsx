import { cn } from '@cellhive/ui';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { changeFormatter } from '../model/format';
import { buildKpiModel, type KpiDisplay } from '../model/kpi';

import type { WidgetPresentation } from './presentation';
import type { WidgetDataDto } from '@cellhive/contracts';

export interface KpiWidgetDisplay extends KpiDisplay {
  readonly prefix?: string | null | undefined;
  readonly suffix?: string | null | undefined;
}

/**
 * A KPI (T811, SPEC §10.2): the number, the change against the previous
 * period (arrow and signed percentage — never color alone), the threshold
 * color as a bar beside the number (with its text in the bar's name) and the
 * progress toward the target. DOM only, no ECharts.
 */
export function KpiWidget({
  metricId,
  data,
  display,
  presentation,
}: {
  readonly metricId: string;
  readonly data: WidgetDataDto;
  readonly display: KpiWidgetDisplay;
  readonly presentation: WidgetPresentation;
}) {
  const { t } = useTranslation('dashboard');
  const model = buildKpiModel(data, display);
  const format = presentation.format(metricId);
  const value = model.value === null ? '–' : format(model.value);
  const text = `${display.prefix ?? ''}${value}${display.suffix ?? ''}`;
  const change = changeFormatter(presentation.locale);
  const compare = model.compare;
  const Arrow =
    compare?.direction === 'up'
      ? ArrowUpRight
      : compare?.direction === 'down'
        ? ArrowDownRight
        : ArrowRight;
  const target = display.target ?? null;
  const percent = model.progress === null ? null : Math.round(model.progress * 100);

  return (
    <div className="flex size-full flex-col justify-center gap-3" data-testid="kpi-widget">
      <div className="flex items-stretch gap-3">
        {model.color === null ? null : (
          <span
            aria-hidden="true"
            className="w-1 shrink-0 rounded-full"
            style={{ backgroundColor: model.color }}
          />
        )}
        <p
          className="min-w-0 truncate text-[2rem] leading-tight font-semibold text-fg tabular-nums"
          data-testid="kpi-value"
        >
          {text}
        </p>
      </div>
      {compare === null ? null : (
        <p
          className={cn('flex flex-wrap items-center gap-1 text-label font-normal text-fg-muted')}
          data-testid="kpi-compare"
        >
          <Arrow aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-medium text-fg tabular-nums">
            {compare.change === null ? '–' : change(compare.change)}
          </span>
          <span>
            {compare.previous === null
              ? t('kpi.noPrevious')
              : t('kpi.previous', { value: format(compare.previous) })}
          </span>
        </p>
      )}
      {target === null || percent === null ? null : (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label={t('kpi.progressLabel', { target: format(target) })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(Math.max(percent, 0), 100)}
            aria-valuetext={t('kpi.progress', { percent, target: format(target) })}
            className="h-2 overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${String(Math.min(Math.max(percent, 0), 100))}%`,
                ...(model.color === null ? {} : { backgroundColor: model.color }),
              }}
            />
          </div>
          <p className="text-label font-normal text-fg-muted">
            {t('kpi.progress', { percent, target: format(target) })}
          </p>
        </div>
      )}
    </div>
  );
}
