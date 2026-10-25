/**
 * The `text/plain` part of an email from the same tree as its HTML
 * (ADR-32 §3): markup dropped, links as `text (url)`, lists with `-` /
 * `1.`, quotes with `> `, table cells joined with ` | `, images as
 * `[alt]` (BACKLOG T534).
 */
import { cleanText } from './text-utils.js';

import type { Block, ImageNode, Inline } from './ast.js';

/** How `toText` writes images. */
export interface TextOptions {
  /**
   * The alternative texts an `image` node stands for (one per image the
   * HTML shows); default: the node's own alternative text.
   */
  readonly images?: (node: ImageNode) => readonly { readonly alt: string }[];
}

const OWN_ALT = (node: ImageNode): readonly { readonly alt: string }[] => [{ alt: node.alt }];

class TextRenderer {
  constructor(private readonly images: NonNullable<TextOptions['images']>) {}

  inline(nodes: readonly Inline[]): string {
    let text = '';
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
        case 'code':
          text += node.text;
          break;
        case 'break':
          text += '\n';
          break;
        case 'strong':
        case 'em':
        case 'del':
          text += this.inline(node.children);
          break;
        case 'link': {
          const label = this.inline(node.children);
          const shown = node.href.replace(/^mailto:/iu, '');
          text += label === node.href || label === shown ? label : `${label} (${node.href})`;
          break;
        }
        case 'image':
          text += this.images(node)
            .map((image) => image.alt.trim())
            .filter((alt) => alt !== '')
            .map((alt) => `[${alt}]`)
            .join(' ');
          break;
      }
    }
    return text;
  }

  block(node: Block): string {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        return this.inline(node.children);
      case 'list':
        return node.items
          .map(
            (item, index) => `${node.ordered ? `${String(index + 1)}.` : '-'} ${this.inline(item)}`,
          )
          .join('\n');
      case 'blockquote':
        return this.blocks(node.children)
          .split('\n')
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n');
      case 'code_block':
        return this.inline(node.children);
      case 'hr':
        return '----------';
      case 'table':
        return [node.head, ...node.rows]
          .map((row) => row.map((cell) => this.inline(cell)).join(' | '))
          .join('\n');
    }
  }

  blocks(nodes: readonly Block[]): string {
    return nodes.map((node) => this.block(node)).join('\n\n');
  }
}

/** The plain-text rendering of a document (substitute a template first). */
export function toText(nodes: readonly Block[], options: TextOptions = {}): string {
  return cleanText(new TextRenderer(options.images ?? OWN_ALT).blocks(nodes));
}
