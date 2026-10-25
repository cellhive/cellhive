/**
 * CodeMirror injects its CSS with `style-mod`, which adds a `<style>`
 * element to a document — blocked by the app's CSP (`style-src 'self'`,
 * FRONTEND §12) — and uses a constructed stylesheet (`adoptedStyleSheets`,
 * CSSOM, not restricted by `style-src`) only for shadow roots, i.e. roots
 * without `head`. The first editor of the page is therefore created while
 * `document.head` reads `null`: `style-mod` then keeps a constructed sheet
 * for the document, and every later editor reuses it. No `<style>` element,
 * no `'unsafe-inline'`.
 */
let adopted = false;

export function withConstructedStyles<T>(create: () => T): T {
  if (adopted || typeof document === 'undefined' || !('adoptedStyleSheets' in document)) {
    return create();
  }
  Object.defineProperty(document, 'head', { configurable: true, get: () => null });
  try {
    const created = create();
    adopted = true;
    return created;
  } finally {
    // The own property goes; `Document.prototype.head` answers again.
    Reflect.deleteProperty(document, 'head');
  }
}
