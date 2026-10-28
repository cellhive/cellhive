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
        // A light band sweeps across (motion pass), steadier to look at than a blink.
        'rounded-md bg-surface-sunken bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-surface)_60%,transparent),transparent)] bg-size-[50%_100%] bg-no-repeat motion-safe:animate-shimmer',
        className,
      )}
      {...props}
    />
  );
}
