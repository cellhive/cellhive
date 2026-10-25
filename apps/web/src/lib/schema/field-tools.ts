import type { FormulaFieldComponent, FormulaPopoverComponent } from './formula-tools';
import type { LookupFieldEditor } from './lookup-tools';
import type { FieldDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * Condition editor of a link field's `record_filter` (T413): the filter
 * builder of `features/view` over the fields of the linked table, given to
 * the field tools by the route (features do not import each other).
 */
export interface RecordFilterEditorProps {
  /** The linked table: its fields are the ones the conditions name. */
  readonly tableId: string;
  readonly orgId: string;
  /** Stored Filter DSL, `null` for none. */
  readonly value: Readonly<Record<string, unknown>> | null;
  /** A complete, valid filter (or `null` when every condition is gone). */
  readonly onChange: (value: Readonly<Record<string, unknown>> | null) => void;
  /** The line shown while there is no condition (default: the linked table's records can be picked). */
  readonly emptyText?: string | undefined;
}

/**
 * What the grid asks the field configuration UI (T207, `features/field`) to
 * do. Features may not import each other (FRONTEND §1.2): the grid screen
 * receives the field tools as a component from the route (app layer) and
 * talks to it through these types only.
 */
export type FieldToolRequest =
  /**
   * New field. `index`: its place in the table's field order (0-based, as
   * `PATCH /fields/:id { position }` counts it); absent → last.
   */
  | { readonly kind: 'create'; readonly index?: number }
  | { readonly kind: 'edit'; readonly fieldId: string }
  | { readonly kind: 'rename'; readonly fieldId: string }
  | { readonly kind: 'delete'; readonly fieldId: string }
  /** Undo the last type conversion of the field (7 days, T414). */
  | { readonly kind: 'revert'; readonly fieldId: string }
  /**
   * (T468, S4b decision #12) The formula editor as a popover under the
   * column header ("Edit formula" of the header menu); `anchor` = header.
   */
  | {
      readonly kind: 'formula';
      readonly fieldId: string;
      readonly anchor: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    };

export interface FieldToolsProps {
  readonly tableId: string;
  /** Live fields of the table as `GET /tables/:id/fields` lists them. */
  readonly fields: readonly FieldDto[];
  /** `null`: nothing open. */
  readonly request: FieldToolRequest | null;
  /** The dialog was closed (saved or cancelled). */
  readonly onClose: () => void;
  /** Conditions of link fields (T413); absent: link fields are created without conditions. */
  readonly RecordFilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  /** Formula fields (T466): the editor; absent: formula fields cannot be created here. */
  readonly Formula?: FormulaFieldComponent | undefined;
  /** (T468) The formula popover of the column header; absent: "Edit formula" opens the dialog. */
  readonly FormulaPopover?: FormulaPopoverComponent | undefined;
  /** Configuration of lookup fields (T467, `features/lookup`); absent: lookups are not offered. */
  readonly LookupEditor?: LookupFieldEditor | undefined;
}

/**
 * Order of the fields on the server (`position`, then id): the index that
 * `position` of `PATCH /fields/:id` means (CONTRACTS §13).
 */
export function serverFieldOrder(fields: readonly FieldDto[]): FieldDto[] {
  return [...fields].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** Index of a field in {@link serverFieldOrder}, `-1` when absent. */
export function serverFieldIndex(fields: readonly FieldDto[], fieldId: string): number {
  return serverFieldOrder(fields).findIndex((field) => field.id === fieldId);
}
