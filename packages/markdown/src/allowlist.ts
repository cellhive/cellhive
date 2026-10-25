/**
 * What the HTML renderer may produce (ADR-32 §3). The server's second layer
 * (`sanitize-html`, `server-core/src/mail/render/sanitize.ts`) is configured
 * from these same lists, so the two cannot drift apart.
 */

export const HTML_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // Email images (BACKLOG T534): only `src="cid:…"` (inline parts of the message), `alt`, `width`.
  'img',
] as const;

export type HtmlTag = (typeof HTML_ALLOWED_TAGS)[number];

/** Attributes besides `style` (allowed on every tag, written only by the renderer). */
export const HTML_LINK_ATTRIBUTES = {
  rel: 'noopener noreferrer',
  target: '_blank',
} as const;

/** URL schemes of `a[href]`. */
export const HTML_ALLOWED_SCHEMES = ['http', 'https', 'mailto'] as const;

/**
 * `img` attributes besides `style` (BACKLOG T534): `src` only with the
 * `cid:` scheme (a part of the same message — never a remote URL, `data:`
 * or a signed URL), `alt`, and `width` in pixels.
 */
export const HTML_IMAGE_ATTRIBUTES = ['src', 'alt', 'width'] as const;
/** The one scheme of `img[src]`. */
export const HTML_IMAGE_SCHEMES = ['cid'] as const;
/** A Content-ID the renderer may reference (`cid:<this>`). */
export const HTML_IMAGE_CID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}@[A-Za-z0-9.-]{1,60}$/u;
/** `img[width]`: 1–600 pixels. */
export const HTML_IMAGE_WIDTH = /^(?:[1-9]\d{0,1}|[1-5]\d{2}|600)$/u;

const LENGTH = String.raw`(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|%))`;
const COLOR = String.raw`#[0-9a-fA-F]{3,8}`;
const exact = (pattern: string) => new RegExp(`^(?:${pattern})$`, 'u');

/**
 * CSS properties the renderer's inline `style` may use, each with the only
 * values it accepts: no `url(`, `expression(`, `@import` or anything else
 * that loads or runs something.
 */
export const HTML_ALLOWED_STYLES: Readonly<Record<string, readonly RegExp[]>> = {
  margin: [exact(`${LENGTH}(?: ${LENGTH}){0,3}`)],
  padding: [exact(`${LENGTH}(?: ${LENGTH}){0,3}`)],
  'font-size': [exact(LENGTH)],
  'line-height': [exact(String.raw`\d(?:\.\d{1,2})?|${LENGTH}`)],
  'font-weight': [exact('normal|bold|[1-9]00')],
  'font-family': [exact(String.raw`[A-Za-z0-9 ,'-]+`)],
  'font-style': [exact('normal|italic')],
  color: [exact(COLOR)],
  'background-color': [exact(COLOR)],
  border: [exact(`0|${LENGTH} (?:solid|dashed|dotted) ${COLOR}`)],
  'border-top': [exact(`0|${LENGTH} (?:solid|dashed|dotted) ${COLOR}`)],
  'border-left': [exact(`0|${LENGTH} (?:solid|dashed|dotted) ${COLOR}`)],
  'border-radius': [exact(LENGTH)],
  'border-collapse': [exact('collapse')],
  width: [exact(LENGTH)],
  'max-width': [exact(LENGTH)],
  height: [exact('auto')],
  'text-align': [exact('left|center|right')],
  'vertical-align': [exact('top|middle|bottom')],
  'white-space': [exact('normal|pre-wrap')],
  'text-decoration': [exact('underline|none|line-through')],
  'overflow-wrap': [exact('break-word|normal')],
};
