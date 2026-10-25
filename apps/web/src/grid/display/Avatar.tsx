import { cn } from '@cellhive/ui';

import { paletteIndexOf } from './text';

import type { ReactNode } from 'react';

/** Solid avatar colors (`--avatar-N`), listed in full so that Tailwind keeps them. */
const AVATAR_COLORS = [
  'bg-avatar-0',
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
  'bg-avatar-7',
] as const;

/**
 * No text below 12 px (T322b), medium weight (T420: two initials fit with
 * room around them). `md` is a user value's avatar, the grid canvas draws
 * the same circle (`grid/customCells/avatar`); `sm` only in dense lists.
 */
const SIZES = {
  sm: 'size-5 text-label leading-none tracking-tight',
  md: 'size-6 text-label leading-none',
  lg: 'size-7 text-label leading-none',
} as const;

export interface AvatarProps {
  /** Id that picks the color (`usr_…`); `null` → the neutral color. */
  readonly colorKey: string | null;
  /** Initials or an icon. */
  readonly children: ReactNode;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}

/**
 * A user (or source) avatar in the DOM (design boards, FRONTEND §9.3): a
 * solid circle of one of eight token colors with white initials. Decorative:
 * the name is always written next to it.
 */
export function Avatar({ colorKey, children, size = 'sm', className }: AvatarProps) {
  const color = AVATAR_COLORS[colorKey === null ? 0 : paletteIndexOf(colorKey)];
  return (
    <span
      aria-hidden="true"
      data-avatar-color={colorKey === null ? 0 : paletteIndexOf(colorKey)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-on-avatar',
        SIZES[size],
        color,
        className,
      )}
    >
      {children}
    </span>
  );
}
