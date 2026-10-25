import { Tooltip } from '@cellhive/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CARD_INDENT, CARD_MARGIN, gutterContent } from './customCells/group-card';

import type { GroupValueDisplay } from './display/group';
import type { GridGroupRow } from './rows';
import type { WheelEvent } from 'react';

export interface GroupStickyPathProps {
  /** Headers of the groups the first row on screen is in, outermost first (scrolled away). */
  readonly groups: readonly GridGroupRow[];
  /** Top of the rows (below the column header), px. */
  readonly top: number;
  readonly rowHeight: number;
  /** Width of the row gutter, px (the value starts at the first column). */
  readonly gutter: number;
  /** Width of the frozen columns, px (the count is right-aligned against their divider). */
  readonly headWidth: number;
  readonly describe: (group: GridGroupRow) => {
    readonly display: GroupValueDisplay;
    readonly count: string;
    readonly label: string;
  };
  readonly onToggle: (groupKey: string) => void;
  /** Wheel over the path scrolls the grid under it. */
  readonly onWheel: (event: WheelEvent) => void;
}

/**
 * The sticky group path (T320a): while scrolling inside a group, its
 * header (and those of the groups around it) stays pinned under the column
 * header, drawn like the canvas header; a click collapses the group. A
 * pointer shortcut: the header rows themselves take the keyboard.
 */
export function GroupStickyPath({
  groups,
  top,
  rowHeight,
  gutter,
  headWidth,
  describe,
  onToggle,
  onWheel,
}: GroupStickyPathProps) {
  const { t } = useTranslation('grid');
  if (groups.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={t('group.stickyPath')}
      data-testid="group-sticky-path"
      className="pointer-events-none absolute inset-x-0 z-10 shadow-sm"
      style={{ top }}
    >
      {groups.map((group) => {
        const { display, count, label } = describe(group);
        const chevron = gutterContent(
          { x: 0, y: 0, width: gutter, height: rowHeight },
          { depth: group.level + 1, top: true, bottom: false },
        );
        const Chevron = group.collapsed ? ChevronRight : ChevronDown;
        return (
          <Tooltip key={group.key} content={label} side="bottom" align="start">
            <button
              type="button"
              tabIndex={-1}
              aria-label={label}
              aria-expanded={!group.collapsed}
              className="pointer-events-auto relative block w-full overflow-hidden border-b border-line bg-surface text-left"
              style={{ height: rowHeight }}
              onClick={() => {
                onToggle(group.key);
              }}
              onWheel={onWheel}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-surface-sunken"
                style={{ width: CARD_MARGIN }}
              />
              {Array.from({ length: group.level + 1 }, (_, level) => (
                <span
                  key={level}
                  aria-hidden="true"
                  className="absolute inset-y-0 w-px bg-line"
                  style={{ left: CARD_MARGIN + level * CARD_INDENT }}
                />
              ))}
              <Chevron
                aria-hidden="true"
                className="absolute top-1/2 size-3.5 -translate-y-1/2 text-fg-muted"
                style={{ left: chevron.x + chevron.width / 2 - 7 }}
              />
              <span
                className="absolute inset-y-0 flex items-center justify-between gap-3 px-2 whitespace-nowrap"
                style={{ left: gutter, minWidth: headWidth }}
              >
                {display.chips !== null && display.chips.length > 0 ? (
                  <span className="flex items-center gap-1">
                    {display.chips.map((chip, index) => (
                      <span
                        key={index}
                        className="rounded-sm px-2 text-label leading-5"
                        style={{ background: chip.color.bg, color: chip.color.fg }}
                      >
                        {chip.label}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-body font-semibold text-fg">{display.text}</span>
                )}
                <span className="flex items-center gap-1 text-label font-normal text-fg-muted">
                  {count}
                  <ChevronDown aria-hidden="true" className="size-3" />
                </span>
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
