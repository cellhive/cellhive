import { Button } from '@cellhive/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { HistoryTimeline } from './HistoryTimeline';

import type { AnchorRect, CellHistoryProps } from '../../../lib/records/detail';

const WIDTH = 416;
const GAP = 4;
const MARGIN = 8;

/** Where the popover goes: under the anchor (above when there is no room), inside the window. */
function placement(anchor: AnchorRect, height: number) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(WIDTH, viewportWidth - 2 * MARGIN);
  const left = Math.min(Math.max(anchor.x, MARGIN), viewportWidth - width - MARGIN);
  const below = anchor.y + anchor.height + GAP;
  const top =
    below + height <= viewportHeight - MARGIN || anchor.y - GAP - height < MARGIN
      ? below
      : anchor.y - GAP - height;
  return { left, top: Math.max(MARGIN, top), width };
}

/**
 * History of one cell (FRONTEND §10.3 "Xem lịch sử ô"), from the cell menu
 * of the grid or the history button of a field in the record panel: the
 * changes of that field only (`?field=`), with revert. A non-modal popover:
 * Escape or a click outside closes it and the focus goes back.
 */
export function CellHistoryPopover({ anchor, onClose, ...scope }: CellHistoryProps) {
  const { t } = useTranslation('history');
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(320);
  const field = scope.fields.find((candidate) => candidate.id === scope.fieldId);

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            setHeight(element.offsetHeight);
          });
    observer?.observe(element);
    setHeight(element.offsetHeight);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && box.current?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const position = placement(anchor, height);
  return (
    <section
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed z-50 flex max-h-[min(32rem,70dvh)] flex-col rounded-lg border border-line bg-surface text-fg shadow-popover outline-none"
      style={{ left: position.left, top: position.top, width: position.width }}
      onKeyDown={(event) => {
        // Escape in the revert confirmation closes that dialog only.
        const inDialog = event.target instanceof Element && event.target.closest('dialog') !== null;
        if (event.key === 'Escape' && !event.defaultPrevented && !inDialog) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-4">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-heading">
          {t('cellTitle', { field: field?.name ?? '' })}
        </h2>
        <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto px-4">
        <HistoryTimeline {...scope} fieldId={scope.fieldId} />
      </div>
    </section>
  );
}

export default CellHistoryPopover;
