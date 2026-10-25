import { cn } from '@cellhive/ui';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { SampleNode } from './model';

export interface SampleTreeProps {
  readonly nodes: readonly SampleNode[];
  readonly label: string;
  readonly selectedId: string | null;
  readonly onSelect: (node: SampleNode) => void;
}

interface Visible {
  readonly node: SampleNode;
  readonly level: number;
  readonly parent: string | null;
}

/** The nodes on screen, in order: a node's children follow it when it is expanded. */
function visibleNodes(nodes: readonly SampleNode[], expanded: ReadonlySet<string>): Visible[] {
  const out: Visible[] = [];
  const walk = (items: readonly SampleNode[], level: number, parent: string | null) => {
    for (const node of items) {
      out.push({ node, level, parent });
      if (node.children.length > 0 && expanded.has(node.id))
        walk(node.children, level + 1, node.id);
    }
  };
  walk(nodes, 1, null);
  return out;
}

const expandable = (node: SampleNode) => node.children.length > 0;

/**
 * The captured sample as a tree (BACKLOG T612; WAI-ARIA "tree view"): one
 * tab stop, ↑/↓ move, → opens or goes to the first child, ← closes or goes
 * to the parent, Home/End, Enter/Space choose the path. The body starts
 * open, headers and query closed.
 */
export function SampleTree({ nodes, label, selectedId, onSelect }: SampleTreeProps) {
  const { t } = useTranslation('automationBuilder');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(nodes.filter((node) => node.part === 'body').map((node) => node.id)),
  );
  const [active, setActive] = useState<string | null>(null);
  const tree = useRef<HTMLUListElement>(null);
  const rowPrefix = useId();
  const visible = useMemo(() => visibleNodes(nodes, expanded), [nodes, expanded]);
  const activeId =
    visible.find((item) => item.node.id === active)?.node.id ??
    visible.find((item) => item.node.id === selectedId)?.node.id ??
    visible[0]?.node.id ??
    null;

  const focus = (id: string) => {
    setActive(id);
    const find = () =>
      tree.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? null;
    const target = find();
    // Every visible item is focusable (`tabIndex = -1`); one just rendered is focused after paint.
    if (target === null) window.requestAnimationFrame(() => find()?.focus());
    else target.focus();
  };
  const toggle = (id: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, item: Visible, index: number) => {
    const { node } = item;
    switch (event.key) {
      case 'ArrowDown': {
        const next = visible[index + 1];
        if (next !== undefined) focus(next.node.id);
        break;
      }
      case 'ArrowUp': {
        const previous = visible[index - 1];
        if (previous !== undefined) focus(previous.node.id);
        break;
      }
      case 'ArrowRight':
        if (!expandable(node)) break;
        if (!expanded.has(node.id)) toggle(node.id, true);
        else if (node.children[0] !== undefined) focus(node.children[0].id);
        break;
      case 'ArrowLeft':
        if (expandable(node) && expanded.has(node.id)) toggle(node.id, false);
        else if (item.parent !== null) focus(item.parent);
        break;
      case 'Home': {
        const first = visible[0];
        if (first !== undefined) focus(first.node.id);
        break;
      }
      case 'End': {
        const last = visible.at(-1);
        if (last !== undefined) focus(last.node.id);
        break;
      }
      case 'Enter':
      case ' ':
        onSelect(node);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const renderItems = (items: readonly SampleNode[], level: number, parent: string | null) =>
    items.map((node, position) => {
      const open = expandable(node) && expanded.has(node.id);
      const index = visible.findIndex((item) => item.node.id === node.id);
      const item: Visible = { node, level, parent };
      const name =
        node.key === null
          ? t(`webhook.part.${node.part}`)
          : typeof node.key === 'number'
            ? `[${String(node.key)}]`
            : node.key;
      return (
        <li
          key={node.id}
          role="treeitem"
          aria-level={level}
          aria-setsize={items.length}
          aria-posinset={position + 1}
          aria-expanded={expandable(node) ? open : undefined}
          aria-selected={node.id === selectedId}
          aria-labelledby={`${rowPrefix}-${String(index)}`}
          tabIndex={node.id === activeId ? 0 : -1}
          data-node-id={node.id}
          data-testid="sample-node"
          className="outline-none [&:focus-visible>div]:outline-2 [&:focus-visible>div]:outline-accent"
          onKeyDown={(event) => {
            onKeyDown(event, item, index);
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setActive(node.id);
          }}
        >
          <div
            id={`${rowPrefix}-${String(index)}`}
            className={cn(
              'flex min-h-7 cursor-pointer items-center gap-1 rounded-sm pr-2 text-body max-lg:min-h-control',
              node.id === selectedId ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
            )}
            style={{ paddingInlineStart: `${String((level - 1) * 14 + 2)}px` }}
            onClick={() => {
              setActive(node.id);
              if (expandable(node)) toggle(node.id, !open);
              onSelect(node);
            }}
          >
            {expandable(node) ? (
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  'size-3.5 shrink-0 text-fg-muted transition-transform',
                  open && 'rotate-90',
                )}
              />
            ) : (
              <span aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span
              className={cn(
                'shrink-0 font-mono text-mono',
                node.key === null ? 'font-semibold text-fg' : 'text-fg',
                !node.pickable && 'text-fg-muted italic',
              )}
            >
              {name}
            </span>
            {node.truncated ? (
              <span className="shrink-0 rounded-full bg-option-3 px-1.5 text-label text-on-option-3">
                {t('webhook.truncatedBadge')}
              </span>
            ) : node.kind === 'object' || node.kind === 'array' ? (
              <span className="shrink-0 text-label font-normal text-fg-muted">
                {t(`webhook.size.${node.kind}`, { count: node.size })}
              </span>
            ) : (
              <span className="min-w-0 truncate font-mono text-mono text-fg-muted">
                {node.preview}
              </span>
            )}
          </div>
          {open ? (
            <ul role="group">
              {renderItems(node.children, level + 1, node.id)}
              {node.hidden > 0 ? (
                <li
                  role="none"
                  className="py-0.5 text-label font-normal text-fg-muted"
                  style={{ paddingInlineStart: `${String(level * 14 + 20)}px` }}
                >
                  {t('webhook.hiddenItems', { count: node.hidden })}
                </li>
              ) : null}
            </ul>
          ) : null}
        </li>
      );
    });

  return (
    <ul
      ref={tree}
      role="tree"
      aria-label={label}
      className="max-h-80 overflow-y-auto rounded-md border border-line bg-surface p-1"
      data-testid="sample-tree"
    >
      {renderItems(nodes, 1, null)}
    </ul>
  );
}
