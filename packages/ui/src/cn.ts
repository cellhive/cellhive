import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The font-size scale of the design tokens (FRONTEND §9.3). Without it,
 * tailwind-merge cannot tell `text-body` (size) from `text-fg` (color) and
 * would drop one of them.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['title', 'heading', 'body', 'label', 'mono'],
    },
  },
});

/** Joins class names; later Tailwind utilities override conflicting earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
