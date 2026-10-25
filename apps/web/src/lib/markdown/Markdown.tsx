import { cn } from '@cellhive/ui';
import { useMemo, type ReactNode } from 'react';

import { parseMarkdown, type Block, type ImageNode, type Inline } from './parse';

/**
 * Where an email image (`image` node, T534) is shown from: a URL of the
 * viewer (the API answers with a short-lived signed URL), or `null` to show
 * its alternative text instead.
 */
export type MarkdownImageUrl = (node: ImageNode) => string | null;

const NO_IMAGES: MarkdownImageUrl = () => null;

function renderImage(node: ImageNode, index: number, images: MarkdownImageUrl): ReactNode {
  const url = images(node);
  if (url === null) return node.alt === '' ? null : `[${node.alt}]`;
  return (
    <img
      key={index}
      src={url}
      alt={node.alt}
      width={node.width ?? undefined}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="inline-block h-auto max-w-full align-middle"
    />
  );
}

function renderInline(nodes: readonly Inline[], images: MarkdownImageUrl): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'break':
        return <br key={index} />;
      case 'strong':
        return <strong key={index}>{renderInline(node.children, images)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children, images)}</em>;
      case 'del':
        return <del key={index}>{renderInline(node.children, images)}</del>;
      case 'code':
        return (
          <code key={index} className="rounded-sm bg-surface-sunken px-1 font-mono text-mono">
            {node.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {renderInline(node.children, images)}
          </a>
        );
      case 'image':
        return renderImage(node, index, images);
      default:
        return null;
    }
  });
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

function renderBlocks(blocks: readonly Block[], images: MarkdownImageUrl): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'heading':
        return (
          <p key={index} className={block.level === 1 ? 'text-heading' : 'text-body font-semibold'}>
            {renderInline(block.children, images)}
          </p>
        );
      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item, images)}</li>
        ));
        return block.ordered ? (
          <ol key={index} className="flex list-decimal flex-col gap-1 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
            {items}
          </ul>
        );
      }
      case 'blockquote':
        return (
          <blockquote
            key={index}
            className="flex flex-col gap-2 border-l-2 border-line pl-3 text-fg-muted"
          >
            {renderBlocks(block.children, images)}
          </blockquote>
        );
      case 'code_block':
        return (
          <pre
            key={index}
            className="rounded-sm bg-surface-sunken p-2 font-mono text-mono whitespace-pre-wrap"
          >
            <code>{renderInline(block.children, images)}</code>
          </pre>
        );
      case 'hr':
        return <hr key={index} className="border-line" />;
      case 'table': {
        const cell = (Tag: 'th' | 'td', content: readonly Inline[], column: number) => {
          const align = block.align[column];
          return (
            <Tag
              key={column}
              className={cn(
                'border border-line px-2 py-1 align-top',
                Tag === 'th' && 'font-semibold',
                align == null ? 'text-left' : ALIGN[align],
              )}
            >
              {renderInline(content, images)}
            </Tag>
          );
        };
        return (
          <div key={index} className="overflow-x-auto">
            <table className="border-collapse">
              <thead>
                <tr>{block.head.map((content, column) => cell('th', content, column))}</tr>
              </thead>
              {block.rows.length > 0 && (
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((content, column) => cell('td', content, column))}
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        );
      }
      default:
        return <p key={index}>{renderInline(block.children, images)}</p>;
    }
  });
}

export type MarkdownProps = (
  | { readonly source: string; readonly blocks?: undefined }
  /** A document parsed (and transformed) by the caller, e.g. an email signature with its images. */
  | { readonly blocks: readonly Block[]; readonly source?: undefined }
) & {
  readonly className?: string | undefined;
  /** Email images of `blocks` (T534); default: their alternative text. */
  readonly imageUrl?: MarkdownImageUrl | undefined;
};

/**
 * User-written Markdown (FRONTEND §12): the narrow syntax of
 * `@cellhive/markdown` as React elements — never HTML strings. Headings keep
 * the page outline (they are styled paragraphs), links open in a new tab
 * without the opener or referrer. Image nodes exist only in documents
 * parsed with images (email signatures, T534) and show from `imageUrl`.
 */
export function Markdown({ source, blocks: given, className, imageUrl }: MarkdownProps) {
  const parsed = useMemo(() => (source === undefined ? null : parseMarkdown(source)), [source]);
  const blocks = given ?? parsed ?? [];
  if (blocks.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-2 break-words', className)}>
      {renderBlocks(blocks, imageUrl ?? NO_IMAGES)}
    </div>
  );
}
