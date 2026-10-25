import { cn } from '@cellhive/ui';
import { CircleAlert, CircleCheck, CirclePause, Clock, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { EmailIdentityStatus } from '@cellhive/contracts';
import type { ReactNode } from 'react';

const STATUS_STYLE: Record<EmailIdentityStatus, { icon: typeof Clock; className: string }> = {
  verified: { icon: CircleCheck, className: 'bg-option-2 text-on-option-2' },
  pending: { icon: Clock, className: 'bg-option-3 text-on-option-3' },
  error: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
  disabled: { icon: CirclePause, className: 'bg-option-0 text-on-option-0' },
};

/** Status of an identity: icon + word, never color alone (FRONTEND §9.2). */
export function StatusBadge({ status }: { readonly status: EmailIdentityStatus }) {
  const { t } = useTranslation('emailIdentities');
  const { icon: Icon, className } = STATUS_STYLE[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`status.${status}`)}
    </span>
  );
}

type Tone = 'info' | 'warning' | 'danger' | 'success';

const TONES: Record<Tone, { icon: typeof Info; box: string; iconClass: string }> = {
  info: { icon: Info, box: 'border-line bg-surface-sunken', iconClass: 'text-fg-muted' },
  warning: {
    icon: TriangleAlert,
    box: 'border-warning/50 bg-option-3',
    iconClass: 'text-on-option-3',
  },
  danger: { icon: CircleAlert, box: 'border-danger/40 bg-danger/5', iconClass: 'text-danger' },
  success: {
    icon: CircleCheck,
    box: 'border-success/40 bg-option-2',
    iconClass: 'text-on-option-2',
  },
};

/** A boxed note of the identity screens (board "S5 · Email identities"): icon, title, text. */
export function Note({
  tone,
  title,
  children,
  role,
  className,
  'data-testid': testId,
}: {
  readonly tone: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly role?: 'note' | 'status' | 'alert';
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  const { icon: Icon, box, iconClass } = TONES[tone];
  return (
    <div
      role={role ?? 'note'}
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label text-fg',
        box,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-px size-4 shrink-0', iconClass)} />
      <div className="flex min-w-0 flex-col gap-1 leading-normal">
        {title === undefined ? null : <strong className="font-semibold">{title}</strong>}
        {children}
      </div>
    </div>
  );
}
