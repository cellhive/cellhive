import {
  HTML_ALLOWED_SCHEMES,
  HTML_ALLOWED_STYLES,
  HTML_ALLOWED_TAGS,
  HTML_IMAGE_ATTRIBUTES,
  HTML_IMAGE_CID,
  HTML_IMAGE_SCHEMES,
  HTML_IMAGE_WIDTH,
  HTML_LINK_ATTRIBUTES,
} from '@cellhive/markdown';
import sanitizeHtml from 'sanitize-html';

/**
 * An `img` the email may keep (T534): `src` is `cid:` + a Content-ID the
 * renderer could have written, `width` (if any) 1–600 pixels. Anything else
 * — a remote URL, `data:`, a signed URL, no `src` — drops the element.
 */
function invalidImage(frame: sanitizeHtml.IFrame): boolean {
  if (frame.tag !== 'img') return false;
  const src = frame.attribs['src'] ?? '';
  const width = frame.attribs['width'];
  return (
    !src.startsWith('cid:') ||
    !HTML_IMAGE_CID.test(src.slice(4)) ||
    (width !== undefined && !HTML_IMAGE_WIDTH.test(width))
  );
}

/**
 * Second layer of the email body (ADR-32 §3, T529): the HTML of
 * `@cellhive/markdown`'s `toHtml` already contains only allowlisted tags,
 * so this pass must leave it unchanged (tested on the renderer's fixtures);
 * it exists in case a renderer bug ever lets something through. Configured
 * from the renderer's own allowlist: the tags, `a[href]` with http/https/
 * mailto only plus the fixed `rel`/`target`, `img` only with `src="cid:…"`,
 * `alt` and a pixel `width` (T534), and `style` declarations matching
 * `HTML_ALLOWED_STYLES`. Anything else is dropped, and the text of dropped
 * `script`/`style`/`textarea`/`option` elements too.
 *
 * Runs on the body fragment, before the fixed email layout wraps it.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...HTML_ALLOWED_TAGS],
  allowedAttributes: {
    '*': ['style'],
    a: [
      'href',
      { name: 'rel', multiple: false, values: [HTML_LINK_ATTRIBUTES.rel] },
      { name: 'target', multiple: false, values: [HTML_LINK_ATTRIBUTES.target] },
    ],
    img: [...HTML_IMAGE_ATTRIBUTES],
  },
  allowedSchemes: [...HTML_ALLOWED_SCHEMES],
  allowedSchemesByTag: { img: [...HTML_IMAGE_SCHEMES] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  exclusiveFilter: invalidImage,
  allowProtocolRelative: false,
  allowedStyles: { '*': { ...HTML_ALLOWED_STYLES } as Record<string, RegExp[]> },
  allowVulnerableTags: false,
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: false,
  parseStyleAttributes: true,
};

/** The email body HTML with everything outside the renderer's allowlist removed. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
