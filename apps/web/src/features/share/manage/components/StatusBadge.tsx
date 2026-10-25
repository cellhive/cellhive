import { cn } from '@cellhive/ui';
import { CircleCheck, CircleOff, Clock, ShieldBan } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ShareLinkStatus } from '@cellhive/contracts';

const ICONS = {
  active: CircleCheck,
  disabled: CircleOff,
  expired: Clock,
  blocked: ShieldBan,
} as const;

/** Status of a link as icon + text (never color alone, FRONTEND §9.2). */
export function StatusBadge({ status }: { status: ShareLinkStatus }) {
  const { t } = useTranslation('share');
  const Icon = ICONS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-label whitespace-nowrap',
        status === 'active' ? 'border-success text-fg' : 'border-line-strong text-fg-muted',
        status === 'blocked' && 'border-danger text-fg',
      )}
      data-status={status}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5',
          status === 'active' && 'text-success',
          status === 'blocked' && 'text-danger',
        )}
      />
      {t(`status.${status}`)}
    </span>
  );
}
