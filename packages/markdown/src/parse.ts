/**
 * The narrow Markdown of Cellhive (ADR-32 §3, FRONTEND §12), moved from the
 * web (T529): paragraphs and line breaks, `#`–`###` headings, `-`/`*` and
 * `1.` lists, `> ` quotes, fenced code, `---` rules, pipe tables,
 * `**bold**`, `*italic*`/`_italic_`, `~~strike~~`, `` `code` `` and
 * `[text](url)` links (http, https, mailto only). No raw HTML: `<` is text.
 * The tree is rendered by the web as React elements and by `toHtml` /
 * `toText` for email.
 */
import { safeHref } from './href.js';
import { IMAGE_ALT_CHAR, MAX_IMAGE_ALT, parseImageTarget, unescapeImageAlt } from './images.js';
import { MAX_BLOCKQUOTE_DEPTH, MAX_INLINE_DEPTH, MAX_LINK_TEXT } from './limits.js';
import { ESCAPABLE_CLASS, normalizeNewlines } from './text-utils.js';

import type { Block, ImageSource, Inline, TableAlign } from './ast.js';

/** Hooks of the template parser (`parseTemplate`); a plain document uses the defaults. */
export interface ParseContext {
  /** The href to keep for `[text](raw)`, or `null` to leave the whole link as text. */
  readonly acceptHref: (raw: string) => string | null;
  /** Image sources parsed as `image` nodes (BACKLOG T534); none by default. */
  readonly images?: readonly ImageSource[];
  /** The alternative text to keep for `![raw](…)`, or `null` to leave the image as text. */
  readonly acceptImageAlt?: (raw: string) => string | null;
}

/** Options of `parseMarkdown` / `parseTemplate`. */
export interface ParseOptions {
  /**
   * Image sources to parse (BACKLOG T534): email signatures take
   * `['asset']`, email bodies `['asset', 'field']`. Default none: image
   * syntax stays text (`!` then a link, or text).
   */
  readonly images?: readonly ImageSource[];
}

const DOCUMENT: ParseContext = { acceptHref: safeHref };
const IMAGE = new RegExp(
  String.raw`^!\[(${IMAGE_ALT_CHAR}{0,${String(MAX_IMAGE_ALT)}})\]\(([^)\n]{1,80})\)`,
  'u',
);

const HEADING = /^(#{1,3})\s+(.*)$/u;
const BULLET = /^[-*]\s+(.*)$/u;
const ORDERED = /^\d{1,9}[.)]\s+(.*)$/u;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/u;
const QUOTE = /^ {0,3}> ?(.*)$/u;
const DELIMITER_CELL = /^:?-+:?$/u;
const ESCAPABLE = new RegExp(ESCAPABLE_CLASS, 'u');
const LINK = new RegExp(`^\\[([^\\]\\n]{1,${String(MAX_LINK_TEXT)}})\\]\\(([^)\\s]+)\\)`, 'u');

const identity = (value: string): string => value;

function pushText(out: Inline[], text: string): void {
  if (text === '') return;
  const last = out.at(-1);
  if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + text };
  else out.push({ type: 'text', text });
}

/** `**`/`~~` (pair) or `*`/`_` (single) markup at `index`: its children and the index after it. */
function delimited(
  source: string,
  index: number,
  marker: string,
): { inner: string; end: number } | null {
  if (!source.startsWith(marker, index)) return null;
  const close = source.indexOf(marker, index + marker.length);
  if (close <= index + marker.length) return null;
  if (marker.length === 1 && source[index + 1] === ' ') return null;
  return { inner: source.slice(index + marker.length, close), end: close + marker.length };
}

function inline(source: string, depth: number, context: ParseContext): Inline[] {
  const out: Inline[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === '\n') {
      out.push({ type: 'break' });
      index += 1;
      continue;
    }
    if (char === '\\' && index + 1 < source.length && ESCAPABLE.test(source[index + 1] ?? '')) {
      pushText(out, source[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        out.push({ type: 'code', text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    if (char === '!' && source[index + 1] === '[' && (context.images?.length ?? 0) > 0) {
      const match = IMAGE.exec(source.slice(index));
      const alt =
        match === null
          ? null
          : (context.acceptImageAlt ?? identity)(unescapeImageAlt(match[1] ?? ''));
      const image =
        match === null || alt === null
          ? null
          : parseImageTarget(match[2] ?? '', alt.trim(), context.images ?? []);
      if (match !== null && image !== null) {
        out.push(image);
        index += match[0].length;
        continue;
      }
    }
    if (depth < MAX_INLINE_DEPTH) {
      const strong = delimited(source, index, '**');
      if (strong !== null) {
        out.push({ type: 'strong', children: inline(strong.inner, depth + 1, context) });
        index = strong.end;
        continue;
      }
      const del = delimited(source, index, '~~');
      if (del !== null) {
        out.push({ type: 'del', children: inline(del.inner, depth + 1, context) });
        index = del.end;
        continue;
      }
      const em = char === '*' || char === '_' ? delimited(source, index, char) : null;
      if (em !== null) {
        out.push({ type: 'em', children: inline(em.inner, depth + 1, context) });
        index = em.end;
        continue;
      }
      if (char === '[') {
        const link = LINK.exec(source.slice(index));
        const href = link === null ? null : context.acceptHref(link[2] ?? '');
        if (link !== null && href !== null) {
          out.push({ type: 'link', href, children: inline(link[1] ?? '', depth + 1, context) });
          index += link[0].length;
          continue;
        }
      }
    }
    pushText(out, char);
    index += 1;
  }
  return out;
}

/** Inline markup of one block; `\n` inside a paragraph is a line break. */
export function parseInline(source: string, depth = 0): Inline[] {
  return inline(source, depth, DOCUMENT);
}

/** Cells of a table row: split on unescaped `|`, without the outer pipes. */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index] ?? '';
    if (char === '\\' && row[index + 1] === '|') {
      cell += '\\|';
      index += 1;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Column alignments when `line` is a delimiter row with `columns` cells, else `null`. */
function delimiterRow(line: string, columns: number): TableAlign[] | null {
  if (!line.includes('-')) return null;
  const cells = tableCells(line);
  if (cells.length !== columns || !cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : null;
  });
}

function blocks(lines: readonly string[], quoteDepth: number, context: ParseContext): Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push({ type: 'paragraph', children: inline(paragraph.join('\n'), 0, context) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list !== null) {
      out.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };
  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd();
    index += 1;
    if (line.trim() === '') {
      flush();
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const marker = fence[1] ?? '```';
      const code: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        index += 1;
        const trimmed = next.trim();
        if (trimmed.startsWith(marker) && trimmed.split('').every((c) => c === marker[0])) break;
        code.push(next);
      }
      const text = code.join('\n');
      out.push({ type: 'code_block', children: text === '' ? [] : [{ type: 'text', text }] });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const level = (heading[1] ?? '#').length as 1 | 2 | 3;
      out.push({ type: 'heading', level, children: inline(heading[2] ?? '', 0, context) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push({ type: 'hr' });
      continue;
    }
    if (quoteDepth < MAX_BLOCKQUOTE_DEPTH && QUOTE.test(line)) {
      flush();
      const quoted: string[] = [QUOTE.exec(line)?.[1] ?? ''];
      while (index < lines.length) {
        const next = QUOTE.exec((lines[index] ?? '').trimEnd());
        if (next === null) break;
        quoted.push(next[1] ?? '');
        index += 1;
      }
      out.push({ type: 'blockquote', children: blocks(quoted, quoteDepth + 1, context) });
      continue;
    }
    if (line.includes('|') && index < lines.length) {
      const head = tableCells(line);
      const align = delimiterRow((lines[index] ?? '').trimEnd(), head.length);
      if (align !== null) {
        flush();
        index += 1;
        const rows: Inline[][][] = [];
        while (index < lines.length) {
          const next = (lines[index] ?? '').trimEnd();
          if (next.trim() === '' || !next.includes('|')) break;
          const cells = tableCells(next);
          rows.push(head.map((_, column) => inline(cells[column] ?? '', 0, context)));
          index += 1;
        }
        out.push({
          type: 'table',
          align,
          head: head.map((cell) => inline(cell, 0, context)),
          rows,
        });
        continue;
      }
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    const item = bullet ?? ordered;
    if (item !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (list !== null && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(inline(item[1] ?? '', 0, context));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flush();
  return out;
}

/** Parses with the hooks of `context` (used by `parseTemplate`). */
export function parseWith(source: string, context: ParseContext): Block[] {
  return blocks(normalizeNewlines(source).split('\n'), 0, context);
}

/**
 * Blocks of a Markdown text (line endings normalized, blank lines separate
 * blocks); `options.images` turns `![alt](asset:…)`/`(field:…)` into images.
 */
export function parseMarkdown(source: string, options: ParseOptions = {}): Block[] {
  return parseWith(
    source,
    options.images === undefined ? DOCUMENT : { ...DOCUMENT, images: options.images },
  );
}
