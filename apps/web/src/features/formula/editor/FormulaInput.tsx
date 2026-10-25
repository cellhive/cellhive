import { startCompletion } from '@codemirror/autocomplete';
import { Compartment, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';

import { withConstructedStyles } from './csp-styles';
import {
  ariaAttributes,
  environment,
  formulaExtensions,
  setDiagnostics,
  type EditorEnvironment,
} from './extensions';

import type { Diagnostic } from '../model/analysis';

export interface FormulaInputHandle {
  focus(): void;
  /** Puts the caret on `from` (and selects to `to`). */
  select(from: number, to?: number): void;
  /** Inserts `text` at the caret (catalogue "Insert"); `caret`: offset in `text` to leave the caret at. */
  insert(text: string, caret?: number): void;
  /** Replaces the whole formula ("Reformat", "Insert example"). */
  replaceAll(text: string): void;
  /** Opens the suggestions (Ctrl/⌘+Space). */
  suggest(): void;
}

export interface FormulaInputProps {
  readonly value: string;
  readonly env: EditorEnvironment;
  readonly diagnostics: readonly Diagnostic[];
  readonly label: string;
  /** Id of the error list (read with the text area, `aria-describedby`). */
  readonly describedBy: string;
  readonly onChange: (text: string) => void;
  readonly onCaret: (position: number) => void;
  /** Ctrl/⌘+Enter. */
  readonly onConfirm: () => void;
  readonly lineNumbers?: boolean;
  readonly autoFocus?: boolean;
}

/**
 * The formula text area (CodeMirror 6, T466). Uncontrolled inside: the
 * view owns the text and reports changes; a `value` that differs from the
 * view's text (reformat, example inserted by the parent) replaces it.
 */
export const FormulaInput = forwardRef<FormulaInputHandle, FormulaInputProps>(function FormulaInput(
  {
    value,
    env,
    diagnostics,
    label,
    describedBy,
    onChange,
    onCaret,
    onConfirm,
    lineNumbers = true,
    autoFocus = false,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const envCompartment = useRef(new Compartment());
  const ariaCompartment = useRef(new Compartment());
  const callbacks = useRef({ onChange, onCaret, onConfirm });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCaret, onConfirm };
  });

  // Created once; the text, environment and errors are pushed in below.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return;
    const invalid = diagnostics.length > 0;
    const created = withConstructedStyles(
      () =>
        new EditorView({
          parent,
          doc: value,
          extensions: formulaExtensions(
            {
              env,
              label,
              describedBy,
              lineNumbers,
              onChange: (text) => {
                callbacks.current.onChange(text);
              },
              onCaret: (position) => {
                callbacks.current.onCaret(position);
              },
              onConfirm: () => {
                callbacks.current.onConfirm();
              },
            },
            envCompartment.current.of(environment.of(env)),
            ariaCompartment.current.of(ariaAttributes(label, describedBy, invalid)),
          ),
        }),
    );
    created.dispatch({ selection: EditorSelection.cursor(value.length) });
    view.current = created;
    if (autoFocus) created.focus();
    return () => {
      created.destroy();
      view.current = null;
    };
    // The view is created once per mount; later props are dispatched below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    const text = current.state.doc.toString();
    if (text !== value) {
      current.dispatch({
        changes: { from: 0, to: text.length, insert: value },
        selection: EditorSelection.cursor(value.length),
      });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: envCompartment.current.reconfigure(environment.of(env)) });
  }, [env]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        setDiagnostics.of(diagnostics),
        ariaCompartment.current.reconfigure(
          ariaAttributes(label, describedBy, diagnostics.length > 0),
        ),
      ],
    });
  }, [diagnostics, label, describedBy]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        view.current?.focus();
      },
      select: (from, to) => {
        const current = view.current;
        if (current === null) return;
        const length = current.state.doc.length;
        current.dispatch({
          selection: EditorSelection.range(Math.min(from, length), Math.min(to ?? from, length)),
          scrollIntoView: true,
        });
        current.focus();
      },
      insert: (text, caret) => {
        const current = view.current;
        if (current === null) return;
        const { from, to } = current.state.selection.main;
        current.dispatch({
          changes: { from, to, insert: text },
          selection: EditorSelection.cursor(from + (caret ?? text.length)),
          userEvent: 'input',
        });
        current.focus();
      },
      replaceAll: (text) => {
        const current = view.current;
        if (current === null) return;
        current.dispatch({
          changes: { from: 0, to: current.state.doc.length, insert: text },
          selection: EditorSelection.cursor(text.length),
        });
        current.focus();
      },
      suggest: () => {
        const current = view.current;
        if (current === null) return;
        current.focus();
        startCompletion(current);
      },
    }),
    [],
  );

  return <div ref={host} className="min-w-0" data-testid="formula-input" />;
});
