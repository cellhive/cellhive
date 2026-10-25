/**
 * The tree of the narrow Markdown (ADR-32 §3, FRONTEND §12). `X` is the
 * extra inline node a tree may hold: nothing for a document
 * (`Inline`/`Block`), placeholders and templated links for a template
 * (`TemplateInline`/`TemplateBlock`) until `substitute` turns them into text.
 */

export interface TextNode {
  readonly type: 'text';
  readonly text: string;
}

export interface BreakNode {
  readonly type: 'break';
}

export interface CodeNode {
  readonly type: 'code';
  readonly text: string;
}

export interface StrongNode<X> {
  readonly type: 'strong';
  readonly children: readonly InlineOf<X>[];
}

export interface EmNode<X> {
  readonly type: 'em';
  readonly children: readonly InlineOf<X>[];
}

export interface DelNode<X> {
  readonly type: 'del';
  readonly children: readonly InlineOf<X>[];
}

/** A link; `href` passed `safeHref` (http, https, mailto). */
export interface LinkNode<X> {
  readonly type: 'link';
  readonly href: string;
  readonly children: readonly InlineOf<X>[];
}

/** Where an email image comes from (BACKLOG T534): an uploaded email asset or an attachment field. */
export type ImageSource = 'asset' | 'field';

/**
 * An email image (BACKLOG T534), only parsed when the caller allows images
 * (`parseTemplate(source, { images })`, `parseMarkdown(source, { images })`):
 * `![alt](asset:att_…)` — an image uploaded for the email — or
 * `![alt](field:fld_…)` — the images of an attachment field of the trigger
 * record. Never a URL: the server turns it into inline `cid:` parts, the web
 * into a short-lived URL of the viewer. `width` from ` =N` (1–600 px).
 */
export interface ImageNode {
  readonly type: 'image';
  readonly source: ImageSource;
  /** `att_…` for an asset, `fld_…` for a field. */
  readonly id: string;
  readonly alt: string;
  readonly width: number | null;
}

export type InlineOf<X> =
  | TextNode
  | BreakNode
  | CodeNode
  | StrongNode<X>
  | EmNode<X>
  | DelNode<X>
  | LinkNode<X>
  | ImageNode
  | X;

export interface ParagraphNode<X> {
  readonly type: 'paragraph';
  readonly children: readonly InlineOf<X>[];
}

export interface HeadingNode<X> {
  readonly type: 'heading';
  readonly level: 1 | 2 | 3;
  readonly children: readonly InlineOf<X>[];
}

export interface ListNode<X> {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly items: readonly (readonly InlineOf<X>[])[];
}

export interface BlockquoteNode<X> {
  readonly type: 'blockquote';
  readonly children: readonly BlockOf<X>[];
}

/** A fenced code block; its children are only text (and placeholders in a template). */
export interface CodeBlockNode<X> {
  readonly type: 'code_block';
  readonly children: readonly InlineOf<X>[];
}

export interface HrNode {
  readonly type: 'hr';
}

export type TableAlign = 'left' | 'center' | 'right' | null;

/** A pipe table; every row has as many cells as `head` (and `align`). */
export interface TableNode<X> {
  readonly type: 'table';
  readonly align: readonly TableAlign[];
  readonly head: readonly (readonly InlineOf<X>[])[];
  readonly rows: readonly (readonly (readonly InlineOf<X>[])[])[];
}

export type BlockOf<X> =
  | ParagraphNode<X>
  | HeadingNode<X>
  | ListNode<X>
  | BlockquoteNode<X>
  | CodeBlockNode<X>
  | HrNode
  | TableNode<X>;

export type Inline = InlineOf<never>;
export type Block = BlockOf<never>;

/**
 * A `{{ … }}` of a template: an opaque node until `substitute`. `expression`
 * is the text between the braces, trimmed; `start`/`length` locate the whole
 * `{{ … }}` in the template source; `index` numbers placeholders in source
 * order (the index of its value). `code` = inside an inline code span.
 */
export interface PlaceholderNode {
  readonly type: 'placeholder';
  readonly index: number;
  readonly expression: string;
  readonly start: number;
  readonly length: number;
  readonly code: boolean;
}

/**
 * A link whose target holds placeholders: either one placeholder for the
 * whole URL (a URL field — a link only if the value passes `safeHref`), or a
 * literal `https://host/` or `mailto:` prefix followed by path/query parts
 * whose values are `encodeURIComponent`-ed.
 */
export interface LinkTemplateNode {
  readonly type: 'link_template';
  readonly href: readonly (string | PlaceholderNode)[];
  readonly children: readonly TemplateInline[];
}

export type TemplateInline = InlineOf<PlaceholderNode | LinkTemplateNode>;
export type TemplateBlock = BlockOf<PlaceholderNode | LinkTemplateNode>;
