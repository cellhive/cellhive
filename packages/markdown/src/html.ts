/**
 * Email HTML from the document tree (ADR-32 §3): only the tags of
 * `HTML_ALLOWED_TAGS`, text always escaped, links only with a `safeHref`
 * target plus `rel="noopener noreferrer" target="_blank"`, and `style`
 * attributes only from the layout's fixed styles. The result is the body
 * fragment; the fixed 600 px email layout around it (T513) and the
 * `sanitize-html` second layer are applied by the server.
 */
import { HTML_IMAGE_CID, HTML_LINK_ATTRIBUTES } from './allowlist.js';
import { MAX_IMAGE_WIDTH } from './images.js';
import { escapeAttribute, escapeHtml } from './text-utils.js';

import type { Block, ImageNode, Inline, TableAlign } from './ast.js';

/**
 * One image as the email shows it (BACKLOG T534): an inline part of the
 * message referenced by its Content-ID — never a URL.
 */
export interface HtmlImage {
  /** Content-ID of the part, without `<>` (`att_…@cellhive`). */
  readonly cid: string;
  readonly alt: string;
  /** Width in pixels (≤ 600), or `null` to let the layout size it. */
  readonly width: number | null;
}

/** The images an `image` node stands for (none: it is left out). */
export type ImageResolver = (node: ImageNode) => readonly HtmlImage[];

/** Inline CSS of each element (declarations separated by `;`, no trailing `;`). */
export interface HtmlStyles {
  readonly p: string;
  readonly h1: string;
  readonly h2: string;
  readonly h3: string;
  readonly ul: string;
  readonly ol: string;
  readonly li: string;
  readonly blockquote: string;
  readonly hr: string;
  readonly pre: string;
  readonly code: string;
  readonly a: string;
  readonly table: string;
  readonly th: string;
  readonly td: string;
  /** Email images (T534); default `DEFAULT_IMAGE_STYLE`. */
  readonly img?: string;
}

/** Style of an email image: never wider than the column, no border (Outlook adds one to linked images). */
export const DEFAULT_IMAGE_STYLE = 'max-width:100%;height:auto;border:0';

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/**
 * Styles of the body in the fixed email layout: inline (no `<style>`, which
 * several clients drop), system fonts inherited from the layout, colours
 * readable when a client inverts them for dark mode.
 */
export const DEFAULT_EMAIL_STYLES: HtmlStyles = {
  p: 'margin:0 0 16px 0',
  h1: 'margin:0 0 16px 0;font-size:24px;line-height:1.3;font-weight:600',
  h2: 'margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600',
  h3: 'margin:0 0 8px 0;font-size:16px;line-height:1.4;font-weight:600',
  ul: 'margin:0 0 16px 0;padding:0 0 0 24px',
  ol: 'margin:0 0 16px 0;padding:0 0 0 24px',
  li: 'margin:0 0 4px 0',
  blockquote: 'margin:0 0 16px 0;padding:0 0 0 12px;border-left:3px solid #d0d7de;color:#57606a',
  hr: 'border:0;border-top:1px solid #d0d7de;margin:24px 0',
  pre: `margin:0 0 16px 0;padding:12px;background-color:#f6f8fa;border-radius:6px;white-space:pre-wrap;overflow-wrap:break-word;font-family:${MONO};font-size:13px`,
  code: `padding:1px 4px;background-color:#f6f8fa;border-radius:4px;font-family:${MONO};font-size:90%`,
  a: 'color:#0969da;text-decoration:underline',
  table: 'margin:0 0 16px 0;border-collapse:collapse;width:100%',
  th: 'padding:6px 8px;border:1px solid #d0d7de;font-weight:600;vertical-align:top',
  td: 'padding:6px 8px;border:1px solid #d0d7de;vertical-align:top',
  img: DEFAULT_IMAGE_STYLE,
};

/** How `toHtml` styles the elements; the default is the email layout. */
export interface HtmlLayout {
  readonly styles?: HtmlStyles;
  /**
   * The inline parts of each `image` node (BACKLOG T534); without it, or
   * when it returns none, the image is left out of the HTML. Only a valid
   * Content-ID becomes `<img src="cid:…">`.
   */
  readonly images?: ImageResolver;
}

const NO_IMAGES: ImageResolver = () => [];

class HtmlRenderer {
  constructor(
    private readonly styles: HtmlStyles,
    private readonly images: ImageResolver,
  ) {}

  private image(node: ImageNode): string {
    let html = '';
    for (const image of this.images(node)) {
      if (!HTML_IMAGE_CID.test(image.cid)) continue;
      const width =
        image.width === null || !Number.isInteger(image.width) || image.width < 1
          ? ''
          : ` width="${String(Math.min(image.width, MAX_IMAGE_WIDTH))}"`;
      const style = this.styles.img ?? DEFAULT_IMAGE_STYLE;
      html +=
        `<img src="cid:${escapeAttribute(image.cid)}" alt="${escapeAttribute(image.alt)}"${width}` +
        `${style === '' ? '' : ` style="${escapeAttribute(style)}"`} />`;
    }
    return html;
  }

  private open(tag: string, style: string, extra = ''): string {
    return style === '' ? `<${tag}${extra}>` : `<${tag}${extra} style="${escapeAttribute(style)}">`;
  }

  private element(tag: Exclude<keyof HtmlStyles, 'img'>, content: string): string {
    return `${this.open(tag, this.styles[tag])}${content}</${tag}>`;
  }

  inline(nodes: readonly Inline[]): string {
    let html = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          html += escapeHtml(node.text);
          break;
        case 'break':
          html += '<br />';
          break;
        case 'code':
          html += this.element('code', escapeHtml(node.text));
          break;
        case 'strong':
        case 'em':
        case 'del':
          html += `<${node.type}>${this.inline(node.children)}</${node.type}>`;
          break;
        case 'link': {
          const attributes =
            ` href="${escapeAttribute(node.href)}"` +
            ` rel="${HTML_LINK_ATTRIBUTES.rel}" target="${HTML_LINK_ATTRIBUTES.target}"`;
          html += `${this.open('a', this.styles.a, attributes)}${this.inline(node.children)}</a>`;
          break;
        }
        case 'image':
          html += this.image(node);
          break;
      }
    }
    return html;
  }

  private cell(tag: 'th' | 'td', align: TableAlign | undefined, content: readonly Inline[]) {
    const style = [this.styles[tag], align == null ? '' : `text-align:${align}`]
      .filter((part) => part !== '')
      .join(';');
    return `${this.open(tag, style)}${this.inline(content)}</${tag}>`;
  }

  blocks(blocks: readonly Block[]): string {
    let html = '';
    for (const block of blocks) {
      switch (block.type) {
        case 'paragraph':
          html += this.element('p', this.inline(block.children));
          break;
        case 'heading':
          html += this.element(`h${String(block.level)}` as 'h1', this.inline(block.children));
          break;
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          const items = block.items.map((item) => this.element('li', this.inline(item))).join('');
          html += this.element(tag, items);
          break;
        }
        case 'blockquote':
          html += this.element('blockquote', this.blocks(block.children));
          break;
        case 'code_block':
          html += this.element('pre', `<code>${this.inline(block.children)}</code>`);
          break;
        case 'hr':
          html +=
            this.styles.hr === '' ? '<hr />' : `<hr style="${escapeAttribute(this.styles.hr)}" />`;
          break;
        case 'table': {
          const head = block.head.map((cell, column) => this.cell('th', block.align[column], cell));
          let table = `<thead><tr>${head.join('')}</tr></thead>`;
          if (block.rows.length > 0) {
            const rows = block.rows.map(
              (row) =>
                `<tr>${row.map((cell, column) => this.cell('td', block.align[column], cell)).join('')}</tr>`,
            );
            table += `<tbody>${rows.join('')}</tbody>`;
          }
          html += this.element('table', table);
          break;
        }
      }
    }
    return html;
  }
}

/** The HTML body fragment of a document (substitute a template first). */
export function toHtml(blocks: readonly Block[], layout: HtmlLayout = {}): string {
  return new HtmlRenderer(layout.styles ?? DEFAULT_EMAIL_STYLES, layout.images ?? NO_IMAGES).blocks(
    blocks,
  );
}
