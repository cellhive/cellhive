import { Button } from '@cellhive/ui';
import { BarChart3, Lock, RefreshCw, TriangleAlert, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ReactNode } from 'react';

export type WidgetMessageKind = 'empty' | 'no_permission' | 'broken' | 'error';

const ICONS = {
  empty: BarChart3,
  no_permission: Lock,
  broken: Unplug,
  error: TriangleAlert,
} as const;

/**
 * A widget without numbers to show (T811, research §5.2): empty (with what
 * filters apply), no permission (one neutral sentence — never which
 * field), broken (how to fix it only for admins), failed or timed out
 * ("Try again"). An icon and text: the state never relies on color.
 */
export function WidgetMessage({
  kind,
  title,
  detail,
  onRetry,
  testId,
}: {
  readonly kind: WidgetMessageKind;
  readonly title: string;
  readonly detail?: ReactNode;
  readonly onRetry?: (() => void) | undefined;
  readonly testId?: string;
}) {
  const { t } = useTranslation('dashboard');
  const Icon = ICONS[kind];
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-2 p-2 text-center"
      data-testid={testId}
      data-state={kind}
    >
      <Icon aria-hidden="true" className="size-6 shrink-0 text-fg-muted" />
      <p className="text-body font-medium text-fg">{title}</p>
      {detail === undefined ? null : (
        <p className="max-w-sm text-label font-normal text-fg-muted">{detail}</p>
      )}
      {onRetry === undefined ? null : (
        <Button size="sm" variant="secondary" className="max-lg:h-control" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t('state.retry')}
        </Button>
      )}
    </div>
  );
}
