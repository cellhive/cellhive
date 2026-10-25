import { LoaderCircle } from 'lucide-react';

import { cn } from '../cn';

import type { ComponentProps } from 'react';

/** Decorative spinner; pair it with visible or `sr-only` text. */
export function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}
