import { Button, cn, Tooltip } from '@cellhive/ui';
import { Plus } from 'lucide-react';
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { templateOf, templateSegments, type TemplateSegment } from '../../model/values';

import { CHIP_CLASS, CHIP_TONE_CLASS } from './chips';
import { ValuePicker, type PickerSection } from './ValuePicker';

import type { ChipTone } from '../../model/scope';

export interface ChipLabel {
  readonly text: string;
  readonly tone: ChipTone;
}

export interface TemplateInputProps {
  /** The stored template (`{{ [fld_…] }}`). */
  readonly value: string;
  readonly onChange: (template: string) => void;
  /** Name and color of the placeholder `expression` (the `index`-th of the template). */
  readonly chipLabel: (expression: string, index: number) => ChipLabel;
  /** Sections of the "+" menu (chips: `ref` picks). */
  readonly sections: readonly PickerSection[];
  /** "Formula expression…" of the menu: asks for one, then `insert`s it. */
  readonly onExpression?: ((insert: (expression: string) => void) => void) | undefined;
  readonly label: string;
  readonly multiline?: boolean | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly testId?: string | undefined;
  /** (T522) Commands for a toolbar (the Markdown editor of `send_email`). */
  readonly editorRef?: Ref<TemplateEditorHandle> | undefined;
  /** (T522) Hides the "+" button (a toolbar offers "Insert value" instead). */
  readonly hidePlus?: boolean | undefined;
}

/**
 * (T522) What a toolbar may do to the text at the caret (or the last caret
 * of the field): the Markdown toolbar of `template-editor/` inserts syntax,
 * never HTML.
 */
export interface TemplateEditorHandle {
  /** Puts `before`/`after` around the selection; empty selection: around `fallback`, selected. */
  wrap: (before: string, after: string, fallback: string) => void;
  /** Inserts `text` at the start of a line (a line break first when the caret is mid-line). */
  insertBlock: (text: string) => void;
  /** Inserts a placeholder chip (`[fld_…]`, `[@digest]`). */
  insertExpression: (expression: string) => void;
  /** Opens the value menu at the caret. */
  openPicker: () => void;
  focus: () => void;
}

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

const CHIP_TONES = Object.values(CHIP_TONE_CLASS).flatMap((classes) => classes.split(' '));

function chipElement(expression: string, label: ChipLabel): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset['expr'] = expression;
  chip.className = cn(CHIP_CLASS, 'mx-px', CHIP_TONE_CLASS[label.tone]);
  chip.textContent = label.text;
  return chip;
}

/** The segments the editable element holds (text, chips, line breaks). */
function readSegments(root: HTMLElement): TemplateSegment[] {
  const out: TemplateSegment[] = [];
  let text = '';
  const flush = () => {
    if (text !== '') out.push({ kind: 'text', text });
    text = '';
  };
  const walk = (node: Node, first: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node as Text).data;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const expression = node.dataset['expr'];
    if (expression !== undefined) {
      flush();
      out.push({ kind: 'ref', expression });
      return;
    }
    if (node.tagName === 'BR') {
      text += '\n';
      return;
    }
    // A block the browser inserted on Enter (`<div>`): a new line.
    if (!first && (node.tagName === 'DIV' || node.tagName === 'P')) text += '\n';
    node.childNodes.forEach((child, index) => {
      walk(child, index === 0);
    });
  };
  root.childNodes.forEach((child, index) => {
    walk(child, index === 0);
  });
  flush();
  return out.map((segment) =>
    segment.kind === 'text'
      ? { kind: 'text', text: segment.text.replaceAll(ZERO_WIDTH_SPACE, '') }
      : segment,
  );
}

function renderSegments(
  root: HTMLElement,
  segments: readonly TemplateSegment[],
  chipLabel: TemplateInputProps['chipLabel'],
) {
  let index = -1;
  root.replaceChildren(
    ...segments.map((segment) => {
      if (segment.kind === 'text') return document.createTextNode(segment.text);
      index += 1;
      return chipElement(segment.expression, chipLabel(segment.expression, index));
    }),
  );
}

/** A collapsed range at the end of `root`. */
function endRange(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function placeCaret(after: Node) {
  const selection = window.getSelection();
  if (selection === null) return;
  const range = document.createRange();
  range.setStartAfter(after);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * A template field (SPEC §11.4; board "S5 · Automation builder"): literal
 * text with placeholders shown as chips by name and stored with ids
 * (`{{ [fld_…] }}`). The "+" button or typing `{{` opens the value menu;
 * a chip is one character for the caret (Backspace removes it whole).
 * Paste is plain text. An editable element (`role="textbox"`) the browser
 * edits; the template is read back from it after every input.
 */
export function TemplateInput({
  value,
  onChange,
  chipLabel,
  sections,
  onExpression,
  label,
  multiline = false,
  invalid = false,
  describedBy,
  placeholder,
  testId,
  editorRef,
  hidePlus = false,
}: TemplateInputProps) {
  const { t } = useTranslation('automationBuilder');
  const root = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const emitted = useRef<string | null>(null);
  const caret = useRef<Range | null>(null);
  const [picking, setPicking] = useState(false);

  // The template from outside (load, discard, another editor): rebuild the content.
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null || value === emitted.current) return;
    renderSegments(element, templateSegments(value), chipLabel);
    emitted.current = value;
  });
  // Chip names follow the schema (a renamed field renames its chip).
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return;
    element.querySelectorAll<HTMLSpanElement>('span[data-expr]').forEach((chip, index) => {
      const next = chipLabel(chip.dataset['expr'] ?? '', index);
      if (chip.textContent !== next.text) chip.textContent = next.text;
      const tone = CHIP_TONE_CLASS[next.tone];
      if (!tone.split(' ').every((name) => chip.classList.contains(name))) {
        chip.classList.remove(...CHIP_TONES);
        chip.classList.add(...tone.split(' '));
      }
    });
  });

  const emit = () => {
    const element = root.current;
    if (element === null) return;
    const next = templateOf(readSegments(element));
    emitted.current = next;
    if (next !== value) onChange(next);
  };

  const rememberCaret = () => {
    const element = root.current;
    const selection = window.getSelection();
    if (element === null || selection === null || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (element.contains(range.startContainer)) caret.current = range.cloneRange();
  };

  const insertNode = (node: Node) => {
    const element = root.current;
    if (element === null) return;
    const saved = caret.current;
    const range =
      saved !== null && element.contains(saved.startContainer) ? saved : endRange(element);
    range.deleteContents();
    range.insertNode(node);
    element.focus();
    placeCaret(node);
    rememberCaret();
    emit();
  };

  const insert = (expression: string) => {
    // Its name comes with the next render (index-based names are refreshed then).
    insertNode(chipElement(expression, chipLabel(expression, -1)));
  };

  const openPicker = () => {
    rememberCaret();
    setPicking(true);
  };

  /** The remembered caret (or the end of the text), with the focus back in the field. */
  const currentRange = (): Range | null => {
    const element = root.current;
    if (element === null) return null;
    const saved = caret.current;
    const range =
      saved !== null && element.contains(saved.startContainer)
        ? saved.cloneRange()
        : endRange(element);
    element.focus();
    return range;
  };

  /** Text from the start of the field to `range` (chips count as their names). */
  const textBefore = (range: Range): string => {
    const element = root.current;
    if (element === null) return '';
    const head = document.createRange();
    head.selectNodeContents(element);
    head.setEnd(range.startContainer, range.startOffset);
    return head.toString();
  };

  const select = (range: Range) => {
    const selection = window.getSelection();
    if (selection === null) return;
    selection.removeAllRanges();
    selection.addRange(range);
    caret.current = range.cloneRange();
  };

  useImperativeHandle(editorRef, (): TemplateEditorHandle => ({
    wrap: (before, after, fallback) => {
      const range = currentRange();
      if (range === null) return;
      if (range.collapsed) {
        const text = document.createTextNode(`${before}${fallback}${after}`);
        range.insertNode(text);
        const inner = document.createRange();
        inner.setStart(text, before.length);
        inner.setEnd(text, before.length + fallback.length);
        select(inner);
      } else {
        const end = range.cloneRange();
        end.collapse(false);
        const closing = document.createTextNode(after);
        end.insertNode(closing);
        const start = range.cloneRange();
        start.collapse(true);
        start.insertNode(document.createTextNode(before));
        const caretAfter = document.createRange();
        caretAfter.setStartAfter(closing);
        caretAfter.collapse(true);
        select(caretAfter);
      }
      emit();
    },
    insertBlock: (text) => {
      const range = currentRange();
      if (range === null) return;
      // On a selection the block goes before it (a list item of the selected text).
      range.collapse(true);
      const before = textBefore(range);
      const lineStart = before === '' || before.endsWith('\n');
      const node = document.createTextNode(`${lineStart ? '' : '\n'}${text}`);
      range.insertNode(node);
      placeCaret(node);
      rememberCaret();
      emit();
    },
    insertExpression: (expression) => {
      insert(expression);
    },
    openPicker,
    focus: () => {
      root.current?.focus();
    },
  }));

  /** The chip right before (Backspace) or after (Delete) a collapsed caret, if any. */
  const chipNextToCaret = (backward: boolean): HTMLElement | null => {
    const element = root.current;
    const selection = window.getSelection();
    if (element === null || selection === null || selection.rangeCount === 0) return null;
    if (!selection.isCollapsed) return null;
    const { startContainer, startOffset } = selection.getRangeAt(0);
    let node: Node | null = null;
    if (startContainer === element) {
      node = element.childNodes[backward ? startOffset - 1 : startOffset] ?? null;
    } else if (startContainer instanceof Text && startContainer.parentNode === element) {
      const atEdge = backward ? startOffset === 0 : startOffset === startContainer.data.length;
      if (atEdge) node = backward ? startContainer.previousSibling : startContainer.nextSibling;
    }
    // Empty text nodes left by edits do not count.
    while (node instanceof Text && node.data.replaceAll(ZERO_WIDTH_SPACE, '') === '') {
      node = backward ? node.previousSibling : node.nextSibling;
    }
    return node instanceof HTMLElement && node.dataset['expr'] !== undefined ? node : null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      // A chip goes whole, the caret stays where it was (FRONTEND §13.2).
      const chip = chipNextToCaret(event.key === 'Backspace');
      if (chip !== null) {
        event.preventDefault();
        const range = document.createRange();
        range.setStartBefore(chip);
        range.collapse(true);
        chip.remove();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        rememberCaret();
        emit();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (multiline && !event.ctrlKey && !event.metaKey) insertNode(document.createTextNode('\n'));
    }
  };

  return (
    <div className="relative flex min-w-0 items-start gap-1">
      <div className="relative min-w-0 flex-1">
        <div
          ref={root}
          role="textbox"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          aria-label={label}
          aria-multiline={multiline}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          data-testid={testId}
          className={cn(
            'min-h-control w-full rounded-md border border-line-control bg-surface px-3 py-1.5 text-body leading-[1.6] break-words whitespace-pre-wrap text-fg outline-none max-lg:text-[16px]',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
            multiline && 'min-h-20',
            invalid && 'border-danger',
          )}
          onKeyDown={onKeyDown}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
          onBlur={rememberCaret}
          onInput={() => {
            const selection = window.getSelection();
            const node = selection?.anchorNode;
            const offset = selection?.anchorOffset ?? 0;
            if (
              node instanceof Text &&
              offset >= 2 &&
              node.data.slice(offset - 2, offset) === '{{'
            ) {
              // `{{` opens the value menu at the caret (board); the braces are not kept.
              node.deleteData(offset - 2, 2);
              const range = document.createRange();
              range.setStart(node, offset - 2);
              range.collapse(true);
              selection?.removeAllRanges();
              selection?.addRange(range);
              emit();
              openPicker();
              return;
            }
            emit();
          }}
          onPaste={(event) => {
            event.preventDefault();
            const raw = event.clipboardData.getData('text/plain');
            const text = multiline ? raw : raw.replace(/[\r\n]+/gu, ' ');
            rememberCaret();
            insertNode(document.createTextNode(text));
          }}
        />
        {value === '' && placeholder !== undefined ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-3 text-body text-fg-subtle max-lg:text-[16px]"
          >
            {placeholder}
          </span>
        ) : null}
      </div>
      {hidePlus ? null : (
        <Tooltip content={t('values.insert')}>
          <Button
            ref={plus}
            variant="secondary"
            size="icon"
            className="size-8 max-lg:size-control"
            aria-label={t('values.insertInto', { label })}
            aria-expanded={picking}
            onMouseDown={(event) => {
              // Keep the caret of the text where the chip goes.
              event.preventDefault();
            }}
            onClick={openPicker}
          >
            <Plus aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
      {picking ? (
        <ValuePicker
          label={t('values.pickerLabel', { label })}
          sections={sections}
          onPick={(picked) => {
            if (picked.kind === 'ref') insert(picked.expression);
          }}
          onExpression={
            onExpression === undefined
              ? undefined
              : () => {
                  onExpression(insert);
                }
          }
          onClose={(reason) => {
            setPicking(false);
            if (reason === 'escape') {
              const element = root.current;
              element?.focus();
              const saved = caret.current;
              const selection = window.getSelection();
              if (saved !== null && selection !== null) {
                selection.removeAllRanges();
                selection.addRange(saved);
              }
            }
          }}
        />
      ) : null}
    </div>
  );
}
