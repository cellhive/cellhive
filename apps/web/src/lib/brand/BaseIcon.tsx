import { cn } from '@cellhive/ui';
import {
  Briefcase,
  Building2,
  CalendarDays,
  ClipboardList,
  Database,
  GraduationCap,
  Headset,
  HeartPulse,
  Megaphone,
  Package,
  Rocket,
  ShoppingCart,
  Table2,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * A base's tile: a glyph on one of the eight solid `--avatar-N` colors, like
 * the app icons of Lark Base. `bases.icon` (a free string, CONTRACTS §5A)
 * holds `"<glyph>:<color>"`, e.g. `"support:5"`; a base without one (or with
 * a value another client wrote) gets the database glyph and a color picked
 * from its ID, so the home page is colorful before anyone chooses.
 */
export const BASE_GLYPHS = {
  database: Database,
  table: Table2,
  tasks: ClipboardList,
  users: Users,
  support: Headset,
  cart: ShoppingCart,
  package: Package,
  truck: Truck,
  wallet: Wallet,
  briefcase: Briefcase,
  calendar: CalendarDays,
  megaphone: Megaphone,
  rocket: Rocket,
  school: GraduationCap,
  health: HeartPulse,
  building: Building2,
} as const satisfies Record<string, LucideIcon>;

export type BaseGlyph = keyof typeof BASE_GLYPHS;

/** The `--avatar-N` colors (tokens.css): white glyphs read on all of them. */
export const BASE_COLOR_COUNT = 8;

export interface BaseLook {
  readonly glyph: BaseGlyph;
  readonly color: number;
}

/** Color 1–7 from the ID (0, the gray, is left for a choice). */
function colorOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 1 + (hash % (BASE_COLOR_COUNT - 1));
}

export function baseLook(base: { readonly id: string; readonly icon: string | null }): BaseLook {
  const match = /^([a-z]+):([0-9])$/u.exec(base.icon ?? '');
  const glyph = match?.[1];
  const color = Number(match?.[2]);
  if (glyph !== undefined && glyph in BASE_GLYPHS && color < BASE_COLOR_COUNT) {
    return { glyph: glyph as BaseGlyph, color };
  }
  return { glyph: 'database', color: colorOf(base.id) };
}

export function baseIconValue(look: BaseLook): string {
  return `${look.glyph}:${String(look.color)}`;
}

const SIZES = {
  sm: 'size-5 rounded-[5px] [&_svg]:size-3',
  md: 'size-8 rounded-md [&_svg]:size-4',
  lg: 'size-12 rounded-lg [&_svg]:size-6',
} as const;

export function BaseIcon({
  base,
  look = baseLook(base),
  size = 'md',
  className,
}: {
  readonly base: { readonly id: string; readonly icon: string | null };
  readonly look?: BaseLook;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}) {
  const Glyph = BASE_GLYPHS[look.glyph];
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-on-avatar',
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: `var(--avatar-${String(look.color)})` }}
    >
      <Glyph />
    </span>
  );
}
