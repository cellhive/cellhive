import { Skeleton } from '@cellhive/ui';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { buildChartModel, type MetricConfig } from '../model/chart-model';
import { modelTable } from '../model/table';
import { TEST_IDS } from '../test-ids';

import { ChartWidget, type ChartWidgetConfig } from './ChartWidget';
import { DataTable } from './DataTable';
import { KpiWidget, type KpiWidgetDisplay } from './KpiWidget';
import { useWidgetPresentation, type WidgetPresentation } from './presentation';

import type { WidgetNumberFormat } from '../model/format';
import type {
  FieldDto,
  WidgetDataDto,
  WidgetDimension,
  WidgetDto,
  WidgetLiveFilterInput,
} from '@cellhive/contracts';

const RecordsTable = lazy(() => import('./RecordsTable'));

/** The config keys the view reads (the API filled the defaults, CONTRACTS §28.2). */
export interface WidgetViewConfig {
  readonly table_id?: string;
  readonly filter?: unknown;
  readonly description?: string | null;
  readonly metrics?: readonly MetricConfig[];
  readonly dimension?: WidgetDimension;
  readonly series_dimension?: WidgetDimension | null;
  readonly table?:
    | {
        readonly mode: 'pivot';
        readonly dimension: WidgetDimension;
        readonly metrics: readonly MetricConfig[];
      }
    | { readonly mode: 'records' };
  readonly markdown?: string;
  readonly display?: Record<string, unknown> & {
    readonly number_format?: WidgetNumberFormat | null;
    readonly empty_text?: string | null;
  };
}

const NO_METRICS: readonly MetricConfig[] = [];

export interface WidgetShape {
  readonly metrics: readonly MetricConfig[];
  readonly dimension: WidgetDimension | undefined;
  readonly presentation: WidgetPresentation;
}

/** Metrics and grouping of a data widget (a pivot table's own), and how its numbers read. */
export function useWidgetShape(
  config: WidgetViewConfig,
  fields: readonly FieldDto[] | undefined,
): WidgetShape {
  const metrics =
    (config.table?.mode === 'pivot' ? config.table.metrics : config.metrics) ?? NO_METRICS;
  const dimension = config.table?.mode === 'pivot' ? config.table.dimension : config.dimension;
  const optionFields = useMemo(
    () => [dimension?.field, config.series_dimension?.field],
    [dimension?.field, config.series_dimension?.field],
  );
  const presentation = useWidgetPresentation(
    metrics,
    config.display?.number_format,
    fields,
    optionFields,
  );
  return { metrics, dimension, presentation };
}

export interface WidgetResultProps extends WidgetShape {
  readonly type: WidgetDto['type'];
  readonly config: WidgetViewConfig;
  readonly title: string;
  readonly data: WidgetDataDto;
  readonly fields: readonly FieldDto[] | undefined;
  /** (T813) The dashboard's widget: cross-filters and click-through of its chart. */
  readonly widget?: WidgetDto | undefined;
  readonly filters?: readonly WidgetLiveFilterInput[] | undefined;
}

/**
 * The numbers of a data widget with `status: ok` (T811): a KPI, a chart, a
 * pivot table or the records table. Shared by the dashboard's cards and the
 * answers of "Ask AI" (T914), which draw a temporary widget the same way.
 */
export function WidgetResult({
  type,
  config,
  title,
  data,
  metrics,
  dimension,
  presentation,
  fields,
  widget,
  filters,
}: WidgetResultProps): ReactNode {
  const { t } = useTranslation('dashboard');
  switch (type) {
    case 'kpi':
      return (
        <KpiWidget
          metricId={metrics[0]?.id ?? ''}
          data={data}
          display={(config.display ?? {}) as KpiWidgetDisplay}
          presentation={presentation}
        />
      );
    case 'bar':
    case 'line':
    case 'combo':
    case 'pie':
      if (dimension === undefined) return null;
      return (
        <ChartWidget
          type={type}
          title={title}
          config={{ ...(config as ChartWidgetConfig), metrics, dimension }}
          data={data}
          presentation={presentation}
          widget={widget}
          {...(filters === undefined ? {} : { filters })}
        />
      );
    case 'table': {
      if (config.table?.mode === 'records') {
        if (fields === undefined) {
          return <Skeleton className="size-full" aria-hidden="true" />;
        }
        return (
          <Suspense fallback={<Skeleton className="size-full" aria-hidden="true" />}>
            <RecordsTable caption={title} data={data} fields={fields} />
          </Suspense>
        );
      }
      const model = buildChartModel({
        type: 'bar',
        metrics,
        data,
        colors: { palette: [], other: '' },
        label: presentation.label,
        otherLabel: presentation.otherLabel,
        metricName: presentation.metricName,
      });
      const table = modelTable(
        model,
        presentation.fieldName(dimension?.field) ?? t('chart.dimension'),
        presentation.format,
      );
      return (
        <DataTable
          caption={title}
          columns={table.columns}
          rows={table.rows}
          testId={TEST_IDS.widgetPivot}
        />
      );
    }
    default:
      return null;
  }
}
