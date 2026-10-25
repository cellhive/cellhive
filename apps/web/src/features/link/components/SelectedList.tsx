import { cn } from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Lock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { LinkRef } from '../../../lib/links/values';

export interface SelectedListProps {
  readonly refs: readonly LinkRef[];
  readonly onRemove: (id: string) => void;
  /** Moves the record at `from` to `to` (drag and drop, or Space + arrows on the handle). */
  readonly onMove: (from: number, to: number) => void;
  /** Rows of 44 px (phones) instead of 34 px. */
  readonly touch?: boolean;
}

function SelectedRow({
  item,
  label,
  touch,
  onRemove,
}: {
  item: LinkRef;
  label: string;
  touch: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation('link');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="link-selected"
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-canvas pr-1.5 pl-0.5',
        touch ? 'min-h-11' : 'min-h-[34px]',
        isDragging && 'relative z-10 bg-surface shadow-popover',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('picker.dragHandle', { title: label })}
        className={cn(
          'inline-flex shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-sunken active:cursor-grabbing',
          touch ? 'size-11' : 'size-6 max-lg:size-11',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        <GripVertical aria-hidden="true" className="size-3.5" />
      </button>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          item.title === null && 'inline-flex items-center gap-1 text-fg-muted',
        )}
      >
        {item.title === null ? <Lock aria-hidden="true" className="size-3.5 shrink-0" /> : null}
        {label}
      </span>
      <button
        type="button"
        aria-label={t('picker.remove', { title: label })}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken hover:text-fg',
          touch ? 'size-11' : 'size-6 max-lg:size-11',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
        onClick={onRemove}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

/**
 * The chosen records in cell order (board "Đã chọn"): drag ⋮⋮ to reorder
 * (or Space on the handle, arrows, Space — dnd-kit's keyboard sensor,
 * announced), × to unselect. Records the user cannot read show a lock.
 */
export function SelectedList({ refs, onRemove, onMove, touch = false }: SelectedListProps) {
  const { t } = useTranslation('link');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelOf = (id: string | number) => {
    const ref = refs.find((item) => item.id === id);
    return ref?.title ?? t('picker.noAccess');
  };
  const indexOf = (id: string | number) => refs.findIndex((item) => item.id === id);
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('dnd.start', { title: labelOf(active.id), position: indexOf(active.id) + 1 }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('dnd.over', { title: labelOf(active.id), position: indexOf(over.id) + 1 }),
    onDragEnd: ({ active, over }) =>
      t('dnd.end', {
        title: labelOf(active.id),
        position: (over === null ? indexOf(active.id) : indexOf(over.id)) + 1,
      }),
    onDragCancel: ({ active }) => t('dnd.cancel', { title: labelOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    onMove(indexOf(active.id), indexOf(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('dnd.instructions') },
      }}
    >
      <SortableContext items={refs.map((ref) => ref.id)} strategy={verticalListSortingStrategy}>
        <ol
          aria-label={t('picker.selected')}
          className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
        >
          {refs.map((ref) => (
            <SelectedRow
              key={ref.id}
              item={ref}
              label={labelOf(ref.id)}
              touch={touch}
              onRemove={() => {
                onRemove(ref.id);
              }}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
