import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from '@codemirror/autocomplete';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import {
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { suggest, type Suggestion, type SuggestionSection } from '../model/completions';
import { iconElement, type ChipIcon } from '../model/icons';
import {
  CHIP_CLASS,
  formulaSegments,
  isChip,
  SEGMENT_CLASSES,
  type SegmentKind,
} from '../model/segments';

import type { Diagnostic } from '../model/analysis';
import type { FormulaSchema } from '../model/schema';

/**
 * CodeMirror 6 setup of the formula editor (T466; BACKLOG S4b open
 * question #9: CodeMirror, lazy, no grammar of its own). Colours and chips
 * come from the formula engine's lexer (`model/segments.ts`); names are
 * atomic chips (Backspace deletes a whole `[Name]`); errors are wavy
 * underlines at their position; the autocomplete is `model/completions.ts`.
 */

/** Texts of the editor (translated by the caller). */
export interface EditorTexts {
  readonly sectionName: (section: SuggestionSection) => string;
  readonly detail: (item: Suggestion) => string;
  readonly info: (item: Suggestion) => string | null;
  readonly completions: string;
  readonly tabHint: string;
  readonly placeholder: string;
}

export interface EditorEnvironment {
  readonly schema: FormulaSchema;
  readonly texts: EditorTexts;
}

/** The schema and texts; reconfigured when they change. */
export const environment = Facet.define<EditorEnvironment, EditorEnvironment | null>({
  combine: (values) => values.at(-1) ?? null,
});

// --- Diagnostics -----------------------------------------------------------------

export const setDiagnostics = StateEffect.define<readonly Diagnostic[]>();

const diagnosticsField = StateField.define<readonly Diagnostic[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setDiagnostics)) return effect.value;
    // Positions move with the text until the next analysis.
    if (!transaction.docChanged) return value;
    return value.flatMap((item) => {
      const start = transaction.changes.mapPos(item.start, 1);
      const end = transaction.changes.mapPos(item.start + item.length, -1);
      return end < start ? [] : [{ ...item, start, length: end - start }];
    });
  },
});

// --- Chips and colours -----------------------------------------------------------

class ChipWidget extends WidgetType {
  constructor(
    readonly kind: SegmentKind,
    readonly label: string,
    readonly icon: ChipIcon | undefined,
    readonly invalid: boolean,
  ) {
    super();
  }

  override eq(other: ChipWidget): boolean {
    return (
      other.kind === this.kind &&
      other.label === this.label &&
      other.icon === this.icon &&
      other.invalid === this.invalid
    );
  }

  toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = `${CHIP_CLASS} ${SEGMENT_CLASSES[this.kind]} cm-fx-chip`;
    chip.dataset['chip'] = this.kind;
    if (this.icon !== undefined) chip.append(iconElement(this.icon));
    const text = document.createElement('span');
    text.className = this.invalid ? 'truncate cm-fx-error' : 'truncate';
    text.textContent = this.label;
    chip.append(text);
    return chip;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** A zero-width error (the formula ends too early): a dotted box after the caret. */
class ErrorPointWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const mark = document.createElement('span');
    mark.className = 'cm-fx-error-point';
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }
}

interface Painted {
  readonly decorations: DecorationSet;
  readonly chips: DecorationSet;
}

function paint(state: EditorState): Painted {
  const env = state.facet(environment);
  const diagnostics = state.field(diagnosticsField);
  const source = state.doc.toString();
  const marks: Range<Decoration>[] = [];
  const chips: Range<Decoration>[] = [];
  const invalidAt = (from: number, to: number) =>
    diagnostics.some(
      (item) => item.length > 0 && item.start < to && item.start + item.length > from,
    );
  if (env !== null) {
    for (const segment of formulaSegments(source, env.schema)) {
      if (segment.to <= segment.from) continue;
      if (isChip(segment.kind)) {
        chips.push(
          Decoration.replace({
            widget: new ChipWidget(
              segment.kind,
              segment.label ?? '',
              segment.icon,
              invalidAt(segment.from, segment.to),
            ),
          }).range(segment.from, segment.to),
        );
      } else {
        marks.push(
          Decoration.mark({ class: SEGMENT_CLASSES[segment.kind] }).range(segment.from, segment.to),
        );
      }
    }
  }
  for (const item of diagnostics) {
    const from = Math.min(item.start, source.length);
    const to = Math.min(item.start + item.length, source.length);
    if (to > from) {
      marks.push(Decoration.mark({ class: 'cm-fx-error' }).range(from, to));
    } else {
      marks.push(Decoration.widget({ widget: new ErrorPointWidget(), side: 1 }).range(from));
    }
  }
  const chipSet = Decoration.set(chips, true);
  return { decorations: Decoration.set([...marks, ...chips], true), chips: chipSet };
}

const painter = StateField.define<Painted>({
  create: paint,
  update(value, transaction) {
    const changed =
      transaction.docChanged ||
      transaction.effects.some((effect) => effect.is(setDiagnostics)) ||
      transaction.startState.facet(environment) !== transaction.state.facet(environment);
    return changed ? paint(transaction.state) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).chips),
  ],
});

// --- Autocomplete ----------------------------------------------------------------

const SECTION_RANK: Readonly<Record<SuggestionSection['kind'], number>> = {
  fields: 0,
  tables: 1,
  variables: 2,
  tableFunctions: 3,
  functions: 4,
};

function sectionHeader(section: CompletionSection): HTMLElement {
  const header = document.createElement('li');
  header.setAttribute('role', 'presentation');
  header.className = 'cm-fx-section';
  header.textContent = section.name;
  return header;
}

function completionSource(context: CompletionContext): CompletionResult | null {
  const env = context.state.facet(environment);
  if (env === null) return null;
  const source = context.state.doc.toString();
  const result = suggest(source, context.pos, env.schema, context.explicit);
  if (result === null || result.items.length === 0) return null;
  const sections = new Map<string, CompletionSection>();
  const sectionOf = (item: Suggestion): CompletionSection => {
    const name = env.texts.sectionName(item.section);
    let section = sections.get(name);
    if (section === undefined) {
      const group = item.section.kind === 'functions' ? item.section.group : '';
      section = {
        name,
        header: sectionHeader,
        rank:
          SECTION_RANK[item.section.kind] * 10 +
          ['logic', 'number', 'text', 'date', 'list'].indexOf(group),
      };
      sections.set(name, section);
    }
    return section;
  };
  const matches = new Map<Completion, readonly number[]>();
  const options = result.items.map((item, index): Completion => {
    const info = env.texts.info(item);
    const completion: Completion = {
      label: item.label,
      detail: env.texts.detail(item),
      section: sectionOf(item),
      boost: 99 - Math.min(index, 198),
      ...(info === null ? {} : { info }),
      apply: (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: item.apply },
          selection: { anchor: from + item.caret },
          userEvent: 'input.complete',
        });
        if (item.reopen) startCompletion(view);
      },
    };
    matches.set(completion, item.match[1] > item.match[0] ? [item.match[0], item.match[1]] : []);
    return completion;
  });
  return {
    from: result.from,
    to: result.to,
    options,
    filter: false,
    getMatch: (completion) => matches.get(completion) ?? [],
    // Recomputed synchronously on each keystroke: the list never goes stale (a stale
    // list ignores Tab/Enter until the next query, which would drop a quick accept).
    update: (_current, _from, _to, next) => completionSource(next),
  };
}

function tabHint(texts: () => EditorTexts | undefined) {
  return {
    render: () => {
      const hint = document.createElement('kbd');
      hint.className = 'cm-fx-tab';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = texts()?.tabHint ?? 'Tab';
      return hint;
    },
    position: 90,
  };
}

// --- Theme -----------------------------------------------------------------------

/** Layout of CodeMirror's parts with the design tokens (both themes follow the variables). */
const theme = EditorView.theme({
  '&': {
    fontFamily: 'var(--font-code)',
    fontSize: '13px',
    color: 'var(--text)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border-control)',
    borderRadius: 'var(--radius-control)',
  },
  '&.cm-focused': {
    outline: 'none',
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 2px var(--accent-soft)',
  },
  '&.cm-fx-invalid': { borderColor: 'var(--danger)' },
  '.cm-scroller': { fontFamily: 'var(--font-code)', lineHeight: '26px' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-subtle)',
    fontSize: '12px',
  },
  '.cm-placeholder': { color: 'var(--text-subtle)' },
  '.cm-fx-error': {
    textDecoration: 'underline wavy var(--danger)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '5px',
  },
  '.cm-fx-error-point': {
    display: 'inline-block',
    width: '14px',
    height: '18px',
    verticalAlign: 'middle',
    borderBottom: '2px dotted var(--danger)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-frame)',
    boxShadow: 'var(--elevation-popover)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    // A page of SUGGESTIONS_PER_PAGE options always fits: nothing to scroll.
    maxHeight: 'none',
    overflow: 'visible',
    minWidth: '18rem',
    padding: '4px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '30px',
    padding: '0 8px',
    borderRadius: 'var(--radius-control)',
    fontSize: '13px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete > ul > li.cm-fx-section': {
    minHeight: '24px',
    padding: '6px 8px 2px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--text-muted)',
    borderTop: '1px solid var(--border)',
  },
  '.cm-tooltip-autocomplete > ul > li.cm-fx-section:first-child': { borderTop: 'none' },
  '.cm-completionLabel': { flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    fontStyle: 'normal',
    fontSize: '12px',
    color: 'var(--text-muted)',
  },
  '.cm-fx-tab': {
    display: 'none',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    padding: '0 4px',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-chip)',
    color: 'var(--text-muted)',
  },
  'li[aria-selected] .cm-fx-tab': { display: 'inline-block' },
  '.cm-tooltip.cm-completionInfo': {
    maxWidth: '20rem',
    padding: '8px 10px',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-line',
  },
});

// --- Setup -----------------------------------------------------------------------

export interface EditorOptions {
  readonly env: EditorEnvironment;
  readonly label: string;
  readonly describedBy: string;
  readonly onChange: (text: string) => void;
  readonly onCaret: (position: number) => void;
  readonly onConfirm: () => void;
  readonly lineNumbers: boolean;
}

/** Everything the formula `EditorView` needs; `environment` changes go through `envCompartment`. */
/** Suggestions shown at once (a page; section headers take no slot). */
export const SUGGESTIONS_PER_PAGE = 8;

export function formulaExtensions(
  options: EditorOptions,
  envExtension: Extension,
  ariaExtension: Extension,
): Extension {
  let texts: EditorTexts | undefined = options.env.texts;
  return [
    envExtension,
    ariaExtension,
    diagnosticsField,
    painter,
    history(),
    options.lineNumbers ? lineNumbers() : [],
    EditorView.lineWrapping,
    placeholder(options.env.texts.placeholder),
    EditorState.phrases.of({ Completions: options.env.texts.completions }),
    autocompletion({
      override: [completionSource],
      activateOnTyping: true,
      icons: false,
      closeOnBlur: true,
      defaultKeymap: false,
      // One page of suggestions at a time (↑/↓ turn the page): the list never scrolls, as a
      // scrolling listbox the keyboard cannot reach fails axe scrollable-region-focusable (T470).
      maxRenderedOptions: SUGGESTIONS_PER_PAGE,
      addToOptions: [tabHint(() => texts)],
    }),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            options.onConfirm();
            return true;
          },
        },
        { key: 'Tab', run: acceptCompletion },
        { key: 'Mod-Space', run: startCompletion },
      ]),
    ),
    keymap.of(completionKeymap),
    keymap.of([
      { key: 'Enter', run: insertNewline },
      { key: 'Shift-Enter', run: insertNewline },
      ...historyKeymap,
      ...standardKeymap,
    ]),
    EditorView.updateListener.of((update: ViewUpdate) => {
      texts = update.state.facet(environment)?.texts;
      if (update.docChanged) options.onChange(update.state.doc.toString());
      if (update.docChanged || update.selectionSet)
        options.onCaret(update.state.selection.main.head);
    }),
    theme,
  ];
}

/** The ARIA attributes of the text area (name, errors, invalid state). */
export function ariaAttributes(label: string, describedBy: string, invalid: boolean): Extension {
  return [
    EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-describedby': describedBy,
      'aria-multiline': 'true',
      'aria-invalid': invalid ? 'true' : 'false',
    }),
    EditorView.editorAttributes.of({ class: invalid ? 'cm-fx-invalid' : '' }),
  ];
}
