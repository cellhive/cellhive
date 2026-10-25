import { Button, cn } from '@cellhive/ui';
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
import { Columns3, GripVertical } from 'lucide-react';
import { createElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { typeIconOf } from '../../../lib/schema/field-icons';
import { ToolbarPopover } from '../../../lib/views/ToolbarPopover';

import { moveColumn, pickerOrder, toggleColumn } from './model';

import type { GridField } from '../../../grid/types';

export interface ColumnPickerProps {
  /** Fields of the linked table the viewer reads, in table order (primary first). */
  readonly fields: readonly GridField[];
  /** Columns shown now, in order (primary first). */
  readonly shown: readonly GridField[];
  /** Where the choice is kept: the view's name, or `null` (this device only). */
  readonly savedIn: string | null;
  readonly onChange: (columns: string[]) => void;
}

/** The field type icon of a row. */
const ICON = 'size-3.5 shrink-0 text-fg-muted';

function ColumnRow({
  field,
  checked,
  primary,
  onToggle,
}: {
  field: GridField;
  checked: boolean;
  primary: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useTranslation('subtable');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: field.field.id,
    disabled: primary,
  });
  const inputId = `subtable-column-${field.field.id}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="subtable-column"
      className={cn(
        'flex min-h-[34px] items-center gap-2 rounded-md px-1 max-lg:min-h-11 hover:bg-surface-sunken',
        isDragging && 'relative z-10 bg-surface shadow-popover',
      )}
    >
      {primary ? (
        <span aria-hidden="true" className="inline-flex size-6 shrink-0 max-lg:size-11" />
      ) : (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('moveColumn', { field: field.field.name })}
          className="inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:cursor-grabbing max-lg:size-11"
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
      )}
      <input
        id={inputId}
        type="checkbox"
        className="size-4 shrink-0 disabled:cursor-not-allowed"
        checked={checked}
        disabled={primary}
        onChange={(event) => {
          onToggle(event.target.checked);
        }}
      />
      <label
        htmlFor={inputId}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-body"
      >
        {createElement(typeIconOf(field.field.type), { 'aria-hidden': true, className: ICON })}
        <span className="truncate">{field.field.name}</span>
        {primary ? (
          <span className="ml-auto shrink-0 text-label font-normal text-fg-muted">
            {t('primary')}
          </span>
        ) : null}
      </label>
    </li>
  );
}

/**
 * "Columns" of a sub-table (board "Bảng con trong chi tiết record"):
 * checkboxes for the fields of the linked table, ⋮⋮ to reorder (pointer,
 * or Space + arrows), the primary field always first and always shown.
 * The choice is saved to the open view (`record_detail.link_columns`) when
 * the user may, else kept on this device like other temporary changes.
 */
export function ColumnPicker({ fields, shown, savedIn, onChange }: ColumnPickerProps) {
  const { t } = useTranslation('subtable');
  const [open, setOpen] = useState(false);
  const primaryId = fields.find((field) => field.field.is_primary)?.field.id ?? null;
  const shownIds: string[] = shown.map((field) => field.field.id);
  const order = pickerOrder(shown, fields);
  const byId = new Map<string, GridField>(fields.map((field) => [field.field.id, field]));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number) => byId.get(String(id))?.field.name ?? '';
  const position = (id: string | number) => order.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('dnd.start', { field: nameOf(active.id), position: position(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('dnd.over', { field: nameOf(active.id), position: position(over.id) }),
    onDragEnd: ({ active, over }) =>
      t('dnd.end', {
        field: nameOf(active.id),
        position: position(over === null ? active.id : over.id),
      }),
    onDragCancel: ({ active }) => t('dnd.cancel', { field: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const next = moveColumn(
      order,
      order.indexOf(String(active.id)),
      order.indexOf(String(over.id)),
      primaryId,
    );
    // Only the checked ones are columns; their new order is what is kept.
    onChange(next.filter((id) => shownIds.includes(id)));
  };
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t('columnsTitle')}
      className="right-0 left-auto w-72 origin-top-right gap-0 p-0"
      trigger={(props) => (
        <Button
          {...props}
          variant="ghost"
          size="sm"
          data-testid="subtable-columns"
          className={cn(
            'bg-accent-soft text-fg hover:bg-accent-soft/80 max-lg:h-control',
            open && 'ring-1 ring-accent',
          )}
        >
          <Columns3 aria-hidden="true" />
          {t('columns')}
        </Button>
      )}
    >
      <div className="flex flex-col gap-0.5 px-3.5 pt-3 pb-1.5">
        <span className="text-body font-semibold">{t('columnsTitle')}</span>
        <span className="text-label font-normal text-fg-muted">
          {savedIn === null ? t('localOnly') : t('savedFor', { view: savedIn })}
        </span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('dnd.instructions') },
        }}
      >
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col px-1.5 pb-2">
            {order.map((id) => {
              const field = byId.get(id);
              if (field === undefined) return null;
              return (
                <ColumnRow
                  key={id}
                  field={field}
                  checked={shownIds.includes(id)}
                  primary={id === primaryId}
                  onToggle={(on) => {
                    onChange(toggleColumn(shownIds, id, on, primaryId));
                  }}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
    </ToolbarPopover>
  );
}
