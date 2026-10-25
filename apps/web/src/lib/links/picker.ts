import type { LinkRef } from './values';
import type { AnchorRect } from '../records/detail';
import type { EffectiveAccess, FieldDto } from '@cellhive/contracts';
import type { LinkOptions, LocaleContext } from '@cellhive/field-types';
import type { ComponentType } from 'react';

/**
 * The link picker and the linked-record hover card (T413, `features/link`),
 * lazy components the route gives the grid page, which hands the picker on
 * to the record panel. Features do not import each other (FRONTEND §1.2):
 * they talk through these types only.
 */

/** Where the picker is opened from, and what it edits. */
export interface LinkPickerProps {
  /** Rights of the base: adding records to the linked table, required fields on creation. */
  readonly access: EffectiveAccess | null | undefined;
  /** Base of the field (the linked table's name comes from its table list). */
  readonly baseId: string;
  readonly orgId: string;
  /** The signed-in user ("Recent" is kept per user). */
  readonly userId: string | null;
  /** The link field (its `link-candidates`), its options parsed. */
  readonly field: FieldDto;
  readonly options: LinkOptions;
  /** The record whose cell is edited; `null` for a record not created yet. */
  readonly recordId: string | null;
  /** What the record is called in the header ("Order DH-2609-142"). */
  readonly recordLabel: string;
  /** Linked records now in the cell, in link order. */
  readonly value: readonly LinkRef[];
  /**
   * The cell the single-link popover opens under (screen rectangle);
   * `null`: no anchor, the dialog form is used.
   */
  readonly anchor: AnchorRect | null;
  /** Text typed on the cell: the search starts with it. */
  readonly initialSearch?: string | undefined;
  /** Below 768 px: the picker covers the screen (board "Chọn bản ghi liên kết" mobile). */
  readonly fullScreen: boolean;
  readonly locale: LocaleContext;
  /** The new list of linked records (the caller writes it: optimistic, undo, errors). */
  readonly onCommit: (value: readonly LinkRef[]) => void;
  /** Closed (after a commit or cancelled); the caller gives the focus back to the cell. */
  readonly onClose: () => void;
}

/** The hover card of a linked record (board "Ô liên kết trong grid"). */
export interface LinkHoverCardProps {
  readonly baseId: string;
  readonly field: FieldDto;
  readonly options: LinkOptions;
  /** The linked record shown. */
  readonly recordId: string;
  /** Screen rectangle of the chip; the card opens under it. */
  readonly anchor: AnchorRect;
  readonly locale: LocaleContext;
  /** "Unlink": present when the user may change the cell. */
  readonly onUnlink?: (() => void) | undefined;
  /** The pointer is on the card: it stays open. */
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onClose: () => void;
}

/** The lazily loaded components the route gives the grid page. */
export interface LinkComponents {
  readonly Picker: ComponentType<LinkPickerProps>;
  readonly HoverCard: ComponentType<LinkHoverCardProps>;
  /** Loads the chunk ahead (a grid with link columns): the picker then opens at once. */
  readonly preload?: () => void;
}
