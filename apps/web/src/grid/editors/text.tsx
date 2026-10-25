import { cn } from '@cellhive/ui';
import { useEffect, useId, useRef, useState } from 'react';

import { textDraft } from './parse';
import { CELL_INPUT_CLASS, EditorFrame, handleEditorKey, useIssueMessage } from './shell';

import type { CellEditorProps, EditorIssue, EditorMove } from './types';

/** Lines a multi-line text editor grows to before it scrolls. */
const MAX_LINES = 8;

/**
 * `text` editor. Plain text is multi-line (a text area; Shift+Enter or
 * Alt+Enter adds a line); url, email, phone and barcode are one line.
 * Typing into a cell replaces its value with the typed character.
 */
export function TextEditor({
  field,
  config,
  value,
  initialInput,
  cellHeight,
  cellWidth,
  onDraft,
  onCommit,
  onCancel,
}: CellEditorProps<'text'>) {
  const multiline = config.options.style.type === 'plain';
  const [text, setText] = useState(() => initialInput ?? (typeof value === 'string' ? value : ''));
  const [issue, setIssue] = useState<EditorIssue | null>(null);
  const error = useIssueMessage(issue);
  const errorId = useId();
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    // Opened with Enter: the value is selected; opened by typing: caret at the end.
    if (initialInput === undefined) element.select();
    else element.setSelectionRange(element.value.length, element.value.length);
  }, [initialInput]);

  const commit = (move: EditorMove) => {
    const draft = textDraft(text, config.options);
    if (!draft.ok) {
      setIssue(draft.issue);
      return;
    }
    onCommit(draft.commit, move);
  };

  const change = (next: string) => {
    setText(next);
    setIssue(null);
    onDraft(textDraft(next, config.options));
  };

  const inputClass = cn(CELL_INPUT_CLASS, issue !== null && 'ring-danger');
  const common = {
    value: text,
    'aria-label': field.name,
    'aria-invalid': issue !== null,
    'aria-describedby': issue === null ? undefined : errorId,
    spellCheck: multiline,
  };
  const lines = Math.min(Math.max(text.split('\n').length, 1), MAX_LINES);

  return (
    <EditorFrame cellWidth={cellWidth} cellHeight={cellHeight} error={error} errorId={errorId}>
      {multiline ? (
        <textarea
          {...common}
          ref={input}
          rows={lines}
          className={cn(inputClass, 'resize-none py-1.5 leading-5')}
          style={{ minHeight: cellHeight, width: Math.max(cellWidth, 280) }}
          onChange={(event) => {
            change(event.target.value);
          }}
          onKeyDown={(event) => {
            handleEditorKey(event, { commit, cancel: onCancel, newlineOnShiftEnter: true });
          }}
        />
      ) : (
        <input
          {...common}
          ref={input}
          className={inputClass}
          type="text"
          inputMode={
            config.options.style.type === 'email'
              ? 'email'
              : config.options.style.type === 'phone'
                ? 'tel'
                : config.options.style.type === 'url'
                  ? 'url'
                  : 'text'
          }
          style={{ height: cellHeight }}
          onChange={(event) => {
            change(event.target.value);
          }}
          onKeyDown={(event) => {
            handleEditorKey(event, { commit, cancel: onCancel });
          }}
        />
      )}
    </EditorFrame>
  );
}
