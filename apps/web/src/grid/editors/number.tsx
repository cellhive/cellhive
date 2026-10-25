import { cn } from '@cellhive/ui';
import { useEffect, useId, useRef, useState } from 'react';

import { isPercentStyle, numberDraft, numberInputText } from './parse';
import { CELL_INPUT_CLASS, EditorFrame, handleEditorKey, useIssueMessage } from './shell';

import type { CellEditorProps, EditorIssue, EditorMove } from './types';

/**
 * `number` editor (every style). The text is read like `typecast` reads it
 * in the user's locale ("1.500.000" and "1,5" in Vietnamese, currency signs,
 * "%"); letters are refused here, before any request (FRONTEND §4.1).
 */
export function NumberEditor({
  field,
  config,
  value,
  initialInput,
  cellHeight,
  cellWidth,
  context,
  onDraft,
  onCommit,
  onCancel,
}: CellEditorProps<'number'>) {
  const [text, setText] = useState(
    () => initialInput ?? numberInputText(value, config.options, context.locale.locale),
  );
  const [issue, setIssue] = useState<EditorIssue | null>(null);
  const error = useIssueMessage(issue);
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    if (initialInput === undefined) element.select();
  }, [initialInput]);

  const commit = (move: EditorMove) => {
    const draft = numberDraft(text, config.options, context.locale);
    if (!draft.ok) {
      setIssue(draft.issue);
      return;
    }
    onCommit(draft.commit, move);
  };

  return (
    <EditorFrame cellWidth={cellWidth} cellHeight={cellHeight} error={error} errorId={errorId}>
      <div className="relative flex items-center">
        <input
          ref={input}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-label={field.name}
          aria-invalid={issue !== null}
          aria-describedby={issue === null ? undefined : errorId}
          value={text}
          className={cn(
            CELL_INPUT_CLASS,
            'text-right tabular-nums',
            isPercentStyle(config.options) && 'pr-6',
            issue !== null && 'ring-danger',
          )}
          style={{ height: cellHeight }}
          onChange={(event) => {
            setText(event.target.value);
            setIssue(null);
            onDraft(numberDraft(event.target.value, config.options, context.locale));
          }}
          onKeyDown={(event) => {
            handleEditorKey(event, { commit, cancel: onCancel });
          }}
        />
        {isPercentStyle(config.options) ? (
          <span aria-hidden="true" className="pointer-events-none absolute right-2 text-fg-muted">
            %
          </span>
        ) : null}
      </div>
    </EditorFrame>
  );
}
