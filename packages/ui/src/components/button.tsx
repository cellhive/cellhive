import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../cn';

import type { ComponentProps } from 'react';

/**
 * Buttons (shadcn/ui "button", restyled): 6 px radius, 32 px high (44 px on
 * touch-sized screens through `h-control`), one accent color. `toolbar` is
 * the size of the view and grid toolbars (13 px/400 text).
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap',
    'text-body transition-colors select-none motion-reduce:transition-none',
    'disabled:cursor-not-allowed disabled:opacity-60',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-sunken',
        ghost: 'text-fg hover:bg-surface-sunken',
        danger: 'bg-danger text-on-danger hover:bg-danger/90',
        link: 'h-auto px-0 text-accent underline-offset-4 hover:underline',
      },
      size: {
        md: 'h-control px-3',
        sm: 'h-7 px-2 text-label',
        /**
         * Toolbar buttons (FRONTEND §9.3, design "Grid - Tickets"): 32 px
         * high (44 px on touch-sized screens), body text 13 px/400; at least
         * as wide as high, so an icon-only one is a full touch target (T322a).
         */
        toolbar: 'h-control min-w-control gap-1.5 px-2 font-normal',
        icon: 'size-control',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Renders the child element (e.g. a router `Link`) with button styles. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return <Slot className={classes} {...props} />;
  }
  // Default to type="button" so a button never submits a form by accident.
  return <button type={type ?? 'button'} className={classes} {...props} />;
}
