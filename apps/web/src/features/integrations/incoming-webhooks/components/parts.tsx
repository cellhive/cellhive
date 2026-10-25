import { Button, cn } from '@cellhive/ui';
import { Check, CircleCheck, CirclePause, Copy, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { IncomingWebhookAuth } from '@cellhive/contracts';

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;

/**
 * A tinted note (`role="note"` unless told otherwise) with an icon — the
 * recipe of the email settings notes (FRONTEND §15.3), tokens only.
 */
export function Note({
  tone,
  icon,
  title,
  children,
  role = 'note',
  className,
  'data-testid': testId,
}: {
  readonly tone: 'neutral' | 'warning' | 'danger';
  readonly icon: ReactNode;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly role?: 'note' | 'status' | 'alert';
  readonly className?: string;
  readonly 'data-testid'?: string;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal text-fg',
        tone === 'neutral' && 'border-line bg-surface-sunken',
        tone === 'warning' && 'border-warning/50 bg-option-3',
        tone === 'danger' && 'border-danger/60 bg-surface',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex shrink-0 [&>svg]:size-4',
          tone === 'neutral' && 'text-fg-muted',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        {title === undefined ? null : <strong className="font-semibold">{title}</strong>}
        {children === undefined ? null : <div className="leading-relaxed">{children}</div>}
      </div>
    </div>
  );
}

/**
 * A read-only value (URL, secret) in monospace with a "Copy" button. The
 * value is selectable text in a read-only input (focus selects it all, so
 * Ctrl/⌘+C works where the Clipboard API does not — non-HTTPS origins);
 * "Copied" is announced through a polite live region.
 */
export function CopyField({
  label,
  value,
  hint,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: ReactNode;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('incomingWebhooks');
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-fg">
        {label}
      </label>
      <div className="flex min-w-0 gap-2">
        <input
          id={id}
          readOnly
          value={value}
          spellCheck={false}
          autoComplete="off"
          data-testid={testId}
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          className="h-control min-w-0 flex-1 rounded-md border border-line-control bg-surface-sunken px-2 font-mono text-mono text-fg max-lg:text-[16px]"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <Button
          variant="secondary"
          aria-label={t('copy.label', { label })}
          data-testid={testId === undefined ? undefined : `${testId}-copy`}
          onClick={() => {
            // The Clipboard API exists only in secure contexts (HTTPS or localhost).
            if (!('clipboard' in navigator)) return;
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
              },
              () => undefined,
            );
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span className="max-sm:sr-only">{copied ? t('copy.done') : t('copy.action')}</span>
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? t('copy.announce', { label }) : ''}
      </span>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/** "Receiving" / "Paused": icon and text, never color alone. */
export function StatusBadge({ enabled }: { readonly enabled: boolean }) {
  const { t } = useTranslation('incomingWebhooks');
  return (
    <span
      data-testid="hook-status"
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        enabled ? 'bg-accent-soft text-accent' : 'bg-surface-sunken text-fg-muted',
      )}
    >
      {enabled ? (
        <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      {t(enabled ? 'status.on' : 'status.off')}
    </span>
  );
}

/** The checks of the public route; `none` is flagged as a warning. */
export function AuthBadge({ auth }: { readonly auth: IncomingWebhookAuth }) {
  const { t } = useTranslation('incomingWebhooks');
  const open = auth === 'none';
  return (
    <span
      data-testid="hook-auth"
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-label font-medium whitespace-nowrap',
        open ? 'bg-option-3 text-fg' : 'bg-surface-sunken text-fg',
      )}
    >
      {open ? (
        <ShieldAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      ) : (
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      )}
      {t(`auth.short.${auth}`)}
    </span>
  );
}
