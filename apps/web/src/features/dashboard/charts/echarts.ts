import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use as registerParts } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import type { BarSeriesOption, LineSeriesOption, PieSeriesOption } from 'echarts/charts';
import type {
  AriaComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import type { ComposeOption } from 'echarts/core';

/**
 * The ECharts build of the dashboard (T811, S7 decision #18, FRONTEND
 * §11.1): `echarts/core` with only the bar, line and pie charts, the grid,
 * tooltip, legend and aria components and the canvas renderer — nothing
 * else is registered, so tree-shaking keeps the dashboard chunk in budget.
 * Imported only from the dashboard route (never the app shell).
 */
registerParts([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  CanvasRenderer,
]);

/** The option shape these modules accept. */
export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | AriaComponentOption
>;

export { init };
export type ChartInstance = ReturnType<typeof init>;
