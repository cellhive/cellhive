import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { GridLayout, noCompactor, useContainerWidth } from 'react-grid-layout';

import {
  GRID_GAP,
  SINGLE_COLUMN_BELOW,
  gridConfig,
  readingOrder,
  singleColumnHeight,
  viewLayout,
} from '../model/layout';

import type { WidgetDto } from '@cellhive/contracts';

const WIDE_QUERY = `(min-width: ${String(SINGLE_COLUMN_BELOW)}px)`;

function wideQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null;
}

/** `true` from 1024 px: the 12-column grid; below, one column (SPEC §10.1). */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = wideQuery();
      query?.addEventListener('change', onChange);
      return () => query?.removeEventListener('change', onChange);
    },
    () => wideQuery()?.matches ?? true,
  );
}

const DISABLED = { enabled: false } as const;

/**
 * The widgets of a dashboard in view mode (T811, SPEC §10.1): the saved
 * 12-column layout (react-grid-layout, every item static: nothing moves,
 * nothing resizes) from 1024 px; below, one column in reading order (row,
 * then column) at the saved heights. The DOM order is the reading order in
 * both, so keyboard focus follows what is read.
 */
export function DashboardGrid({
  widgets,
  renderWidget,
  gap = GRID_GAP,
}: {
  readonly widgets: readonly WidgetDto[];
  readonly renderWidget: (widget: WidgetDto) => ReactNode;
  /** Gap between widgets in pixels (dashboard density, T812). */
  readonly gap?: number;
}) {
  const wide = useWideLayout();
  const ordered = useMemo(() => readingOrder(widgets), [widgets]);
  if (!wide) {
    return (
      <ol
        className="flex flex-col"
        style={{ gap }}
        data-testid="dashboard-grid"
        data-layout="column"
      >
        {ordered.map((widget) => (
          <li
            key={widget.id}
            className="flex min-w-0 flex-col"
            style={{ height: singleColumnHeight(widget.layout.h, gap) }}
          >
            {renderWidget(widget)}
          </li>
        ))}
      </ol>
    );
  }
  return <WideGrid widgets={ordered} renderWidget={renderWidget} gap={gap} />;
}

function WideGrid({
  widgets,
  renderWidget,
  gap,
}: {
  readonly widgets: readonly WidgetDto[];
  readonly renderWidget: (widget: WidgetDto) => ReactNode;
  readonly gap: number;
}) {
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1024 });
  const layout = useMemo(() => viewLayout(widgets), [widgets]);
  const config = useMemo(() => gridConfig(gap), [gap]);
  return (
    <div ref={containerRef} data-testid="dashboard-grid" data-layout="grid">
      {mounted ? (
        <GridLayout
          className="relative"
          width={width}
          layout={layout}
          gridConfig={config}
          dragConfig={DISABLED}
          resizeConfig={DISABLED}
          compactor={noCompactor}
          autoSize
        >
          {widgets.map((widget) => (
            <div key={widget.id} className="flex min-w-0 flex-col">
              {renderWidget(widget)}
            </div>
          ))}
        </GridLayout>
      ) : null}
    </div>
  );
}
