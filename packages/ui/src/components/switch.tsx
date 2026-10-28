import { cn } from '../cn';

import type { ComponentProps } from 'react';

export type SwitchProps = Omit<ComponentProps<'input'>, 'type' | 'role'>;

/**
 * An on/off switch for a setting that takes effect at once (NameThatUI
 * "Switch vs. Checkbox"): a native check box with the `switch` role over a
 * drawn track, so Space toggles it and screen readers say "on/off". Off, the
 * track is `--border-control` (≥ 3:1, WCAG 1.4.11); on, the accent. Give it
 * a name (`aria-label` or `aria-labelledby`, or wrap it in a `<label>`).
 * A value that waits for a "Save" / "Create" button is a check box instead.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <span className={cn('relative inline-flex h-5 w-9 shrink-0', className)}>
      <input
        type="checkbox"
        role="switch"
        // Over the track and past it (44 × 44 px, T322a): a tap lands on the switch itself.
        className="peer absolute -inset-x-1 -inset-y-3 m-0 cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none relative h-5 w-9 rounded-full bg-line-control transition-colors motion-reduce:transition-none',
          'peer-checked:bg-accent peer-disabled:opacity-60',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          'after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:transition-transform after:duration-(--motion-enter) after:ease-(--ease-enter) motion-reduce:after:transition-none',
          'peer-checked:after:translate-x-4',
        )}
      />
    </span>
  );
}
