import { cn } from '../cn';

import type { ComponentProps } from 'react';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type ?? 'text'}
      className={cn(
        // 16 px text below 1024 px: iOS Safari zooms into smaller fields (T322a).
        'h-control w-full min-w-0 rounded-md border border-line-control bg-surface px-3 text-body text-fg max-lg:text-[16px]',
        'placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-sunken',
        'aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}
