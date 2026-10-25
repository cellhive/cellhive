import { cn } from '../cn';

import type { ComponentProps } from 'react';

/** Framed panel: 8 px radius, hairline border, no shadow (FRONTEND §9.3). */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('rounded-lg border border-line bg-surface text-fg', className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-6 pt-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h1'>) {
  return <h1 className={cn('text-title text-fg', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-body text-fg-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-6 pt-4 pb-6', className)} {...props} />;
}
