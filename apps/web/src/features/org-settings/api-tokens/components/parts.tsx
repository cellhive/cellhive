import { Button, cn } from '@cellhive/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;

/** A tinted note with an icon (the recipe of FRONTEND §15.1 / §15.5), tokens only. */
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
 * A read-only value in monospace with "Copy": focus selects it all, so
 * Ctrl/⌘+C works where the Clipboard API does not; "Copied" is announced
 * through a `role="status"` live region. `multiline` shows a wrapped
 * `<textarea>` of `rows` lines (the curl example, MCP configurations).
 */
export function CopyField({
  label,
  value,
  hint,
  multiline = false,
  rows = 3,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: ReactNode;
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('apiTokens');
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
  const shared = {
    id,
    readOnly: true,
    value,
    spellCheck: false,
    autoComplete: 'off',
    'data-testid': testId,
    'aria-describedby': hint === undefined ? undefined : `${id}-hint`,
    onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      event.currentTarget.select();
    },
  };
  const box =
    'min-w-0 flex-1 rounded-md border border-line-control bg-surface-sunken px-2 font-mono text-mono text-fg max-lg:text-[16px]';
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-fg">
        {label}
      </label>
      <div className="flex min-w-0 items-start gap-2">
        {multiline ? (
          // Lines of their own (JSON): scroll sideways rather than break a key mid-word.
          <textarea
            {...shared}
            rows={rows}
            wrap={value.includes('\n') ? 'off' : 'soft'}
            className={cn(
              box,
              'resize-none py-1.5',
              value.includes('\n') ? 'overflow-x-auto whitespace-pre' : 'break-all',
            )}
          />
        ) : (
          <input {...shared} className={cn(box, 'h-control')} />
        )}
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
      <span
        role="status"
        className="sr-only"
        data-testid={testId === undefined ? undefined : `${testId}-status`}
      >
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

/** A section card of the page: heading, intro, optional action, body. */
export function Section({
  title,
  intro,
  action,
  children,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly intro?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h2 id={`${id}-title`} className="text-heading">
            {title}
          </h2>
          {intro === undefined ? null : (
            <p className="max-w-[70ch] text-body text-fg-muted">{intro}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
