import { cn } from '@cellhive/ui';
import { useId, type ReactNode } from 'react';

/** A card of the email settings page (board "S5 · Admin email settings"). */
export function SettingsSection({
  title,
  description,
  badge,
  children,
  className,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  /** At the end of the title row (status badge). */
  readonly badge?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid': string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:px-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={headingId} className="text-heading">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="text-label font-normal text-fg-muted">{description}</p>
          )}
        </div>
        {badge === undefined ? null : <div className="ml-auto shrink-0">{badge}</div>}
      </div>
      {children}
    </section>
  );
}

/** Label/value rows: two columns from 640 px, stacked below. */
export function DefinitionGrid({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-body sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-y-2">
      {children}
    </dl>
  );
}

export function Definition({
  term,
  children,
  'data-testid': testId,
}: {
  readonly term: string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}) {
  return (
    <>
      <dt className="text-fg-muted max-sm:mt-2 max-sm:first:mt-0">{term}</dt>
      <dd className="min-w-0 break-words" data-testid={testId}>
        {children}
      </dd>
    </>
  );
}

/** A tinted note box (`role="note"`) with an icon: info, success, warning, danger. */
export function NoteBox({
  tone,
  icon,
  title,
  children,
  role = 'note',
  'data-testid': testId,
}: {
  readonly tone: 'neutral' | 'success' | 'warning' | 'danger';
  readonly icon: ReactNode;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly role?: 'note' | 'status' | 'alert';
  readonly 'data-testid'?: string;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal text-fg',
        tone === 'neutral' && 'border-line bg-surface-sunken',
        tone === 'success' && 'border-success/50 bg-surface',
        tone === 'warning' && 'border-warning/50 bg-option-3',
        tone === 'danger' && 'border-danger/60 bg-surface',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex shrink-0 [&>svg]:size-4',
          tone === 'neutral' && 'text-fg-muted',
          tone === 'success' && 'text-success',
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
