/**
 * Template syntax (SPEC §11.4, ADR-32 §3): literal text with `{{ formula }}`
 * placeholders. This module only cuts a template into parts; it imports
 * nothing, so `@cellhive/markdown` can use the same scanner
 * (`@cellhive/formula-engine/template/split`) for email bodies and both
 * agree on where every placeholder starts and ends.
 *
 * - The expression is formula syntax (SPEC §9.2): `}}` inside a `"string"`
 *   or a `[name]` (with their `\"`, `\]` escapes) does not close it.
 * - `\{` is a literal brace, `\\` a literal backslash (so `\{{ x }}` reads
 *   `{{ x }}`); any other backslash is kept.
 * - An unterminated placeholder makes the rest of the template text; an
 *   empty one (`{{ }}`) stays text; past `maxPlaceholders` the rest is text.
 *   Each case is reported as an issue with its position.
 */

/** Placeholders of one template; the following ones stay text (`TOO_MANY_PLACEHOLDERS`). */
export const MAX_TEMPLATE_PLACEHOLDERS = 1_000;

export type TemplateSyntaxCode =
  'UNTERMINATED_PLACEHOLDER' | 'EMPTY_PLACEHOLDER' | 'TOO_MANY_PLACEHOLDERS';

/** A syntax problem of the template; positions in UTF-16 code units of the source. */
export interface TemplateSyntaxIssue {
  readonly code: TemplateSyntaxCode;
  readonly start: number;
  readonly length: number;
}

/** Literal text (escapes resolved) and the source span it comes from. */
export interface TemplateTextPart {
  readonly kind: 'text';
  readonly text: string;
  readonly start: number;
  readonly length: number;
}

/** One `{{ … }}`: `start`/`length` cover the braces, `expressionStart` the trimmed expression. */
export interface TemplateExpressionPart {
  readonly kind: 'expression';
  /** Position among the placeholders (0-based, source order). */
  readonly index: number;
  /** The expression between the braces, trimmed. */
  readonly expression: string;
  readonly start: number;
  readonly length: number;
  readonly expressionStart: number;
}

export type TemplatePart = TemplateTextPart | TemplateExpressionPart;

export interface SplitTemplate {
  readonly parts: readonly TemplatePart[];
  readonly issues: readonly TemplateSyntaxIssue[];
}

export interface SplitOptions {
  /** Default `MAX_TEMPLATE_PLACEHOLDERS`. */
  readonly maxPlaceholders?: number;
}

/** Index after the quoted run (`"…"` or `[…]`) opening at `index`, or -1 when unterminated. */
function skipQuoted(source: string, index: number, close: string): number {
  let at = index + 1;
  while (at < source.length) {
    const char = source[at];
    if (char === '\\') at += 2;
    else if (char === close) return at + 1;
    else at += 1;
  }
  return -1;
}

/**
 * Index right after the `}}` closing a placeholder whose expression starts
 * at `from` (just after `{{`), or -1 when it never closes.
 */
export function placeholderEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const char = source[at];
    if (char === '"') at = skipQuoted(source, at, '"');
    else if (char === '[') at = skipQuoted(source, at, ']');
    else if (char === '}' && source[at + 1] === '}') return at + 2;
    else at += 1;
    if (at === -1) return -1;
  }
  return -1;
}

/** Cuts a template into literal text and `{{ expression }}` parts (see the module comment). */
export function splitTemplate(source: string, options: SplitOptions = {}): SplitTemplate {
  const max = options.maxPlaceholders ?? MAX_TEMPLATE_PLACEHOLDERS;
  const parts: TemplatePart[] = [];
  const issues: TemplateSyntaxIssue[] = [];
  let text = '';
  let textStart = 0;
  let placeholders = true;
  let count = 0;
  let index = 0;

  const flush = (end: number): void => {
    if (text !== '') parts.push({ kind: 'text', text, start: textStart, length: end - textStart });
    text = '';
    textStart = end;
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1];
    if (char === '\\' && (next === '{' || next === '\\')) {
      text += next;
      index += 2;
      continue;
    }
    if (placeholders && char === '{' && next === '{') {
      const end = placeholderEnd(source, index + 2);
      if (end === -1) {
        issues.push({
          code: 'UNTERMINATED_PLACEHOLDER',
          start: index,
          length: source.length - index,
        });
        placeholders = false;
      } else if (source.slice(index + 2, end - 2).trim() === '') {
        issues.push({ code: 'EMPTY_PLACEHOLDER', start: index, length: end - index });
        text += source.slice(index, end);
        index = end;
        continue;
      } else if (count >= max) {
        issues.push({ code: 'TOO_MANY_PLACEHOLDERS', start: index, length: end - index });
        placeholders = false;
      } else {
        const raw = source.slice(index + 2, end - 2);
        const expressionStart = index + 2 + raw.length - raw.trimStart().length;
        flush(index);
        parts.push({
          kind: 'expression',
          index: count,
          expression: raw.trim(),
          start: index,
          length: end - index,
          expressionStart,
        });
        count += 1;
        index = end;
        textStart = end;
        continue;
      }
    }
    text += char;
    index += 1;
  }
  flush(source.length);
  return { parts, issues };
}
