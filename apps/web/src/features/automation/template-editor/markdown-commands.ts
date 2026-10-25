/**
 * Toolbar commands of the Markdown template editor (T522; board "S5 ·
 * Email template editor"): each inserts the narrow Markdown syntax of
 * `packages/markdown` (never HTML) — around the selection (`wrap`) or as a
 * line of its own (`block`). Keyboard shortcuts: Ctrl/⌘+B, I, K.
 */

export type MarkdownCommandId =
  'bold' | 'italic' | 'strike' | 'link' | 'bullet' | 'numbered' | 'quote' | 'rule' | 'table';

export type MarkdownCommand =
  | {
      readonly kind: 'wrap';
      readonly before: string;
      readonly after: string;
      /** What is selected when nothing was (translated by the editor). */
      readonly fallback: 'text' | 'linkText';
      readonly shortcut?: string;
    }
  | { readonly kind: 'block'; readonly text: string };

export const LINK_PLACEHOLDER_URL = 'https://';

export const MARKDOWN_COMMANDS: Readonly<Record<MarkdownCommandId, MarkdownCommand>> = {
  bold: { kind: 'wrap', before: '**', after: '**', fallback: 'text', shortcut: 'b' },
  italic: { kind: 'wrap', before: '*', after: '*', fallback: 'text', shortcut: 'i' },
  strike: { kind: 'wrap', before: '~~', after: '~~', fallback: 'text' },
  link: {
    kind: 'wrap',
    before: '[',
    after: `](${LINK_PLACEHOLDER_URL})`,
    fallback: 'linkText',
    shortcut: 'k',
  },
  bullet: { kind: 'block', text: '- ' },
  numbered: { kind: 'block', text: '1. ' },
  quote: { kind: 'block', text: '> ' },
  rule: { kind: 'block', text: '\n---\n' },
  // A table for the lines of a `digest` (one row per record).
  table: { kind: 'block', text: '| | |\n| --- | --- |\n| | |\n' },
};

/** The toolbar in its order, groups separated (board: inline marks | blocks). */
export const TOOLBAR_GROUPS: readonly (readonly MarkdownCommandId[])[] = [
  ['bold', 'italic', 'strike', 'link'],
  ['bullet', 'numbered', 'quote', 'rule', 'table'],
];

/** The command of a Ctrl/⌘ shortcut key, if any. */
export function commandOfShortcut(key: string): MarkdownCommandId | null {
  const lower = key.toLowerCase();
  for (const [id, command] of Object.entries(MARKDOWN_COMMANDS)) {
    if (command.kind === 'wrap' && command.shortcut === lower) return id as MarkdownCommandId;
  }
  return null;
}

/** Characters of a stored template source, as the contract counts them (`max(20 000)`). */
export function sourceLength(source: string): number {
  return source.length;
}
