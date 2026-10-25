import { useEffect, useRef, type KeyboardEventHandler } from 'react';

import { init, type ChartInstance, type ChartOption } from './echarts';

/** (T813) A data element of the chart clicked, or its context menu asked for. */
export interface ChartElementEvent {
  readonly kind: 'click' | 'menu';
  readonly dataIndex: number;
  readonly seriesIndex: number;
  /** Pointer position in the chart box (pixels). */
  readonly x: number;
  readonly y: number;
}

export interface EChartProps {
  readonly option: ChartOption;
  /** Text alternative (also given to ECharts `aria`, which writes the same label). */
  readonly label: string;
  readonly testId?: string;
  /** (T813) The instance once created (`null` when disposed): PNG export, keyboard highlight. */
  readonly onReady?: ((instance: ChartInstance | null) => void) | undefined;
  /** (T813) Clicks and context menus on data elements (cross-filter, click-through). */
  readonly onElement?: ((event: ChartElementEvent) => void) | undefined;
  /** (T813) The chart takes the focus: arrow keys move between its elements. */
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement> | undefined;
  readonly onBlur?: (() => void) | undefined;
  readonly describedBy?: string | undefined;
}

interface ElementParams {
  readonly dataIndex?: number;
  readonly seriesIndex?: number;
  readonly event?: { offsetX?: number; offsetY?: number; event?: Event };
}

/**
 * One ECharts canvas (T811): created on mount, resized with its box
 * (`ResizeObserver`: the grid and the one-column layout set the size),
 * disposed on unmount. Each new option replaces the previous one. The box
 * is an image to assistive technology, named by the summary; "View as
 * table" next to it gives the numbers themselves. (T813) With `onElement`
 * the box is focusable and its data elements react to clicks.
 */
export function EChart({
  option,
  label,
  testId,
  onReady,
  onElement,
  onKeyDown,
  onBlur,
  describedBy,
}: EChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<ChartInstance | null>(null);
  const handlers = useRef({ onReady, onElement });
  useEffect(() => {
    handlers.current = { onReady, onElement };
  });

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const instance = init(element, null, { renderer: 'canvas' });
    chart.current = instance;
    const observer = new ResizeObserver(() => {
      instance.resize();
    });
    observer.observe(element);
    const emit = (kind: ChartElementEvent['kind']) => (raw: unknown) => {
      const params = raw as ElementParams;
      if (params.dataIndex === undefined) return;
      if (kind === 'menu') params.event?.event?.preventDefault();
      handlers.current.onElement?.({
        kind,
        dataIndex: params.dataIndex,
        seriesIndex: params.seriesIndex ?? 0,
        x: params.event?.offsetX ?? 0,
        y: params.event?.offsetY ?? 0,
      });
    };
    instance.on('click', emit('click'));
    instance.on('contextmenu', emit('menu'));
    handlers.current.onReady?.(instance);
    return () => {
      handlers.current.onReady?.(null);
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  const interactive = onElement !== undefined;
  return (
    <div
      ref={box}
      role="img"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className="size-full min-h-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    />
  );
}

export default EChart;
