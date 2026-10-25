import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../cn';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-label text-fg', className)} {...props} />;
}

/** Props to spread on the control of a {@link FormField}. */
export interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

export interface FormFieldProps {
  label: ReactNode;
  /** Translated error message; marks the control invalid. */
  error?: string | undefined;
  /** Translated help text shown under the control. */
  hint?: ReactNode;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + hint/error, wired with `htmlFor`, `aria-invalid` and
 * `aria-describedby` so screen readers announce the message with the field.
 */
export function FormField({ label, error, hint, className, children }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((value) => value !== null)
      .join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': error !== undefined, 'aria-describedby': describedBy })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="text-label font-normal text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
