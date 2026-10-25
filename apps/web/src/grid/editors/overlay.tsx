import { GridCellKind } from '@glideapps/glide-data-grid';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { CellEditor } from './index';

import type { EditorContext, EditorDraft } from './types';
import type { FinishKey, TypedInput } from '../type-to-edit';
import type { GridField, GridRecord } from '../types';
import type { CustomCell, GridCell, ProvideEditorComponent } from '@glideapps/glide-data-grid';

export interface EditCellData {
  readonly kind: 'ob-edit';
  readonly draft: EditorDraft;
  /** `version` of the record when the editor opened (conflict check under realtime, T204). */
  readonly baseVersion: number;
}

/**
 * What an overlay editor hands back to glide: not a displayable cell but
 * the draft (a value to write or the reason it cannot be written). Glide
 * passes it to `onCellEdited`, where the adapter turns it into `onCommit`.
 */
export type EditCell = CustomCell<EditCellData>;

export function editCell(draft: EditorDraft, baseVersion: number): EditCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: true,
    readonly: false,
    copyData: '',
    data: { kind: 'ob-edit', draft, baseVersion },
  };
}

export function isEditCell(cell: GridCell): cell is EditCell {
  return cell.kind === GridCellKind.Custom && (cell.data as { kind?: unknown }).kind === 'ob-edit';
}

/**
 * The glide overlay editor of one cell (FRONTEND §1.3 `editors/<type>.tsx`),
 * bound to the field and the record as they were when editing started. The
 * editor handles Enter / Tab / Escape itself; a click outside writes the
 * last draft (`onChange`).
 */
export function createOverlayEditor(
  field: GridField,
  record: GridRecord,
  context: EditorContext,
  /** The keys typed while the editor opened (`TypeToEdit`, `GridView`); none: glide opened it alone. */
  typed?: TypedInput,
): ProvideEditorComponent<GridCell> | undefined {
  const config = field.config;
  if (config === null) return undefined;
  const value = record.fields[field.field.id];
  const OverlayEditor: ProvideEditorComponent<GridCell> = ({
    onChange,
    onFinishedEditing,
    initialValue,
    target,
  }) => {
    // Typing goes on until the editor has the focus: the editor then starts
    // again from the whole text (`key`) and gets Enter / Tab pressed meanwhile.
    // Keeping the focus once open is `TypeToEdit`'s (the grid's late focus).
    const [input, setInput] = useState<TypedState>(() => typedState(typed));
    useLayoutEffect(() => {
      if (typed === undefined) return;
      const apply = (settled: TypedState) => {
        if (settled.cancelled) onFinishedEditing(undefined, [0, 0]);
        else setInput((current) => (sameTyped(current, settled) ? current : settled));
      };
      // Settled before this editor rendered (StrictMode, a fast Escape).
      const early = typedState(typed);
      if (early.settled) apply(early);
      return typed.onSettle(() => {
        apply(typedState(typed));
      });
    }, [onFinishedEditing]);
    const replayed = useRef<FinishKey | undefined>(undefined);
    useEffect(() => {
      const key = input.finishKey;
      const active = document.activeElement;
      if (key === undefined || active === null || replayed.current === key) return;
      replayed.current = key;
      active.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: key.key,
          shiftKey: key.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, [input]);
    return (
      <CellEditor
        key={input.generation}
        field={field.field}
        config={config}
        recordId={record.id}
        value={value}
        initialInput={input.text ?? initialValue}
        cellHeight={target.height}
        cellWidth={target.width}
        context={context}
        onDraft={(draft) => {
          onChange(editCell(draft, record.version));
        }}
        onCommit={(commit, move) => {
          onFinishedEditing(editCell({ ok: true, commit }, record.version), move);
        }}
        onCancel={() => {
          onFinishedEditing(undefined, [0, 0]);
        }}
      />
    );
  };
  return OverlayEditor;
}

/** The typed text an overlay editor starts from; a new `generation` remounts the editor. */
interface TypedState {
  readonly text: string | undefined;
  readonly settled: boolean;
  readonly cancelled: boolean;
  readonly finishKey: FinishKey | undefined;
  readonly generation: string;
}

function typedState(typed: TypedInput | undefined): TypedState {
  const settled = typed?.settled();
  const text = typed?.text();
  return {
    text,
    settled: settled !== undefined,
    cancelled: settled?.cancelled === true,
    finishKey: settled?.finishKey,
    // Nothing typed (the editor opens on the value) is not the same as typing nothing.
    generation: text === undefined ? 'value' : `typed:${text}`,
  };
}

function sameTyped(a: TypedState, b: TypedState): boolean {
  return a.text === b.text && a.finishKey === b.finishKey;
}
