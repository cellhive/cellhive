/**
 * The document of the sandboxed email preview (T522, ADR-32 §3).
 *
 * The server renders a whole HTML email with inline `style` attributes
 * (fixed layout, CONTRACTS §23.1). The preview shows it in an
 * `<iframe sandbox srcdoc>` with neither `allow-scripts` nor
 * `allow-same-origin`. A `srcdoc` document inherits the app's CSP
 * (`style-src 'self'`, FRONTEND §12), which refuses inline styles, so the
 * email's own styles would be dropped (and reported as violations). The
 * frame therefore gets the same look from one stylesheet of the app
 * (`email-preview-frame.css`, same origin, mirroring `EMAIL_ELEMENT_STYLES`
 * of the server layout) and the inline styles and `<style>` elements are
 * taken out first. Its own CSP (`<meta>`) narrows things further: nothing
 * but that stylesheet and the email's inline images, no script, no form,
 * no base.
 *
 * Inline images (T534): the email references them as `cid:`; the preview
 * response lists a signed storage URL of the viewer for each Content-ID
 * (`images[]`). Those `src` become the URLs and `img-src` allows exactly
 * their origin(s); any other image source is dropped (`img-src 'none'`
 * without images).
 *
 * Parsing uses `DOMParser` (an inert document: no script runs, nothing
 * loads); only the serialized markup reaches the frame.
 */

/** An inline image of the preview: its Content-ID and the viewer's signed URL. */
export interface PreviewImage {
  readonly cid: string;
  readonly url: string;
}

export interface PreviewDocumentOptions {
  /** Absolute URL of the frame stylesheet (from the app's origin). */
  readonly stylesheet: string;
  /** Inline images of the email (`images[]` of the preview, CONTRACTS §21). */
  readonly images?: readonly PreviewImage[];
}

/**
 * The frame's own policy: only the stylesheet and images from `imageOrigins`
 * (the storage origin of the signed URLs); nothing else.
 */
export function previewPolicy(stylesheet: string, imageOrigins: readonly string[] = []): string {
  return [
    "default-src 'none'",
    `style-src ${stylesheet}`,
    `img-src ${imageOrigins.length === 0 ? "'none'" : imageOrigins.join(' ')}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The http(s) URL of each Content-ID; anything else is not an image source. */
function imageUrls(images: readonly PreviewImage[]): Map<string, URL> {
  const urls = new Map<string, URL>();
  for (const image of images) {
    let url: URL;
    try {
      url = new URL(image.url);
    } catch {
      continue;
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') urls.set(image.cid, url);
  }
  return urls;
}

const CID = /^cid:/iu;

const REMOVED = 'script, style, link, meta[http-equiv], base, iframe, object, embed, form';

const STYLE_ELEMENT = /<style\b[^>]*>[\s\S]*?<\/style\s*>/giu;
const TAG = /<[A-Za-z][^>]*>/gu;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;

/**
 * Inline styles out of the markup before any parsing: even an inert
 * document (`DOMParser`) applies the page's CSP to `style` attributes and
 * `<style>` elements and reports each one. Only inside tags — text of the
 * server's HTML never holds a raw `<`.
 */
function withoutInlineStyles(html: string): string {
  return html.replace(STYLE_ELEMENT, '').replace(TAG, (tag) => tag.replace(STYLE_ATTRIBUTE, ''));
}

/** The email HTML made ready for `srcdoc`. */
export function previewDocument(html: string, options: PreviewDocumentOptions): string {
  const parsed = new DOMParser().parseFromString(withoutInlineStyles(html), 'text/html');
  parsed.querySelectorAll(REMOVED).forEach((element) => {
    element.remove();
  });
  parsed.querySelectorAll('[style]').forEach((element) => {
    element.removeAttribute('style');
  });
  // `cid:` images show through the viewer's signed URLs; no other source loads.
  const urls = imageUrls(options.images ?? []);
  const origins = new Set<string>();
  parsed.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? '';
    image.removeAttribute('srcset');
    const url = CID.test(src) ? urls.get(src.replace(CID, '')) : undefined;
    if (url === undefined) {
      image.removeAttribute('src');
      return;
    }
    image.setAttribute('src', url.href);
    origins.add(url.origin);
  });
  // Event handler attributes never run in the sandbox; drop them all the same.
  parsed.querySelectorAll('*').forEach((element) => {
    for (const name of element.getAttributeNames()) {
      if (name.toLowerCase().startsWith('on')) element.removeAttribute(name);
    }
  });
  const head = parsed.head;
  const policy = parsed.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', previewPolicy(options.stylesheet, [...origins]));
  const sheet = parsed.createElement('link');
  sheet.setAttribute('rel', 'stylesheet');
  sheet.setAttribute('href', options.stylesheet);
  head.prepend(policy, sheet);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}
