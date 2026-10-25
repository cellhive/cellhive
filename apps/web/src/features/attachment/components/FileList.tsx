import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTranslation } from 'react-i18next';

import type { CellFile } from '../../../lib/attachments/value';
import type { ReactNode } from 'react';

export interface SortableFilesProps {
  readonly files: readonly CellFile[];
  /** Ids of the files in this list (a part of the cell: the images, the documents). */
  readonly ids: readonly string[];
  readonly layout: 'list' | 'grid';
  readonly disabled: boolean;
  /** The file at cell index `from` moves to cell index `to`. */
  readonly onMove: (from: number, to: number) => void;
  readonly children: ReactNode;
}

/**
 * Drag and drop reordering of files (board S4: a handle per file; pointer,
 * touch with a short hold, or the keyboard — Space on the handle, arrows,
 * Space to drop), announced in the user's language. The order is the
 * cell's value (CONTRACTS §2), written in one request.
 */
export function SortableFiles({
  files,
  ids,
  layout,
  disabled,
  onMove,
  children,
}: SortableFilesProps) {
  const { t } = useTranslation('attachment');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number) => files.find((file) => file.id === id)?.name ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dnd.start', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null ? undefined : t('dnd.over', { name: nameOf(active.id), over: nameOf(over.id) }),
    onDragEnd: ({ active }) => t('dnd.end', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('dnd.cancel', { name: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = files.findIndex((file) => file.id === active.id);
    const to = files.findIndex((file) => file.id === over.id);
    if (from !== -1 && to !== -1) onMove(from, to);
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
      <SortableContext
        items={[...ids]}
        disabled={disabled}
        strategy={layout === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}
