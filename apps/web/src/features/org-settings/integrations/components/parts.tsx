import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;

/**
 * A tinted note with an icon — the recipe of the email settings and
 * incoming webhook notes (FRONTEND §15.3, §16.1), tokens only.
 */
export function Note({
  tone,
  icon,
  title,
  children,
  'data-testid': testId,
}: {
  readonly tone: 'neutral' | 'warning';
  readonly icon: ReactNode;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
}) {
  return (
    <div
      role="note"
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal text-fg',
        tone === 'neutral' && 'border-line bg-surface-sunken',
        tone === 'warning' && 'border-warning/50 bg-option-3',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex shrink-0 [&>svg]:size-4',
          tone === 'neutral' ? 'text-fg-muted' : 'text-warning',
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
 * A read-only secret in monospace with "Copy" (as FRONTEND §16.1): focus
 * selects it all, so Ctrl/⌘+C works where the Clipboard API does not;
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
  const { t } = useTranslation('orgIntegrations');
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

/** A confirmation (`alertdialog`): what changes, Cancel, and the action named on its button. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
  onCancel,
  'data-testid': testId,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly pending?: boolean;
  readonly error?: unknown;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('orgIntegrations');
  return (
    <Dialog
      open={open}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      closeLabel={t('page.close')}
    >
      <div className="flex flex-col gap-4" data-testid={testId}>
        {error === undefined || error === null ? null : <ErrorAlert error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t('page.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            data-testid={testId === undefined ? undefined : `${testId}-confirm`}
            onClick={onConfirm}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
