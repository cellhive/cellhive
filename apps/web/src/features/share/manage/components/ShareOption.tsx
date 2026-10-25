import { cn, Switch } from '@cellhive/ui';
import { useId, type ChangeEvent, type ReactNode } from 'react';

export interface ShareOptionProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /**
   * `switch`: the change takes effect at once (an existing link);
   * `checkbox`: a value applied later by a button ("Create link", "Save").
   * NameThatUI "Switch vs. Checkbox"; T322b.
   */
  readonly control: 'switch' | 'checkbox';
  /** Shown under the label while the option is on (a password, a date). */
  readonly children?: ReactNode;
  readonly className?: string | undefined;
}

/**
 * An on/off option of the share dialog (design "Link chia sẻ"): a native
 * check box — with the `switch` role when the change applies at once — so
 * it works with the keyboard (Space) and screen readers announce it right.
 * Off, the box and the track reach 3:1 (`--border-control`, WCAG 1.4.11).
 */
export function ShareOption({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
  control,
  children,
  className,
}: ShareOptionProps) {
  const id = useId();
  const isSwitch = control === 'switch';
  return (
    <div
      className={cn(
        'flex min-h-13 flex-col justify-center gap-2 border-b border-line py-2',
        className,
      )}
    >
      <label htmlFor={id} className="relative flex cursor-pointer items-start gap-3">
        {isSwitch ? (
          <Switch
            id={id}
            checked={checked}
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={hint === undefined ? undefined : `${id}-hint`}
            onChange={onChange}
            className="mt-0.5"
          />
        ) : (
          // Box drawn by the base styles (index.css); aligned with the first text line.
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={hint === undefined ? undefined : `${id}-hint`}
            onChange={onChange}
            className="mt-0.5"
          />
        )}
        <span className="flex min-w-0 flex-col leading-snug">
          <span id={`${id}-label`} className="font-medium text-fg">
            {label}
          </span>
          {hint === undefined ? null : (
            <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
              {hint}
            </span>
          )}
        </span>
      </label>
      {checked && children !== undefined ? (
        <div className={isSwitch ? 'pl-12' : 'pl-7'}>{children}</div>
      ) : null}
    </div>
  );
}
