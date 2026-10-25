/**
 * The Markdown parser moved to `@cellhive/markdown` (T529) so the web, the
 * email preview and the sent email share one implementation; re-exported
 * here for the existing imports.
 */
export {
  parseInline,
  parseMarkdown,
  safeHref,
  type Block,
  type ImageNode,
  type Inline,
} from '@cellhive/markdown';
