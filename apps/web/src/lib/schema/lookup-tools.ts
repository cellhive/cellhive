import type { LookupConditionsDraft } from './lookup-where';
import type { FieldDto } from '@cellhive/contracts';
import type { ComponentType, ReactNode } from 'react';

/**
 * How the field dialog (`features/field`), the lookup configuration
 * (`features/lookup`, T467) and the condition editor built on the view
 * filter builder (`features/view/toolbar`, T311) talk to each other: the
 * route (`app/router.tsx`) wires the components, features never import one
 * another (FRONTEND §1.2).
 */

/** Condition editor of a lookup `where` (the T311 value editors + "field of this table"). */
export interface LookupWhereEditorProps {
  /** Fields of the source table the user reads. */
  readonly sourceFields: readonly FieldDto[];
  /** Name of the source table ("Record of <table>" in the field list). */
  readonly sourceTableName?: string | undefined;
  /** Fields of this table the user reads (`field_ref` choices; the edited field left out). */
  readonly currentFields: readonly FieldDto[];
  readonly currentTableId: string;
  /** Name of this table ("This record" is a record of it). */
  readonly currentTableName: string;
  readonly orgId: string;
  readonly value: LookupConditionsDraft;
  readonly onChange: (value: LookupConditionsDraft) => void;
  /** Translated problems by condition key (`''`: the whole list). */
  readonly issues: ReadonlyMap<string, string>;
  /** Show "not complete" on conditions (after a save attempt). */
  readonly showIncomplete: boolean;
  /** Accessible name of the list ("Conditions"). */
  readonly labelledBy: string;
}

/** What the field dialog hands the lookup configuration (a lookup is being created or edited). */
export interface LookupFieldEditorProps {
  readonly tableId: string;
  /** The saved lookup field; absent: a new field. */
  readonly field?: FieldDto | undefined;
  /**
   * (T469) A saved field of another type becoming this lookup: left out of
   * the field lists like the edited field; the dialog is an edit. Saving
   * hands the options to the conversion step of the field dialog.
   */
  readonly convertingFieldId?: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly onNameChange: (name: string) => void;
  readonly onDescriptionChange: (description: string) => void;
  /** The field dialog's type control (switching away from "Lookup" leaves this editor). */
  readonly typePicker: ReactNode;
  /**
   * Save: the dialog sends `POST /tables/:id/fields` (new field) or
   * `PATCH /fields/:id` with these options (on an edit, only the keys that
   * changed) plus the name and description, and closes on success; `null`:
   * the options did not change.
   */
  readonly onSave: (options: Readonly<Record<string, unknown>> | null) => void;
  readonly saving: boolean;
  /** Error of the last save (placed on the controls it names). */
  readonly saveError: unknown;
  readonly onClose: () => void;
}

/** The lookup configuration with its condition editor bound (given by the route). */
export type LookupFieldEditor = ComponentType<LookupFieldEditorProps>;

/** Props of the unbound lookup configuration (`features/lookup`). */
export interface LookupFieldEditorWithWhereProps extends LookupFieldEditorProps {
  readonly WhereEditor: ComponentType<LookupWhereEditorProps>;
}
