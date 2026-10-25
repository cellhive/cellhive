import { cn } from '@cellhive/ui';
import { useMemo, useState, type ReactNode } from 'react';

import { ChartThemeRoot } from '../charts/use-chart-theme';
import { dashboardSurface } from '../model/theme';

import type { DashboardTheme } from '@cellhive/contracts';

/**
 * (T812) The root of a dashboard page with the dashboard's theme (SPEC
 * §10.1): light/dark tokens whatever the app's theme
 * (`data-dashboard-theme`, tokens.css), the series palette as `--chart-*`,
 * the density (`data-density`, read by the cards and the grid gap). Charts
 * read their tokens from this element (`ChartThemeRoot`).
 */
export function DashboardSurface({
  theme,
  className,
  children,
  testId,
  tv = false,
}: {
  readonly theme: DashboardTheme;
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly testId?: string;
  /** (T813) TV mode: the surface covers the window. */
  readonly tv?: boolean;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const surface = useMemo(() => dashboardSurface(theme), [theme]);
  return (
    <div
      ref={setRoot}
      data-dashboard-theme={surface.mode}
      data-density={surface.density}
      style={surface.style}
      data-testid={testId}
      data-tv={tv ? '' : undefined}
      className={cn('group/dashboard flex min-h-full flex-col bg-canvas text-fg', className)}
    >
      <ChartThemeRoot.Provider value={root}>{children}</ChartThemeRoot.Provider>
    </div>
  );
}
