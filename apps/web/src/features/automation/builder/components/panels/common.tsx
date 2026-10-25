import { cn } from '@cellhive/ui';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import { issuesAt, type BuilderIssue, type StepKey } from '../../model/issues';
import { useBuilderEnv } from '../env';
import { useIssueText } from '../issue-text';

/** Issues of a step at `path`, from the last check. */
export function useIssuesAt(step: StepKey, path: string): BuilderIssue[] {
  return issuesAt(useBuilderEnv().issues, step, path);
}

export function IssueText({
  id,
  issues,
}: {
  readonly id: string;
  readonly issues: readonly BuilderIssue[];
}) {
  const text = useIssueText();
  if (issues.length === 0) return null;
  return (
    <p id={id} className="flex items-start gap-1 text-label font-normal text-danger">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{issues.map(text).join(' ')}</span>
    </p>
  );
}

export interface PanelFieldProps {
  readonly label: ReactNode;
  readonly step: StepKey;
  /** Path of the value in the step: its issues show under the control. */
  readonly path: string;
  readonly hint?: ReactNode;
  readonly children: (control: {
    id: string;
    'aria-invalid': boolean | undefined;
    'aria-describedby': string | undefined;
  }) => ReactNode;
  /** A `<fieldset>` (radio groups, check lists) instead of a labelled control. */
  readonly group?: boolean;
}

/** Label + control + hint + issues of one setting of a panel (FormField with the builder's issues). */
export function PanelField({ label, step, path, hint, children, group = false }: PanelFieldProps) {
  const id = useId();
  const issues = useIssuesAt(step, path);
  const hintId = `${id}-hint`;
  const issueId = `${id}-issues`;
  const describedBy =
    [hint === undefined ? null : hintId, issues.length > 0 ? issueId : null]
      .filter((item) => item !== null)
      .join(' ') || undefined;
  const control = children({
    id,
    'aria-invalid': issues.length > 0 || undefined,
    'aria-describedby': describedBy,
  });
  const footer = (
    <>
      {hint === undefined ? null : (
        <p id={hintId} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
      )}
      <IssueText id={issueId} issues={issues} />
    </>
  );
  if (group) {
    return (
      <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy}>
        <legend className="mb-1.5 text-label text-fg">{label}</legend>
        {control}
        {footer}
      </fieldset>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-label text-fg">
        {label}
      </label>
      {control}
      {footer}
    </div>
  );
}

/** A note box of a panel: neutral (info), amber (warning), red (danger). */
export function Note({
  tone = 'info',
  title,
  children,
  testId,
}: {
  readonly tone?: 'info' | 'warning' | 'danger';
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
}) {
  const Icon = tone === 'info' ? Info : TriangleAlert;
  return (
    <div
      role="note"
      data-testid={testId}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal text-fg',
        tone === 'info' && 'border-line bg-surface-sunken',
        tone === 'warning' && 'border-warning/50 bg-option-3',
        tone === 'danger' && 'border-danger/40 bg-danger/5',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'info' && 'text-fg-muted',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title === undefined ? null : <strong className="font-semibold">{title}</strong>}
        {children === undefined ? null : <span className="leading-normal">{children}</span>}
      </div>
    </div>
  );
}

/** Radio group drawn as segments (board): native radios, ←/→ by the browser. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
  readonly onChange: (value: T) => void;
  readonly name?: string;
}) {
  const fallback = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex min-h-control max-w-full flex-wrap items-stretch gap-0.5 self-start rounded-md border border-line bg-surface-sunken p-0.5"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'inline-flex cursor-pointer items-center rounded-sm px-3 text-label font-normal text-fg-muted',
            'has-[:checked]:bg-surface has-[:checked]:font-medium has-[:checked]:text-fg has-[:checked]:shadow-sm',
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
            option.disabled === true && 'cursor-not-allowed opacity-60',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={name ?? fallback}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => {
              onChange(option.value);
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
