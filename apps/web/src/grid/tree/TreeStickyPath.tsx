import { ChevronRight } from 'lucide-react';
import { Fragment, type WheelEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { TreeIcon } from './TreeIcon';

export interface TreeCrumb {
  readonly recordId: string;
  readonly title: string;
}

export interface TreeStickyPathProps {
  /** Ancestors of the first row on screen whose own rows scrolled away, root first. */
  readonly crumbs: readonly TreeCrumb[];
  /** Top of the rows (below the column header), px. */
  readonly top: number;
  /** Width of the row gutter, px. */
  readonly gutter: number;
  /** Most levels (10). */
  readonly maxLevels: number;
  readonly onReveal: (recordId: string) => void;
  /** Wheel over the path scrolls the grid under it. */
  readonly onWheel: (event: WheelEvent) => void;
}

/**
 * The sticky parent path of a tree (T417, board "Sub-records dạng cây"):
 * while scrolling inside a branch, the records above it stay pinned under
 * the column header — "Parent › Child › **Branch**   Level 3 / 10"; a crumb
 * scrolls back to its record. A pointer shortcut (`tabIndex=-1`): keyboard
 * users reach a parent with ← on the first column.
 */
export function TreeStickyPath({
  crumbs,
  top,
  gutter,
  maxLevels,
  onReveal,
  onWheel,
}: TreeStickyPathProps) {
  const { t } = useTranslation('tree');
  if (crumbs.length === 0) return null;
  const last = crumbs.length - 1;
  return (
    <nav
      aria-label={t('stickyPath')}
      data-testid="tree-sticky-path"
      className="absolute inset-x-0 z-10 flex h-[30px] items-center gap-1.5 border-b border-line bg-canvas pr-3 text-label font-normal text-fg-muted"
      style={{ top, paddingLeft: gutter + 12 }}
      onWheel={onWheel}
    >
      <TreeIcon className="size-[13px] shrink-0" />
      <ol className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.recordId}>
            {index === 0 ? null : <ChevronRight aria-hidden="true" className="size-3 shrink-0" />}
            <li className="min-w-0 truncate">
              {index === last ? (
                <span aria-current="location" className="font-medium text-fg">
                  {crumb.title}
                </span>
              ) : (
                <button
                  type="button"
                  tabIndex={-1}
                  className="truncate text-accent underline underline-offset-2 hover:text-fg"
                  onClick={() => {
                    onReveal(crumb.recordId);
                  }}
                >
                  {crumb.title}
                </button>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
      <span className="ml-auto shrink-0 tabular-nums" data-testid="tree-level">
        {t('level', { level: crumbs.length, max: maxLevels })}
      </span>
    </nav>
  );
}
