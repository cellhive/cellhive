import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';

import { cn } from '../cn';

import type { ComponentProps } from 'react';

const alertVariants = cva(
  'flex gap-2 rounded-md border bg-surface px-3 py-2 text-body text-fg [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        danger: 'border-danger [&>svg]:text-danger',
        success: 'border-success [&>svg]:text-success',
        info: 'border-line-strong [&>svg]:text-fg-muted',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

export type AlertProps = ComponentProps<'div'> & VariantProps<typeof alertVariants>;

/**
 * Inline message. Color is never the only signal: every variant has its own
 * icon, and errors are announced (`role="alert"`), others politely.
 */
export function Alert({ className, variant, children, role, ...props }: AlertProps) {
  const Icon = variant === 'danger' ? CircleAlert : variant === 'success' ? CircleCheck : Info;
  return (
    <div
      role={role ?? (variant === 'danger' ? 'alert' : 'status')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}
