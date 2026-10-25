import { Button, cn } from '@cellhive/ui';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequestId } from '../errors/RequestId';
import { translateError } from '../errors/translate';

import { dismissToast, useToasts, type Toast } from './toast';

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
} as const;

const ICON_COLOR = {
  info: 'text-fg-muted',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
} as const;

function ToastItem({ toast }: { toast: Toast }) {
  const { t, i18n } = useTranslation('common');
  const [paused, setPaused] = useState(false);
  const { id, durationMs } = toast;

  // Auto-dismiss, paused while hovered or focused (WCAG 2.2.1, 2.2.2).
  useEffect(() => {
    if (durationMs === null || paused) return;
    const timer = window.setTimeout(() => {
      dismissToast(id);
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [id, durationMs, paused]);

  const translated = toast.error === undefined ? undefined : translateError(toast.error, i18n);
  const message = toast.message ?? translated?.message;
  const details = translated?.details ?? [];
  const Icon = ICONS[toast.variant];
  const pause = () => {
    setPaused(true);
  };
  const resume = () => {
    setPaused(false);
  };

  return (
    <li className="pointer-events-auto">
      <div
        // Errors interrupt; the rest is announced politely.
        role={toast.variant === 'error' ? 'alert' : 'status'}
        className="flex w-full animate-pop-in gap-2 rounded-lg border border-line bg-surface p-3 text-body text-fg shadow-popover"
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocus={pause}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) resume();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') dismissToast(id);
        }}
      >
        <Icon
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0', ICON_COLOR[toast.variant])}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {toast.title === undefined ? null : <p className="font-medium">{toast.title}</p>}
          {message === undefined ? null : <p>{message}</p>}
          {toast.details.length > 0 ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
              {toast.details.map((detail) => (
                <div key={detail.label} className="contents">
                  <dt className="text-fg-muted">{detail.label}</dt>
                  <dd className="line-clamp-2 font-medium break-words" title={detail.value}>
                    {detail.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {details.length > 0 ? (
            <ul className="list-disc pl-4 text-fg-muted">
              {details.map((detail) => (
                <li key={`${detail.path}:${detail.message}`}>{detail.message}</li>
              ))}
            </ul>
          ) : null}
          {toast.progress === null ? null : (
            <div
              role="progressbar"
              aria-label={message}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(toast.progress * 100)}
              className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
            >
              <div
                className="h-full bg-accent transition-[width] motion-reduce:transition-none"
                style={{ width: `${String(Math.round(toast.progress * 100))}%` }}
              />
            </div>
          )}
          {translated?.requestId === undefined ? null : (
            <RequestId requestId={translated.requestId} compact />
          )}
          {toast.actions.length > 0 ? (
            // Right-aligned, the recommended (primary) action last (design "Grid - Tickets").
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {toast.actions.map((action) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.primary === true ? 'primary' : 'secondary'}
                  onClick={() => {
                    action.onClick();
                    dismissToast(id);
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mt-1 -mr-1 shrink-0"
          aria-label={t('toast.dismiss')}
          onClick={() => {
            dismissToast(id);
          }}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/**
 * Where toasts appear (FRONTEND §8.1), bottom right, newest last. Styled
 * with classes only (strict CSP, FRONTEND §12); each toast is a live region
 * and can be dismissed with its button or Escape.
 */
export function Toaster() {
  const { t } = useTranslation('common');
  const toasts = useToasts();
  return (
    <section
      aria-label={t('toast.region')}
      className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col p-4"
    >
      <ol className="flex flex-col gap-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} />
        ))}
      </ol>
    </section>
  );
}
