import { MAX_TEMPLATE_PLACEHOLDERS } from '@cellhive/formula-engine/template/split';

/** Inline markup deeper than this stays text (`**_~~[…]~~_**` is four levels). */
export const MAX_INLINE_DEPTH = 4;
/** Blockquotes nested deeper than this keep their `>` as text. */
export const MAX_BLOCKQUOTE_DEPTH = 3;
/** A link text longer than this is not a link (keeps parsing linear in the source). */
export const MAX_LINK_TEXT = 1_000;
/**
 * Placeholders of one template; the following ones stay text
 * (`TOO_MANY_PLACEHOLDERS`). The limit of automation templates, so both
 * count the same placeholders (BACKLOG T504).
 */
export const MAX_PLACEHOLDERS = MAX_TEMPLATE_PLACEHOLDERS;
/** Markdown source of an email body (ADR-32 §3); enforced by the caller (T514). */
export const MAX_EMAIL_SOURCE_CHARS = 20_000;
/** Default of `EMAIL_MAX_HTML_BYTES` (ADR-32 §3): Gmail clips messages near 102 KB. */
export const DEFAULT_EMAIL_MAX_HTML_BYTES = 100 * 1024;
