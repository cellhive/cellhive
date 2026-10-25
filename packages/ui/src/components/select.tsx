import { ChevronDown } from 'lucide-react';

import { cn } from '../cn';

import type { ComponentProps } from 'react';

/**
 * Native `<select>` styled like `Input`: keyboard, screen readers and
 * mobile pickers work without a custom listbox.
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className={cn('relative w-full min-w-0', className)}>
      <select
        className={cn(
          // 16 px text below 1024 px: iOS Safari zooms into smaller fields (T322a).
          'h-control w-full min-w-0 appearance-none rounded-md border border-line-control bg-surface pr-8 pl-3 text-body text-fg max-lg:text-[16px]',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken aria-invalid:border-danger',
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted"
      />
    </div>
  );
}
