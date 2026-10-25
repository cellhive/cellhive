/**
 * Email images of the narrow Markdown (BACKLOG T534, ADR-32 §3): the only
 * image syntax is `![alt](asset:att_…)` (an image uploaded for the email)
 * and `![alt](field:fld_…)` (images of an attachment field of the trigger
 * record), optionally followed by ` =<width>` in pixels. The alternative
 * text takes the escapes of inline text: `]` and `\` are written `\]` and
 * `\\` (a `\` before a character that is not escapable is itself). A
 * URL — remote, `data:`, `cid:` or anything else — is never an image:
 * documents keep it as text and the save paths refuse it
 * (`imageSyntaxIssues`).
 */
import { ESCAPABLE_CLASS } from './text-utils.js';

import type { BlockOf, ImageNode, ImageSource, InlineOf } from './ast.js';

/** Longest alternative text of an image. */
export const MAX_IMAGE_ALT = 200;
/** Widest image of the 600 px email layout. */
export const MAX_IMAGE_WIDTH = 600;
/** Every image source, for `parseMarkdown`/`parseTemplate` options. */
export const IMAGE_SOURCES: readonly ImageSource[] = ['asset', 'field'];

/**
 * One character of the alternative text in the source: an escape of inline
 * Markdown (`\]`, `\\`, `\{`…), a `\` before anything else, or any
 * character but `\`, `]` and a line break.
 */
export const IMAGE_ALT_CHAR = `(?:\\\\${ESCAPABLE_CLASS}|\\\\(?!${ESCAPABLE_CLASS})|[^\\\\\\]\\n])`;

const ALT_ESCAPE = new RegExp(`\\\\(${ESCAPABLE_CLASS})`, 'gu');

/**
 * The alternative text of `![…]` as written in the source: escapes resolved
 * like in inline text (`\]` → `]`, `\\` → `\`, `\{` → `{`).
 */
export function unescapeImageAlt(raw: string): string {
  return raw.replace(ALT_ESCAPE, '$1');
}

/** Alternative text for the source: `]` and `\` escaped, line breaks as spaces. */
export function escapeImageAlt(alt: string): string {
  return alt.replace(/[\n\r]/gu, ' ').replace(/[\\\]]/gu, (char) => `\\${char}`);
}

const PREFIX: Readonly<Record<ImageSource, string>> = { asset: 'att', field: 'fld' };
const TARGET = /^(asset|field):([a-z]{3}_[0-9A-Za-z]{16})(?: =(\d{1,4}))?$/u;

/**
 * The image of a target (`asset:att_… =160`), or `null` when it is not one
 * of `allowed` (a URL, another scheme, a malformed id).
 */
export function parseImageTarget(
  target: string,
  alt: string,
  allowed: readonly ImageSource[],
): ImageNode | null {
  const match = TARGET.exec(target);
  if (match === null) return null;
  const source = match[1] as ImageSource;
  const id = match[2] ?? '';
  if (!allowed.includes(source) || !id.startsWith(`${PREFIX[source]}_`)) return null;
  const raw = match[3] === undefined ? null : Number(match[3]);
  const width = raw === null || raw < 1 ? null : Math.min(raw, MAX_IMAGE_WIDTH);
  return { type: 'image', source, id, alt, width };
}

/** The Markdown of an image (what the editors insert); `]` and `\` of `alt` are escaped. */
export function imageMarkdown(image: Omit<ImageNode, 'type'>): string {
  const alt = escapeImageAlt(Array.from(image.alt).slice(0, MAX_IMAGE_ALT).join(''));
  const width = image.width === null ? '' : ` =${String(image.width)}`;
  return `![${alt}](${image.source}:${image.id}${width})`;
}

/** Image syntax anywhere in a source: `![alt](target)` not preceded by `\`. */
const IMAGE_SYNTAX = new RegExp(String.raw`!\[${IMAGE_ALT_CHAR}*\]\(([^)\n]*)\)`, 'gu');

export type ImageIssueCode = 'IMAGE_SOURCE_NOT_ALLOWED';

/** Image syntax whose target is not an allowed source (a URL, `data:`, `cid:`…). */
export interface ImageIssue {
  readonly code: ImageIssueCode;
  readonly start: number;
  readonly length: number;
}

/**
 * Image syntax of `source` that is not an allowed image: remote or `data:`
 * URLs, other schemes, a source of the wrong kind (`field:` in a
 * signature). The save paths refuse them so the author sees the image will
 * not be sent, instead of a silent alternative text.
 */
export function imageSyntaxIssues(
  source: string,
  allowed: readonly ImageSource[],
): readonly ImageIssue[] {
  const issues: ImageIssue[] = [];
  for (const match of source.matchAll(IMAGE_SYNTAX)) {
    const start = match.index;
    if (start > 0 && source[start - 1] === '\\') continue;
    if (parseImageTarget(match[1] ?? '', '', allowed) !== null) continue;
    issues.push({ code: 'IMAGE_SOURCE_NOT_ALLOWED', start, length: match[0].length });
  }
  return issues;
}

function inlineImages<X>(nodes: readonly InlineOf<X>[], out: ImageNode[]): void {
  for (const node of nodes) {
    const typed = node as { type?: unknown; children?: unknown };
    if (typed.type === 'image') out.push(node as ImageNode);
    else if (Array.isArray(typed.children)) inlineImages(typed.children as InlineOf<X>[], out);
  }
}

/** The images of a document or template, in source order. */
export function collectImages<X>(blocks: readonly BlockOf<X>[]): ImageNode[] {
  const out: ImageNode[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'code_block':
        inlineImages(block.children, out);
        break;
      case 'list':
        for (const item of block.items) inlineImages(item, out);
        break;
      case 'blockquote':
        out.push(...collectImages(block.children));
        break;
      case 'table':
        for (const cell of block.head) inlineImages(cell, out);
        for (const row of block.rows) for (const cell of row) inlineImages(cell, out);
        break;
      case 'hr':
        break;
    }
  }
  return out;
}
