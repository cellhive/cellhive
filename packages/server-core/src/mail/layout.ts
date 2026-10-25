import { escapeHtml } from './html.js';

/**
 * Fixed email layout (ADR-32 §3, BACKLOG T513): one column at most 600 px
 * wide inside an outer table, system fonts, styles written inline, `light
 * dark` color scheme; no background images, web fonts or remote CSS.
 *
 * The body is produced elsewhere: the Markdown renderer of
 * `packages/markdown` (T529) implements `EmailBodyRenderer`, emitting only
 * allowlisted tags styled with `EMAIL_ELEMENT_STYLES`, plus the `text/plain`
 * alternative from the same AST. This module only wraps the two parts.
 */

/** One rendered part pair: an HTML fragment (no `<html>`/`<body>`) and its plain-text twin. */
export interface EmailBody {
  readonly html: string;
  readonly text: string;
}

/** Turns some source (a Markdown template and its values, T529) into an `EmailBody`. */
export interface EmailBodyRenderer<TSource> {
  render(source: TSource): EmailBody;
}

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO_STACK = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** Colors with enough contrast both as is and when a client inverts them (dark mode). */
export const EMAIL_COLORS = {
  page: '#f4f5f7',
  card: '#ffffff',
  text: '#1f2328',
  muted: '#57606a',
  border: '#d0d7de',
  link: '#0b57d0',
  codeBackground: '#f3f4f6',
} as const;

/**
 * Inline `style` of every tag the body renderer may emit (ADR-32 §3
 * allowlist). The renderer copies these; nothing else sets `style`.
 */
export const EMAIL_ELEMENT_STYLES = {
  p: 'margin:0 0 12px 0;',
  h1: 'margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:600;',
  h2: 'margin:0 0 12px 0;font-size:18px;line-height:1.3;font-weight:600;',
  h3: 'margin:0 0 12px 0;font-size:16px;line-height:1.3;font-weight:600;',
  ul: 'margin:0 0 12px 0;padding:0 0 0 24px;',
  ol: 'margin:0 0 12px 0;padding:0 0 0 24px;',
  li: 'margin:0 0 4px 0;',
  blockquote: `margin:0 0 12px 0;padding:0 0 0 12px;border-left:3px solid ${EMAIL_COLORS.border};color:${EMAIL_COLORS.muted};`,
  hr: `border:0;border-top:1px solid ${EMAIL_COLORS.border};margin:16px 0;`,
  a: `color:${EMAIL_COLORS.link};text-decoration:underline;`,
  code: `font-family:${MONO_STACK};font-size:13px;background-color:${EMAIL_COLORS.codeBackground};padding:1px 4px;border-radius:3px;`,
  pre: `margin:0 0 12px 0;padding:8px 12px;font-family:${MONO_STACK};font-size:13px;background-color:${EMAIL_COLORS.codeBackground};border-radius:4px;white-space:pre-wrap;word-break:break-word;`,
  table: 'border-collapse:collapse;margin:0 0 12px 0;width:100%;',
  th: `border:1px solid ${EMAIL_COLORS.border};padding:6px 8px;text-align:left;font-weight:600;`,
  td: `border:1px solid ${EMAIL_COLORS.border};padding:6px 8px;text-align:left;vertical-align:top;`,
} as const;

export const EMAIL_MAX_WIDTH_PX = 600;

export interface EmailLayoutInput {
  /** `lang` of the document (`en`, `vi`, …). */
  readonly lang: string;
  /** Document `<title>`: the subject. */
  readonly title: string;
  /** Hidden preview line shown by mail clients next to the subject. */
  readonly preheader?: string | null;
  /** Body (signature included, T531). */
  readonly body: EmailBody;
  /** Footer (T531), below a rule; `null`/absent = none. */
  readonly footer?: EmailBody | null;
}

/** Separator between body and footer in the plain-text part. */
export const TEXT_FOOTER_SEPARATOR = '\n\n---\n';

/**
 * Long words — a record link (`{{ [@url] }}`), an address, a code — break
 * inside the 600 px card instead of widening it past a phone screen or the
 * builder's preview (T527). `word-break` is what WebKit/Blink mail clients use
 * for the table's minimum width; `overflow-wrap` the standard one.
 */
const WRAP_LONG_WORDS = 'word-break:break-word;overflow-wrap:anywhere;';

/** The complete HTML document and plain-text part of a message. */
export function renderEmailLayout(input: EmailLayoutInput): EmailBody {
  const lang = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.lang) ? input.lang : 'en';
  const preheader =
    input.preheader === undefined || input.preheader === null || input.preheader === ''
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${EMAIL_COLORS.page};">${escapeHtml(input.preheader)}</div>\n`;
  const footer =
    input.footer === undefined || input.footer === null
      ? ''
      : `<tr><td style="padding:16px 24px 24px 24px;border-top:1px solid ${EMAIL_COLORS.border};font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${EMAIL_COLORS.muted};${WRAP_LONG_WORDS}">${input.footer.html}</td></tr>\n`;
  const html =
    '<!doctype html>\n' +
    `<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="x-apple-disable-message-reformatting">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    '<meta name="supported-color-schemes" content="light dark">\n' +
    `<title>${escapeHtml(input.title)}</title>\n</head>\n` +
    `<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.page};">\n` +
    preheader +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.page};">\n` +
    '<tr><td align="center" style="padding:24px 12px;">\n' +
    `<table role="presentation" width="${String(EMAIL_MAX_WIDTH_PX)}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${String(EMAIL_MAX_WIDTH_PX)}px;background-color:${EMAIL_COLORS.card};border:1px solid ${EMAIL_COLORS.border};border-radius:6px;">\n` +
    `<tr><td style="padding:24px;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:${EMAIL_COLORS.text};${WRAP_LONG_WORDS}">${input.body.html}</td></tr>\n` +
    footer +
    '</table>\n</td></tr>\n</table>\n</body>\n</html>\n';
  const text =
    input.footer === undefined || input.footer === null
      ? `${input.body.text.trimEnd()}\n`
      : `${input.body.text.trimEnd()}${TEXT_FOOTER_SEPARATOR}${input.footer.text.trimEnd()}\n`;
  return { html, text };
}
