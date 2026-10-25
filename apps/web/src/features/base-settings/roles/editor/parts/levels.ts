import { Ban, Eye, EyeOff, FilePlus, Pencil, Settings2, type LucideIcon } from 'lucide-react';

import {
  FIELD_LEVELS,
  fieldLevelBlock,
  TABLE_LEVELS,
  tableLevelBlock,
  type BlockReason,
} from '../model';

import type { SegmentOption } from './Segmented';
import type { RoleKind } from '@cellhive/contracts';
import type { FieldPerm, TablePerm } from '@cellhive/permissions';
import type { TFunction } from 'i18next';

/** Icons of the levels: never colour alone (S6-research §4 #1). */
const TABLE_ICONS: Record<TablePerm, LucideIcon> = {
  manage: Settings2,
  edit: Pencil,
  read_only: Eye,
  no_perm: Ban,
};

const FIELD_ICONS: Record<FieldPerm, LucideIcon> = {
  edit: Pencil,
  create: FilePlus,
  read: Eye,
  no_perm: EyeOff,
};

export function blockText(
  t: TFunction<'baseSettings'>,
  reason: BlockReason | null,
): string | undefined {
  return reason === null ? undefined : t(`editor.blocked.${reason}`);
}

/** The four table levels of a role kind, those above its ceiling with their reason. */
export function tableLevelOptions(
  t: TFunction<'baseSettings'>,
  kind: RoleKind,
): SegmentOption<TablePerm>[] {
  return TABLE_LEVELS.map((level) => ({
    value: level,
    label: t(`editor.tableLevels.${level}`),
    icon: TABLE_ICONS[level],
    // The read-only admin role: the whole group is off, no reason per option.
    blocked: kind === 'system_admin' ? undefined : blockText(t, tableLevelBlock(kind, level)),
  }));
}

/** The four field levels on a table at `perm`. */
export function fieldLevelOptions(
  t: TFunction<'baseSettings'>,
  kind: RoleKind,
  perm: TablePerm,
): SegmentOption<FieldPerm>[] {
  return FIELD_LEVELS.map((level) => ({
    value: level,
    label: t(`editor.fieldLevels.${level}`),
    icon: FIELD_ICONS[level],
    blocked:
      kind === 'system_admin' || perm === 'no_perm'
        ? undefined
        : blockText(t, fieldLevelBlock(kind, perm, level)),
  }));
}
