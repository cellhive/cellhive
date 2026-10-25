/**
 * Templates (ADR-32 §3, "parse first, substitute later"): every `{{ … }}`
 * is cut out of the source **before** the Markdown parser runs and becomes
 * an opaque `placeholder` node; `substitute` later replaces each one with
 * text nodes. A value therefore never reaches the parser: it cannot create a
 * link, heading, table cell or HTML, and nothing needs escaping.
 *
 * The expression between the braces is formula syntax (SPEC §9.2, §11.4):
 * `}}` inside a `"string"` or a `[name]` does not close the placeholder —
 * the scanner is the one of `@cellhive/formula-engine` (BACKLOG T504), so
 * automations see the same placeholders, in the same order.
 * `\{` keeps a literal brace. In a link target a placeholder is only allowed
 * as the whole URL (a URL field: a link only if the value passes
 * `safeHref`) or after a literal `https://host/` or `mailto:` prefix (values
 * `encodeURIComponent`-ed); anywhere else the link stays text.
 */
import { placeholderEnd } from '@cellhive/formula-engine/template/split';

import { safeHref } from './href.js';
import { MAX_PLACEHOLDERS } from './limits.js';
import { parseWith, type ParseOptions } from './parse.js';
import { cleanText, normalizeNewlines } from './text-utils.js';

import type {
  Block,
  BlockOf,
  Inline,
  LinkTemplateNode,
  PlaceholderNode,
  TemplateBlock,
  TemplateInline,
} from './ast.js';

export type TemplateIssueCode =
  | 'UNTERMINATED_PLACEHOLDER'
  | 'EMPTY_PLACEHOLDER'
  | 'TOO_MANY_PLACEHOLDERS'
  | 'PLACEHOLDER_IN_LINK_NOT_ALLOWED';

/** A problem of the template source; the part it points at stays text. */
export interface TemplateIssue {
  readonly code: TemplateIssueCode;
  readonly start: number;
  readonly length: number;
}

export interface ParsedTemplate {
  readonly blocks: readonly TemplateBlock[];
  /** Placeholders in source order (`index` = position of its value). */
  readonly placeholders: readonly PlaceholderNode[];
  readonly issues: readonly TemplateIssue[];
}

/**
 * Placeholders, and private-use characters already in the source, travel
 * through the Markdown parser as one private-use character each
 * (U+E000 + token number), so the parser never sees expression text.
 */
type Token = { readonly kind: 'placeholder'; readonly node: PlaceholderNode } | string;

const TOKEN_BASE = 0xe000;
const TOKEN_CAPACITY = 0xf8ff - TOKEN_BASE + 1;
const MAX_LITERAL_TOKENS = TOKEN_CAPACITY - MAX_PLACEHOLDERS;
const PRIVATE_USE = /[-]/u;

const HTTPS_PREFIX = /^https:\/\/[^/?#\s]+[/?#]/iu;
const MAILTO_PREFIX = /^mailto:/iu;

class TemplateParser {
  readonly tokens: Token[] = [];
  readonly issues: TemplateIssue[] = [];
  /** Final node of each placeholder (with `code` set), by index. */
  readonly placed = new Map<number, PlaceholderNode>();
  private placeholderCount = 0;
  private literalCount = 0;

  constructor(private readonly source: string) {}

  private token(token: Token): string {
    this.tokens.push(token);
    return String.fromCharCode(TOKEN_BASE + this.tokens.length - 1);
  }

  private issue(issue: TemplateIssue): void {
    if (!this.issues.some((known) => known.start === issue.start && known.code === issue.code)) {
      this.issues.push(issue);
    }
  }

  /** The source with placeholders and private-use characters replaced by tokens. */
  extract(): string {
    const { source } = this;
    let out = '';
    let placeholders = true;
    let index = 0;
    while (index < source.length) {
      const char = source[index] ?? '';
      if (char === '\\' && (source[index + 1] === '{' || source[index + 1] === '\\')) {
        out += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (PRIVATE_USE.test(char)) {
        this.literalCount += 1;
        out += this.literalCount > MAX_LITERAL_TOKENS ? '�' : this.token(char);
        index += 1;
        continue;
      }
      if (placeholders && char === '{' && source[index + 1] === '{') {
        const end = placeholderEnd(source, index + 2);
        if (end === -1) {
          this.issue({
            code: 'UNTERMINATED_PLACEHOLDER',
            start: index,
            length: source.length - index,
          });
          placeholders = false;
        } else if (source.slice(index + 2, end - 2).trim() === '') {
          this.issue({ code: 'EMPTY_PLACEHOLDER', start: index, length: end - index });
          out += source.slice(index, end);
          index = end;
          continue;
        } else if (this.placeholderCount >= MAX_PLACEHOLDERS) {
          this.issue({ code: 'TOO_MANY_PLACEHOLDERS', start: index, length: end - index });
          placeholders = false;
        } else {
          const node: PlaceholderNode = {
            type: 'placeholder',
            index: this.placeholderCount,
            expression: source.slice(index + 2, end - 2).trim(),
            start: index,
            length: end - index,
            code: false,
          };
          this.placeholderCount += 1;
          out += this.token({ kind: 'placeholder', node });
          index = end;
          continue;
        }
      }
      out += char;
      index += 1;
    }
    return out;
  }

  /** Literal text and placeholders of a parsed string. */
  split(value: string): (string | PlaceholderNode)[] {
    const parts: (string | PlaceholderNode)[] = [];
    let text = '';
    for (const char of value) {
      const code = char.charCodeAt(0);
      const token = char.length === 1 ? this.tokens[code - TOKEN_BASE] : undefined;
      if (token === undefined) text += char;
      else if (typeof token === 'string') text += token;
      else {
        if (text !== '') parts.push(text);
        text = '';
        parts.push(token.node);
      }
    }
    if (text !== '') parts.push(text);
    return parts;
  }

  /** `acceptHref` of the parser: which `[text](target)` stay links. */
  acceptHref = (raw: string): string | null => {
    const parts = this.split(raw);
    const first = parts[0];
    const placeholder = parts.find((part) => typeof part !== 'string');
    if (placeholder === undefined) {
      return safeHref(typeof first === 'string' ? first : '') === null ? null : raw;
    }
    const sample = parts.map((part) => (typeof part === 'string' ? part : 'x')).join('');
    const allowed =
      parts.length === 1 ||
      (typeof first === 'string' &&
        (MAILTO_PREFIX.test(first) || HTTPS_PREFIX.test(first)) &&
        safeHref(sample) !== null);
    if (allowed) return raw;
    this.issue({
      code: 'PLACEHOLDER_IN_LINK_NOT_ALLOWED',
      start: placeholder.start,
      length: placeholder.length,
    });
    return null;
  };

  /** `acceptImageAlt` of the parser: literal text only (a placeholder keeps the image as text). */
  acceptImageAlt = (raw: string): string | null => {
    const parts = this.split(raw);
    if (parts.some((part) => typeof part !== 'string')) return null;
    return parts.map((part) => (typeof part === 'string' ? part : '')).join('');
  };

  private place(node: PlaceholderNode, code: boolean): PlaceholderNode {
    const placed = code ? { ...node, code } : node;
    this.placed.set(node.index, placed);
    return placed;
  }

  inline(nodes: readonly Inline[]): TemplateInline[] {
    const out: TemplateInline[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          for (const part of this.split(node.text)) {
            out.push(
              typeof part === 'string' ? { type: 'text', text: part } : this.place(part, false),
            );
          }
          break;
        case 'code':
          for (const part of this.split(node.text)) {
            out.push(
              typeof part === 'string' ? { type: 'code', text: part } : this.place(part, true),
            );
          }
          break;
        case 'link': {
          const children = this.inline(node.children);
          const href = this.split(node.href).map((part) =>
            typeof part === 'string' ? part : this.place(part, false),
          );
          if (href.every((part) => typeof part === 'string')) {
            out.push({ type: 'link', href: href.join(''), children });
          } else {
            out.push({ type: 'link_template', href, children });
          }
          break;
        }
        case 'strong':
        case 'em':
        case 'del':
          out.push({ type: node.type, children: this.inline(node.children) });
          break;
        default:
          out.push(node);
      }
    }
    return out;
  }

  blocks(blocks: readonly Block[]): TemplateBlock[] {
    return blocks.map((block): TemplateBlock => {
      switch (block.type) {
        case 'paragraph':
        case 'code_block':
          return { type: block.type, children: this.inline(block.children) };
        case 'heading':
          return { type: 'heading', level: block.level, children: this.inline(block.children) };
        case 'list':
          return {
            type: 'list',
            ordered: block.ordered,
            items: block.items.map((item) => this.inline(item)),
          };
        case 'blockquote':
          return { type: 'blockquote', children: this.blocks(block.children) };
        case 'table':
          return {
            type: 'table',
            align: block.align,
            head: block.head.map((cell) => this.inline(cell)),
            rows: block.rows.map((row) => row.map((cell) => this.inline(cell))),
          };
        default:
          return block;
      }
    });
  }
}

/**
 * Parses a template: Markdown blocks with `placeholder` nodes for each
 * `{{ … }}`. With `options.images` (BACKLOG T534), `![alt](asset:…)` /
 * `(field:…)` of the template source become `image` nodes — only literal
 * syntax: an alternative text or target with a placeholder stays text, so a
 * value can never create an image.
 */
export function parseTemplate(source: string, options: ParseOptions = {}): ParsedTemplate {
  const parser = new TemplateParser(source);
  const tokenized = parser.extract();
  const blocks = parser.blocks(
    parseWith(tokenized, {
      acceptHref: parser.acceptHref,
      ...(options.images === undefined
        ? {}
        : { images: options.images, acceptImageAlt: parser.acceptImageAlt }),
    }),
  );
  const placeholders = [...parser.placed.values()].sort((a, b) => a.index - b.index);
  const issues = [...parser.issues].sort((a, b) => a.start - b.start);
  return { blocks, placeholders, issues };
}

/** Values of placeholders: by `index`, or computed from the node. A missing value is empty. */
export type PlaceholderValues = readonly string[] | ((placeholder: PlaceholderNode) => string);

function pushMerged(out: Inline[], node: Inline): void {
  const last = out.at(-1);
  if (node.type === 'text' || node.type === 'code') {
    if (node.text === '') return;
    if (last?.type === node.type) {
      out[out.length - 1] = { type: node.type, text: last.text + node.text };
      return;
    }
  }
  out.push(node);
}

class Substitution {
  constructor(private readonly values: PlaceholderValues) {}

  value(placeholder: PlaceholderNode): string {
    const raw =
      typeof this.values === 'function'
        ? this.values(placeholder)
        : (this.values[placeholder.index] ?? '');
    return cleanText(normalizeNewlines(raw));
  }

  href(node: LinkTemplateNode): string | null {
    const [only] = node.href;
    if (node.href.length === 1 && only !== undefined && typeof only !== 'string') {
      return safeHref(this.value(only));
    }
    const href = node.href
      .map((part) => (typeof part === 'string' ? part : encodeURIComponent(this.value(part))))
      .join('');
    return safeHref(href);
  }

  inline(nodes: readonly TemplateInline[], preformatted = false): Inline[] {
    const out: Inline[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case 'placeholder': {
          const value = this.value(node);
          if (node.code) pushMerged(out, { type: 'code', text: value.replace(/\n/gu, ' ') });
          else if (preformatted) pushMerged(out, { type: 'text', text: value });
          else {
            value.split('\n').forEach((line, index) => {
              if (index > 0) out.push({ type: 'break' });
              pushMerged(out, { type: 'text', text: line });
            });
          }
          break;
        }
        case 'link_template': {
          const children = this.inline(node.children);
          const href = this.href(node);
          if (href === null) for (const child of children) pushMerged(out, child);
          else out.push({ type: 'link', href, children });
          break;
        }
        case 'link':
          out.push({ type: 'link', href: node.href, children: this.inline(node.children) });
          break;
        case 'strong':
        case 'em':
        case 'del':
          out.push({ type: node.type, children: this.inline(node.children) });
          break;
        default:
          pushMerged(out, node);
      }
    }
    return out;
  }

  blocks(blocks: readonly TemplateBlock[]): Block[] {
    const out: Block[] = [];
    for (const block of blocks) {
      const next = this.block(block);
      if (next !== null) out.push(next);
    }
    return out;
  }

  /** The block with values in place; `null` when a paragraph, heading or quote became empty. */
  private block(block: TemplateBlock): Block | null {
    switch (block.type) {
      case 'paragraph':
      case 'heading': {
        const children = this.inline(block.children);
        if (children.length === 0) return null;
        return block.type === 'heading'
          ? { type: 'heading', level: block.level, children }
          : { type: 'paragraph', children };
      }
      case 'code_block':
        return { type: 'code_block', children: this.inline(block.children, true) };
      case 'list':
        return {
          type: 'list',
          ordered: block.ordered,
          items: block.items.map((item) => this.inline(item)),
        };
      case 'blockquote': {
        const children = this.blocks(block.children);
        return children.length === 0 ? null : { type: 'blockquote', children };
      }
      case 'table':
        return {
          type: 'table',
          align: block.align,
          head: block.head.map((cell) => this.inline(cell)),
          rows: block.rows.map((row) => row.map((cell) => this.inline(cell))),
        };
      default:
        return block satisfies BlockOf<never>;
    }
  }
}

/**
 * Replaces every placeholder with its value as **text** (a line feed in a
 * value is a line break). The result is a plain document for `toHtml` /
 * `toText`; values never go through the Markdown parser.
 */
export function substitute(blocks: readonly TemplateBlock[], values: PlaceholderValues): Block[] {
  return new Substitution(values).blocks(blocks);
}
