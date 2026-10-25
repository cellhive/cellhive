import type { FieldDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * The formula part of the field dialog (T466). The dialog (`features/field`)
 * owns the field form; the formula editor (`features/formula`, a lazy
 * chunk with CodeMirror) is given to it by the route, since features do not
 * import each other (FRONTEND §1.2). They talk through these types only.
 */

/** A formula being configured: `expression` as the user writes it (names, SPEC §9.2). */
export interface FormulaDraft {
  readonly expression: string;
  /** `style` of the result (CONTRACTS §13); `null`: none / the default. */
  readonly style: Readonly<Record<string, unknown>> | null;
  /** The user chose a style: it is sent (else the server keeps the default of the carried field). */
  readonly styleTouched: boolean;
}

/** What saving the field from the editor ("Xác nhận") gave. */
export type FormulaSaveOutcome =
  | { readonly ok: true }
  /**
   * `formError`: something outside the formula blocks the save (the field
   * name…): the editor closes so the form shows it. Otherwise `error` is the
   * server's answer, shown in the editor (`422 FORMULA_*` with positions).
   */
  | { readonly ok: false; readonly formError: boolean; readonly error: unknown };

export interface FormulaFieldProps {
  readonly tableId: string;
  /** The saved field; absent: a new one. */
  readonly field?: FieldDto | undefined;
  /** Name typed in the form (the editor's subtitle). */
  readonly fieldName: string;
  readonly value: FormulaDraft;
  readonly onChange: (value: FormulaDraft) => void;
  /** Saves the field with `value` (the editor's "Xác nhận"). */
  readonly onSave: (value: FormulaDraft) => Promise<FormulaSaveOutcome>;
  /** The form was submitted without a formula. */
  readonly missing?: boolean;
}

export type FormulaFieldComponent = ComponentType<FormulaFieldProps>;

/**
 * (T468, BACKLOG S4b additional decision #12) The formula editor as a
 * popover under a column header ("Edit formula" of the header menu), the
 * same editor as the dialog (T466) in a compact form; "Expand" opens the
 * dialog. Saving sends `PATCH /fields/:id` with the formula.
 */
export interface FormulaPopoverProps {
  readonly tableId: string;
  readonly field: FieldDto;
  /** The column header (screen coordinates): the popover opens under it. */
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly onSave: (value: FormulaDraft) => Promise<FormulaSaveOutcome>;
  readonly onClose: () => void;
}

export type FormulaPopoverComponent = ComponentType<FormulaPopoverProps>;
