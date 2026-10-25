import { cn, Tooltip } from '@cellhive/ui';
import { Lock, type LucideIcon } from 'lucide-react';
import { useId, useRef, type KeyboardEvent } from 'react';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Why the option cannot be picked (shown to assistive technology and as a tooltip), else `undefined`. */
  readonly blocked?: string | undefined;
}

export interface SegmentedProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentOption<T>[];
  readonly onChange: (value: T) => void;
  /** Every option off (a read-only role). */
  readonly disabled?: boolean | undefined;
  /** Ids of text describing the whole group (adjustment reasons, hints). */
  readonly describedBy?: string | undefined;
  readonly className?: string | undefined;
  /**
   * Labels are never cut: they count in the group's intrinsic width, so a
   * shrink-to-fit container (a `w-0` table cell) grows to them, and wrap
   * between words when even that is too narrow (T720). Off, a label stays on
   * one line and truncates with an ellipsis when the group is narrower.
   */
  readonly fit?: boolean | undefined;
  readonly 'data-testid'?: string;
}

/**
 * A segmented `radiogroup` (WAI-ARIA radio pattern; S6-research §4 #1, #2):
 * text and an icon in each segment, the chosen one filled — never colour
 * alone. One tab stop (the chosen segment); arrow keys move and choose,
 * skipping options that are off; Home/End go to the first/last one.
 * Options above the role's ceiling stay visible with a lock and their reason.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  describedBy,
  className,
  fit = false,
  'data-testid': testId,
}: SegmentedProps<T>) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (index: number) => !disabled && options[index]?.blocked === undefined;
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const focusable =
    enabled(current) || disabled ? current : options.findIndex((_, index) => enabled(index));

  const move = (from: number, step: 1 | -1) => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + step * offset + options.length) % options.length;
      if (enabled(index)) return index;
    }
    return from;
  };
  const pick = (index: number) => {
    const option = options[index];
    if (option === undefined || !enabled(index)) return;
    refs.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = move(index, 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = move(index, -1);
    else if (event.key === 'Home') next = move(-1 + options.length, 1);
    else if (event.key === 'End') next = move(0, -1);
    if (next === null) return;
    event.preventDefault();
    pick(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn(
        'grid w-full min-w-0 grid-cols-2 gap-px overflow-hidden rounded-md border border-line-control bg-line sm:grid-cols-4',
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const off = !enabled(index);
        const Icon = off && option.blocked !== undefined ? Lock : option.icon;
        const button = (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={off || undefined}
            aria-describedby={option.blocked === undefined ? undefined : `${id}-${String(index)}`}
            tabIndex={index === focusable ? 0 : -1}
            data-value={option.value}
            className={cn(
              'flex min-h-control items-center justify-center gap-1.5 px-2 text-label transition-colors',
              // `fit`: a label wraps between words only when the room is short (375 px).
              fit ? 'py-1 text-center leading-tight' : 'min-w-0 whitespace-nowrap',
              'focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
              checked
                ? 'bg-accent font-semibold text-on-accent'
                : off
                  ? 'cursor-not-allowed bg-surface-sunken text-fg-subtle'
                  : 'text-fg hover:bg-surface-sunken',
            )}
            onClick={() => {
              pick(index);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className={fit ? undefined : 'truncate'}>{option.label}</span>
          </button>
        );
        // The reason of an option above the ceiling shows on hover too.
        return option.blocked === undefined ? (
          button
        ) : (
          <Tooltip key={option.value} content={option.blocked}>
            {button}
          </Tooltip>
        );
      })}
      {/* Reasons of the options that are off: descriptions (hidden text still describes). */}
      {options.map((option, index) =>
        option.blocked === undefined ? null : (
          <span key={option.value} id={`${id}-${String(index)}`} hidden>
            {option.blocked}
          </span>
        ),
      )}
    </div>
  );
}
