import { EMAIL_IDENTITY_SIGNATURE_MAX, EMAIL_SIGNATURE_MAX_IMAGES } from '@cellhive/contracts';
import {
  collectImages,
  imageSyntaxIssues,
  parseMarkdown,
  type Block,
  type ImageSource,
  type Inline,
} from '@cellhive/markdown';

/**
 * Signatures (ADR-33 §3, CONTRACTS §23.4): narrow Markdown of
 * `@cellhive/markdown`, at most 2,000 characters, no placeholders, at most
 * two images uploaded for signatures (`![alt](asset:att_…)`, T534). The
 * editor checks what the server checks (`checkSignature`) and previews what
 * the email shows (`signatureBlocks`: images as `image` nodes; any other
 * `![alt](url)` is its alternative text only).
 */

/** Signature images: uploaded signature assets only. */
export const SIGNATURE_IMAGES: readonly ImageSource[] = ['asset'];

export type SignatureIssue =
  | { readonly code: 'TOO_BIG'; readonly maximum: number }
  | { readonly code: 'PLACEHOLDER_NOT_ALLOWED'; readonly position: number }
  | { readonly code: 'IMAGE_SOURCE_NOT_ALLOWED'; readonly position: number }
  | { readonly code: 'TOO_MANY_IMAGES'; readonly maximum: number };

/** Characters (code points), as the server counts them. */
export function signatureLength(source: string): number {
  return Array.from(source).length;
}

export function signatureIssue(source: string): SignatureIssue | null {
  if (signatureLength(source) > EMAIL_IDENTITY_SIGNATURE_MAX) {
    return { code: 'TOO_BIG', maximum: EMAIL_IDENTITY_SIGNATURE_MAX };
  }
  const position = source.indexOf('{{');
  if (position >= 0) return { code: 'PLACEHOLDER_NOT_ALLOWED', position };
  const [image] = imageSyntaxIssues(source, SIGNATURE_IMAGES);
  if (image !== undefined) return { code: 'IMAGE_SOURCE_NOT_ALLOWED', position: image.start };
  const images = collectImages(parseMarkdown(source, { images: SIGNATURE_IMAGES }));
  return images.length > EMAIL_SIGNATURE_MAX_IMAGES
    ? { code: 'TOO_MANY_IMAGES', maximum: EMAIL_SIGNATURE_MAX_IMAGES }
    : null;
}

/** How many images a signature shows (the "Insert image" button stops at the maximum). */
export function signatureImageCount(source: string): number {
  return collectImages(parseMarkdown(source, { images: SIGNATURE_IMAGES })).length;
}

/** Inline nodes with image syntax that is not an image (`!` before a link) replaced by the link text. */
function withoutImages(nodes: readonly Inline[]): Inline[] {
  const result: Inline[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (node.type === 'link' && previous?.type === 'text' && previous.text.endsWith('!')) {
      const rest = previous.text.slice(0, -1);
      result.pop();
      if (rest !== '') result.push({ type: 'text', text: rest });
      result.push(...withoutImages(node.children));
      continue;
    }
    switch (node.type) {
      case 'strong':
      case 'em':
      case 'del':
        result.push({ type: node.type, children: withoutImages(node.children) });
        break;
      case 'link':
        result.push({ type: 'link', href: node.href, children: withoutImages(node.children) });
        break;
      default:
        result.push(node);
    }
  }
  return result;
}

function blockWithoutImages(block: Block): Block {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', children: withoutImages(block.children) };
    case 'heading':
      return { type: 'heading', level: block.level, children: withoutImages(block.children) };
    case 'list':
      return { type: 'list', ordered: block.ordered, items: block.items.map(withoutImages) };
    case 'blockquote':
      return { type: 'blockquote', children: block.children.map(blockWithoutImages) };
    case 'table':
      return {
        type: 'table',
        align: block.align,
        head: block.head.map(withoutImages),
        rows: block.rows.map((row) => row.map(withoutImages)),
      };
    case 'code_block':
    case 'hr':
      return block;
  }
}

/** The signature as the email shows it; `[]` when blank. */
export function signatureBlocks(source: string): Block[] {
  if (source.trim() === '') return [];
  return parseMarkdown(source, { images: SIGNATURE_IMAGES }).map(blockWithoutImages);
}

/**
 * Inserts the Markdown of an uploaded image in place of the selection, on a
 * line of its own; the caret goes after it.
 */
export function insertImage(value: string, start: number, end: number, markdown: string): TextEdit {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n';
  const inserted = `${lead}${markdown}${trail}`;
  const caret = start + lead.length + markdown.length;
  return { value: `${before}${inserted}${after}`, selectionStart: caret, selectionEnd: caret };
}

export type SignatureFormat = 'bold' | 'italic' | 'link' | 'list';

export interface TextEdit {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * The toolbar of the editor inserts Markdown syntax (never HTML) around the
 * selection: `**…**`, `_…_`, `[…](https://)` (the URL selected to type
 * over), `- ` at the start of each selected line.
 */
export function applyFormat(
  value: string,
  start: number,
  end: number,
  format: SignatureFormat,
  placeholder: string,
): TextEdit {
  const selected = value.slice(start, end);
  const text = selected === '' ? placeholder : selected;
  const before = value.slice(0, start);
  const after = value.slice(end);
  switch (format) {
    case 'bold':
    case 'italic': {
      const mark = format === 'bold' ? '**' : '_';
      return {
        value: `${before}${mark}${text}${mark}${after}`,
        selectionStart: start + mark.length,
        selectionEnd: start + mark.length + text.length,
      };
    }
    case 'link': {
      const url = 'https://';
      const inserted = `[${text}](${url})`;
      const urlStart = start + text.length + 3;
      return {
        value: `${before}${inserted}${after}`,
        selectionStart: urlStart,
        selectionEnd: urlStart + url.length,
      };
    }
    case 'list': {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      // No selection: the whole line of the caret.
      const lineBreak = value.indexOf('\n', end);
      let lineEnd = end;
      if (start === end) lineEnd = lineBreak === -1 ? value.length : lineBreak;
      const block = value.slice(lineStart, lineEnd);
      const lines = (block === '' ? text : block).split('\n');
      const listed = lines.map((line) => (line.startsWith('- ') ? line : `- ${line}`)).join('\n');
      const head = value.slice(0, lineStart);
      const tail = value.slice(lineEnd);
      return {
        value: `${head}${listed}${tail}`,
        selectionStart: lineStart,
        selectionEnd: lineStart + listed.length,
      };
    }
  }
}
