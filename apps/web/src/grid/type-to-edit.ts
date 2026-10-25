/**
 * Where the keys go while a cell editor opens and while it is open (S2/S3
 * QA, T803): the one place that decides it for a grid.
 *
 * - No editor: a key typed on a cell opens its editor with that key (type
 *   to replace, `GridView.typeToEdit`) and starts a session here.
 * - An editor on its way (glide accepted to open it: a double click, Enter,
 *   F2 or that first key): the focus moves to a hidden text area (the
 *   "sink") that takes every input, in order, as any text field does — IME
 *   and paste included — and grid shortcuts cannot fire since the grid no
 *   longer has the focus. When the editor takes the focus, the session
 *   settles: the editor starts from the sink's whole text (nothing typed: it
 *   opens as usual, on the value), then replays Enter / Tab pressed before
 *   it was ready. Escape cancels. A composition still open then goes on in
 *   the sink and is handed over when it ends.
 * - An editor open: it keeps the keys. Glide gives the grid the focus a
 *   frame after the click that opened the editor; when that frame comes
 *   after the editor took the focus (frames 100 ms apart on a loaded
 *   machine, QA S6 L15), the focus goes straight back to the editor, before
 *   any key can reach the grid. Editing ends with `end` (glide's
 *   `onFinishedEditing`) or a click on the grid (`release`).
 *
 * Opening the editor takes a while on the first edit after a page load
 * (glide loads its overlay code lazily): keys pressed meanwhile used to hit
 * the grid, where characters without a keydown (IME, `insertText`, letters
 * not on the keyboard layout) were dropped and Space opened the record panel.
 */

/** A key that ends the typing before the editor was there (replayed on it). */
export interface FinishKey {
  readonly key: 'Enter' | 'Tab';
  readonly shiftKey: boolean;
}

/** How the typing ended once the editor took the focus (or Escape cancelled it). */
export interface SettledInput {
  readonly cancelled: boolean;
  /** The whole text typed; `undefined` when nothing was (the editor opens on the value). */
  readonly text: string | undefined;
  readonly finishKey: FinishKey | undefined;
}

/** What the overlay editor of a session reads (`createOverlayEditor`). */
export interface TypedInput {
  /** The text typed so far (the whole text once settled); `undefined` when nothing was. */
  readonly text: () => string | undefined;
  /** How the typing ended, once it has. */
  readonly settled: () => SettledInput | undefined;
  /** Called once when the typing ends (the editor took the focus, or Escape). */
  readonly onSettle: (listener: (settled: SettledInput) => void) => () => void;
}

/** A session to start (`TypeToEdit.start`) when glide accepted to open a cell's editor. */
export interface TypingStart {
  /** Element the hidden text area goes into (the grid). */
  readonly host: HTMLElement;
  readonly col: number;
  readonly row: number;
  /** The key typed on the cell that opens the editor; `''` when opened otherwise (double click, Enter, F2). */
  readonly first: string;
  /** Over the cell (screen coordinates), so an IME shows its candidates there. */
  readonly place: { readonly x: number; readonly y: number; readonly height: number };
  /** Accessible name of the text area: the field name. */
  readonly label: string;
  /** The typing was dropped without an editor (Escape, no editor came): the grid takes the focus back. */
  readonly onAbandon: () => void;
}

/** The editor never came (its code failed to load): give the keyboard back. */
const ABANDON_MS = 10_000;

/** Glide's overlay editors render into `#portal` at the end of `<body>`. */
function inEditor(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.closest('#portal') !== null;
}

class Session implements TypedInput {
  private result: SettledInput | undefined;
  private readonly listeners = new Set<(settled: SettledInput) => void>();
  private finishKey: FinishKey | undefined;
  /** Something was typed (the first key, an input, Backspace on nothing). */
  private typed: boolean;
  /** An IME composition is open in the sink. */
  composing = false;

  constructor(
    readonly col: number,
    readonly row: number,
    private readonly sink: HTMLTextAreaElement,
  ) {
    this.typed = sink.value !== '';
  }

  readonly text = (): string | undefined =>
    this.result === undefined ? (this.typed ? this.sink.value : undefined) : this.result.text;

  readonly settled = (): SettledInput | undefined => this.result;

  readonly onSettle = (listener: (settled: SettledInput) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get isSettled(): boolean {
    return this.result !== undefined;
  }

  markTyped(): void {
    this.typed = true;
  }

  finishWith(key: FinishKey): void {
    this.finishKey = key;
  }

  settle(cancelled: boolean): void {
    if (this.result !== undefined) return;
    this.result = {
      cancelled,
      text: cancelled ? undefined : this.text(),
      finishKey: this.finishKey,
    };
    const settled = this.result;
    for (const listener of [...this.listeners]) listener(settled);
  }
}

/**
 * One editing session at a time for a grid. `start` right after glide
 * accepted to open the editor; `inputFor` from `provideEditor`; `end` when
 * editing is over.
 */
export class TypeToEdit {
  private session: Session | null = null;
  private sink: HTMLTextAreaElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopListening: (() => void) | undefined;
  /** The element of the open editor that has (or last had) the focus: it keeps the keys. */
  private editor: HTMLElement | null = null;
  /** The editor took the focus during a composition in the sink: it gets it when that ends. */
  private waiting: HTMLElement | null = null;

  /** Whether characters are being kept for an editor that is not there yet. */
  isPending(): boolean {
    return this.session !== null && !this.session.isSettled;
  }

  /** Whether an open editor owns the keys (a key reaching the grid then is the editor's). */
  hasEditor(): boolean {
    return this.editor !== null && this.editor.isConnected;
  }

  /** Gives the focus back to the open editor; `false` when there is none. */
  focusEditor(): boolean {
    const editor = this.editor;
    if (editor === null || !editor.isConnected) return false;
    editor.focus({ preventScroll: true });
    return true;
  }

  /** Starts keeping the keys for the editor of a cell that glide is opening. */
  start({ host, col, row, first, place, label, onAbandon }: TypingStart): void {
    this.end();
    const doc = host.ownerDocument;
    const sink = doc.createElement('textarea');
    sink.dataset['obTypeSink'] = '';
    sink.setAttribute('aria-label', label);
    sink.tabIndex = -1;
    sink.autocomplete = 'off';
    sink.spellcheck = false;
    sink.setAttribute('autocapitalize', 'off');
    Object.assign(sink.style, {
      position: 'fixed',
      left: `${String(place.x)}px`,
      top: `${String(place.y)}px`,
      width: '1px',
      height: `${String(place.height)}px`,
      opacity: '0',
      padding: '0',
      border: '0',
      resize: 'none',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    sink.value = first;
    const session = new Session(col, row, sink);
    sink.addEventListener('keydown', (event) => {
      this.onSinkKey(session, event, onAbandon);
    });
    sink.addEventListener('input', () => {
      session.markTyped();
    });
    sink.addEventListener('compositionstart', () => {
      session.composing = true;
    });
    sink.addEventListener('compositionend', () => {
      session.composing = false;
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting === null || session.isSettled || this.session !== session) return;
      // The composition is whole: the editor that came meanwhile starts from it.
      this.settle(session, false);
      this.editor = waiting;
      if (waiting.isConnected) waiting.focus({ preventScroll: true });
    });
    const onFocusIn = (event: FocusEvent) => {
      this.onFocusIn(session, host, sink, event.target);
    };
    doc.addEventListener('focusin', onFocusIn, true);
    this.stopListening = () => {
      doc.removeEventListener('focusin', onFocusIn, true);
    };
    host.append(sink);
    this.sink = sink;
    this.session = session;
    sink.focus({ preventScroll: true });
    sink.setSelectionRange(first.length, first.length);
    this.timer = setTimeout(() => {
      if (this.session === session && !session.isSettled) {
        this.end();
        onAbandon();
      }
    }, ABANDON_MS);
  }

  /** Characters that still reached the grid while the editor is on its way. */
  append(text: string): void {
    const sink = this.sink;
    const session = this.session;
    if (!this.isPending() || sink === null || session === null) return;
    sink.value += text;
    session.markTyped();
  }

  /** The session of a cell for its editor; `undefined` when glide opened it without one. */
  inputFor(col: number, row: number): TypedInput | undefined {
    const session = this.session;
    return session !== null && session.col === col && session.row === row ? session : undefined;
  }

  /** The user clicks: the text typed so far is final, and the grid may take the focus. */
  release(): void {
    const session = this.session;
    if (session !== null) this.settle(session, false);
    this.editor = null;
    this.waiting = null;
  }

  /** Drops a pending typing (another cell was selected, or glide did not open the editor). */
  cancel(): void {
    const session = this.session;
    if (session !== null && !session.isSettled) this.end();
  }

  /** Editing is over: the keys go to the grid again. */
  end(): void {
    const session = this.session;
    if (session !== null) this.settle(session, true);
    this.stopListening?.();
    this.stopListening = undefined;
    this.session = null;
    this.editor = null;
    this.waiting = null;
  }

  private onFocusIn(
    session: Session,
    host: HTMLElement,
    sink: HTMLTextAreaElement,
    target: EventTarget | null,
  ): void {
    if (target === sink || this.session !== session) return;
    const toGrid = target instanceof Node && host.contains(target);
    if (!session.isSettled) {
      if (toGrid) {
        // Glide gives the grid the focus a frame after a click: the typing is
        // not over (keys reaching the grid meanwhile are added by `append`).
        queueMicrotask(() => {
          if (!session.isSettled && sink.isConnected) sink.focus({ preventScroll: true });
        });
        return;
      }
      if (session.composing && inEditor(target)) {
        // Moving the focus would cut the composition: it ends in the sink first.
        this.waiting = target;
        queueMicrotask(() => {
          if (!session.isSettled && sink.isConnected) sink.focus({ preventScroll: true });
        });
        return;
      }
      // The editor took the focus (or the user went elsewhere): the text is final.
      this.settle(session, false);
      if (inEditor(target)) this.editor = target;
      return;
    }
    if (inEditor(target)) {
      // Another part of the editor (a remounted input, a list) has the focus now.
      this.editor = target;
      return;
    }
    if (!toGrid || this.editor === null) return;
    // The grid took the focus while the editor is open (glide's late frame): give it back.
    queueMicrotask(() => {
      const active = host.ownerDocument.activeElement;
      if (this.session === session && active !== null && host.contains(active)) this.focusEditor();
    });
  }

  private onSinkKey(session: Session, event: KeyboardEvent, onAbandon: () => void): void {
    if (event.isComposing || session.composing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // The editor (if it comes) reads the cancel and closes at once.
      this.settle(session, true);
      onAbandon();
      return;
    }
    // Shift/Alt+Enter is a new line (multi-line text): the text area keeps it.
    if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || event.key === 'Tab') {
      // Written by the editor once it is there, not a new line here.
      event.preventDefault();
      event.stopPropagation();
      session.finishWith({ key: event.key, shiftKey: event.shiftKey });
      return;
    }
    // Backspace or Delete before the editor came: what was selected (the whole value) goes.
    if (event.key === 'Backspace' || event.key === 'Delete') session.markTyped();
    // Every other key stays in the text area: no grid or page shortcut sees it.
    event.stopPropagation();
  }

  private settle(session: Session, cancelled: boolean): void {
    if (session.isSettled) return;
    clearTimeout(this.timer);
    session.settle(cancelled);
    const sink = this.sink;
    if (sink !== null && this.session === session) {
      this.sink = null;
      sink.remove();
    }
  }
}
