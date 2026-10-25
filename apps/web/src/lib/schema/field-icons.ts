import {
  Calendar,
  CalendarClock,
  CalendarPlus,
  CircleChevronDown,
  CircleHelp,
  Hash,
  Link2,
  ListOrdered,
  MousePointerClick,
  Paperclip,
  Sigma,
  SquareCheck,
  TextSearch,
  Type,
  User,
  UserPen,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';

import type { S1FieldType } from '@cellhive/field-types';

/** The icon of each field type (field dialog, hide-fields panel); `attachment` from T418. */
export const TYPE_ICONS: Readonly<Record<S1FieldType | 'attachment', LucideIcon>> = {
  text: Type,
  number: Hash,
  select: CircleChevronDown,
  datetime: Calendar,
  checkbox: SquareCheck,
  user: User,
  created_at: CalendarPlus,
  updated_at: CalendarClock,
  created_by: UserPlus,
  updated_by: UserPen,
  auto_number: ListOrdered,
  attachment: Paperclip,
};

/** The icon of a field type, a neutral one for types this client does not know. */
export function typeIconOf(type: string): LucideIcon {
  // Link (T413): the chain of the column header (`grid/columns.ts`).
  if (type === 'link') return Link2;
  // Formula (T466): the sigma of the column header (`grid/columns.ts`).
  if (type === 'formula') return Sigma;
  // Lookup (T467): a value found in another table.
  if (type === 'lookup') return TextSearch;
  // Button (T525): the pointer of the column header (`grid/columns.ts`).
  if (type === 'button') return MousePointerClick;
  return (TYPE_ICONS as Readonly<Record<string, LucideIcon | undefined>>)[type] ?? CircleHelp;
}
