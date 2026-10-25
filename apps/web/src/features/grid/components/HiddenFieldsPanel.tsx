import { Button, cn, Input, Switch } from '@cellhive/ui';
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
import { GripVertical, Search } from 'lucide-react';
import { createElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { typeIconOf } from '../../../lib/schema/field-icons';

import type { HiddenFieldsMenuProps } from './HiddenFieldsMenu';
import type { GridField } from '../../../grid';

/** Case- and accent-insensitive match ("truong" finds "Trường"). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLocaleLowerCase();
}

function TypeIcon({ field }: { field: GridField }) {
  return createElement(typeIconOf(field.field.type), {
    'aria-hidden': true,
    className: 'size-4 shrink-0 text-fg-muted',
  });
}

function FieldRow({
  field,
  visible,
  sortable,
  onToggle,
}: {
  field: GridField;
  visible: boolean;
  /** Can be dragged (not the primary field, no search). */
  sortable: boolean;
  onToggle: (visible: boolean) => void;
}) {
  const { t } = useTranslation('grid');
  const { id, name, is_primary: primary } = field.field;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !sortable,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex min-h-9 items-center gap-2 rounded-md bg-surface pr-1 pl-1 hover:bg-surface-sunken',
        isDragging && 'relative z-10 shadow-popover',
      )}
      data-testid="hidden-fields-row"
      data-field-id={id}
    >
      {sortable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('hiddenFields.drag', { field: name })}
          className="inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-muted hover:bg-surface active:cursor-grabbing"
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      ) : (
        // Same room as the handle: names and icons line up.
        <span aria-hidden="true" className="size-7 shrink-0" />
      )}
      <TypeIcon field={field} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {primary ? (
        <span className="shrink-0 text-label font-normal text-fg-muted">
          {t('hiddenFields.primary')}
        </span>
      ) : null}
      <Switch
        checked={primary || visible}
        disabled={primary}
        aria-label={t('hiddenFields.show', { field: name })}
        onChange={(event) => {
          onToggle(event.target.checked);
        }}
      />
    </li>
  );
}

/** The list of {@link HiddenFieldsMenu} (loaded when the panel first opens). */
export default function HiddenFieldsPanel({
  fields,
  hidden,
  onToggle,
  onSetAll,
  onMove,
}: HiddenFieldsMenuProps) {
  const { t } = useTranslation('grid');
  const searchId = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const hiddenSet = new Set(hidden);
  const count = fields.filter((field) => hiddenSet.has(field.field.id)).length;
  const others = fields.filter((field) => !field.field.is_primary);
  const folded = fold(query.trim());
  const shown = useMemo(
    () =>
      folded === '' ? fields : fields.filter((field) => fold(field.field.name).includes(folded)),
    [fields, folded],
  );
  const sorting = folded === '';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    // The panel mounts when the popover opens: start in the search box.
    search.current?.focus();
  }, []);

  const nameOf = (id: string | number) =>
    fields.find((field) => field.field.id === id)?.field.name ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('hiddenFields.dnd.start', { field: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('hiddenFields.dnd.over', { field: nameOf(active.id), over: nameOf(over.id) }),
    onDragEnd: ({ active }) => t('hiddenFields.dnd.end', { field: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('hiddenFields.dnd.cancel', { field: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    onMove(String(active.id), String(over.id));
  };

  return (
    <div className="flex w-80 max-w-full flex-col gap-3 max-md:w-full" data-testid="hidden-fields">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-heading">{t('hiddenFields.heading')}</h2>
        <span className="text-label font-normal text-fg-muted tabular-nums">
          {t('hiddenFields.shownCount', {
            count: fields.length - count,
            total: fields.length,
          })}
        </span>
      </div>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-fg-muted"
        />
        <label htmlFor={searchId} className="sr-only">
          {t('hiddenFields.search')}
        </label>
        <Input
          ref={search}
          id={searchId}
          type="search"
          value={query}
          placeholder={t('hiddenFields.search')}
          className="pl-8"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-body text-fg-muted" role="status">
          {t('hiddenFields.noMatch', { query: query.trim() })}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('hiddenFields.dnd.instructions') },
          }}
        >
          <SortableContext
            items={others.map((field) => field.field.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className="-mx-1 flex max-h-[min(24rem,50dvh)] flex-col gap-0.5 overflow-y-auto"
              aria-label={t('hiddenFields.list')}
            >
              {shown.map((field) => (
                <FieldRow
                  key={field.field.id}
                  field={field}
                  visible={!hiddenSet.has(field.field.id)}
                  sortable={sorting && !field.field.is_primary}
                  onToggle={(visible) => {
                    onToggle(field.field.id, visible);
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {sorting ? null : (
        <p className="text-label font-normal text-fg-muted">{t('hiddenFields.searchNoDrag')}</p>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={count === others.length}
          onClick={() => {
            onSetAll(true);
          }}
        >
          {t('hiddenFields.hideAll')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={count === 0}
          onClick={() => {
            onSetAll(false);
          }}
        >
          {t('hiddenFields.showAll')}
        </Button>
      </div>
    </div>
  );
}
