import type { AttachmentCellEditorProps } from '../../lib/attachments/ui';
import type { UploadHost } from '../../lib/attachments/uploads';
import type { CellFile } from '../../lib/attachments/value';
import type { FieldDto } from '@cellhive/contracts';
import type { FieldConfig, LocaleContext } from '@cellhive/field-types';
import type { ComponentType } from 'react';

/** Where the selection goes after a commit: `[columns, rows]` (Enter = down, Tab = right). */
export type EditorMove = readonly [-1 | 0 | 1, -1 | 0 | 1];

export const MOVE_NONE: EditorMove = [0, 0];
export const MOVE_DOWN: EditorMove = [0, 1];
export const MOVE_RIGHT: EditorMove = [1, 0];
export const MOVE_LEFT: EditorMove = [-1, 0];

/**
 * A value ready to be written (FRONTEND §4.1): `value` in the json write
 * shape of CONTRACTS §2, `display` in the read shape (what the cell shows
 * optimistically), `typecast` when the server has to read the value (a
 * select option that does not exist yet).
 */
export interface EditorCommit {
  readonly value: unknown;
  readonly display: unknown;
  readonly typecast: boolean;
}

/** Why a typed value cannot be written: a `field-types` issue code (`errors:detail.<code>`). */
export interface EditorIssue {
  readonly code: string;
  readonly message?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The editor content as it stands: a value to write, or the reason it cannot be written. */
export type EditorDraft =
  | { readonly ok: true; readonly commit: EditorCommit }
  | { readonly ok: false; readonly issue: EditorIssue };

/** A member of the organization offered by the user picker. */
export interface MemberOption {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Attachment cells of the grid (T418): the popover comes from
 * `features/attachment` (lazy, handed down by the route); files are written
 * through the page's edit flow as they finish uploading, so the popover
 * reads the cell live instead of the value it opened with.
 */
export interface FileEditorContext {
  readonly tableId: string;
  /** The popover (`AttachmentUi.CellEditor`); absent: attachment cells open nothing. */
  readonly Editor: ComponentType<AttachmentCellEditorProps> | undefined;
  /** `file_download_fields` of the user (CONTRACTS §5A). */
  readonly canDownload: (fieldId: string) => boolean;
  /** Current value of a cell, and a subscription to its changes (the grid's rows). */
  readonly read: (recordId: string, fieldId: string) => unknown;
  readonly subscribe: (listener: () => void) => () => void;
  /** Writes a cell (FRONTEND §4.1). */
  readonly write: (recordId: string, fieldId: string, files: readonly CellFile[]) => void;
  /** Appends finished uploads to a cell. */
  readonly host: (recordId: string, fieldId: string) => UploadHost;
  /** Title of a record (primary field), for the lightbox. */
  readonly recordTitle: (recordId: string) => string;
}

/** What editors need besides the cell: locale, organization, option rights. */
export interface EditorContext {
  /** Locale and time zone of the user: numbers and dates are typed in them. */
  readonly locale: LocaleContext;
  /** Organization of the base: its members fill the user picker. */
  readonly orgId: string;
  /** Whether typing a new select option may create it (`option_edit_fields`, CONTRACTS §5A). */
  readonly canCreateOption: (fieldId: string) => boolean;
  /** Attachment cells (T418); absent: they cannot be opened. */
  readonly files?: FileEditorContext | undefined;
}

/** Props shared by every overlay editor (`grid/editors/<type>.tsx`). */
export interface CellEditorProps<T extends FieldConfig['type'] = FieldConfig['type']> {
  readonly field: FieldDto;
  readonly config: Extract<FieldConfig, { type: T }>;
  /** The record of the cell (attachment cells write while the popover is open). */
  readonly recordId?: string | undefined;
  /** Current cell value, json read shape (CONTRACTS §2). */
  readonly value: unknown;
  /** The character that opened the editor by typing, which replaces the value. */
  readonly initialInput: string | undefined;
  /** Size of the cell under the editor (the input covers it). */
  readonly cellHeight: number;
  readonly cellWidth: number;
  readonly context: EditorContext;
  /** The content changed: a click outside the editor writes this draft. */
  readonly onDraft: (draft: EditorDraft) => void;
  readonly onCommit: (commit: EditorCommit, move: EditorMove) => void;
  readonly onCancel: () => void;
}
