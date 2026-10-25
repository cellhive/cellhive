import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../cn';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  /** Visible label, clickable. */
  label: ReactNode;
  /** Help text under the label, announced with the checkbox. */
  hint?: ReactNode;
}

/**
 * Native checkbox with its label (and optional hint) wired for screen
 * readers. The box itself is drawn by the app's base styles (index.css:
 * `--border-control` when off, accent with a check mark when on).
 */
export function Checkbox({ label, hint, className, id, ...props }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={hint === undefined ? undefined : hintId}
        className="mt-0.5 size-4 shrink-0 disabled:cursor-not-allowed"
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={inputId} className="text-body text-fg">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={hintId} className="text-label font-normal text-fg-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
