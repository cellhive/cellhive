import { MAX_RECORD_SORT_KEYS, type FieldDto } from '@cellhive/contracts';
import { Button, cn, Select, Tooltip } from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { computedColumnOf } from '../../../grid/display/computed';
import { isFieldConverting } from '../../../lib/schema/conversion';

export interface SortKey {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** The two directions of a key, in the order of the group panel's toggle. */
const DIRECTIONS: readonly SortKey['direction'][] = ['asc', 'desc'];

/** Field types rows can be ordered by (the server sorts every stored value but record lists). */
const UNSORTABLE = new Set(['attachment', 'link', 'parent', 'button']);

/**
 * A formula or lookup (T468, CONTRACTS §1.4) sorts by its result: not a
 * record or file result, not locked, not in error (the server answers
 * `INVALID_SORT` like for a field it does not see).
 */
function sortableComputed(field: FieldDto): boolean {
  const computed = computedColumnOf(field);
  if (computed === undefined) return true;
  if (computed.locked || computed.error !== null) return false;
  const kind = computed.resultType?.kind;
  return kind !== 'record' && kind !== 'attachment';
}

export function sortableFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => !UNSORTABLE.has(field.type) && sortableComputed(field));
}

/** Labels of the two directions of a group level by field type (T320a, like Lark). */
export function directionLabels(
  field: FieldDto | undefined,
): 'text' | 'number' | 'date' | 'option' | 'checkbox' {
  // A formula or lookup (T468) orders like its result type.
  const result =
    field?.type === 'formula' || field?.type === 'lookup'
      ? computedColumnOf(field)?.resultType
      : undefined;
  if (result !== undefined && result !== null && !result.list) {
    switch (result.kind) {
      case 'number':
        return 'number';
      case 'date':
      case 'datetime':
        return 'date';
      case 'boolean':
        return 'checkbox';
      default:
        return 'text';
    }
  }
  switch (field?.type) {
    case 'number':
    case 'auto_number':
      return 'number';
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return 'date';
    case 'select':
      return 'option';
    case 'checkbox':
      return 'checkbox';
    default:
      return 'text';
  }
}

/** Label set of the panel: sort keys (T311) or group levels (T312). */
export type OrderKind = 'sort' | 'group';

export interface SortPanelProps {
  readonly sort: readonly SortKey[];
  /** `group`: the same list for group levels (its own labels and limit). */
  readonly kind?: OrderKind;
  /** Most keys (default: sort keys, `MAX_RECORD_SORT_KEYS`). */
  readonly max?: number;
  readonly onChange: (sort: SortKey[]) => void;
  /** Fields the user reads that rows can be sorted by. */
  readonly fields: readonly FieldDto[];
}

function SortRow({
  kind,
  item,
  index,
  count,
  fields,
  used,
  onChange,
  onMove,
  onRemove,
}: {
  kind: OrderKind;
  item: SortKey;
  index: number;
  count: number;
  fields: readonly FieldDto[];
  used: ReadonlySet<string>;
  onChange: (item: SortKey) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('toolbar');
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: item.field,
  });
  const field = fields.find((candidate) => candidate.id === item.field);
  const name = field?.name ?? t('filter.unknownField');
  const position = index + 1;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        // Phones: a wrapping row; from 768 px one column set shared by every row
        // (subgrid), so labels, fields and directions line up (T322b).
        'flex flex-wrap items-center gap-1 rounded-md bg-surface py-0.5 md:col-span-full md:grid md:grid-cols-subgrid',
        isDragging && 'relative z-10 shadow-popover',
      )}
      data-testid="sort-key"
    >
      <Tooltip content={t(`${kind}.drag`)} side="left">
        <span
          {...listeners}
          aria-hidden="true"
          className="inline-flex size-8 shrink-0 cursor-grab items-center justify-center text-fg-muted"
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </span>
      </Tooltip>
      <span className="text-label whitespace-nowrap text-fg-muted">
        {index === 0 ? t(`${kind}.first`) : t(`${kind}.then`)}
      </span>
      <Select
        className={kind === 'group' ? 'w-40' : 'w-48'}
        aria-label={t(`${kind}.field`, { position })}
        value={item.field}
        onChange={(event) => {
          onChange({ ...item, field: event.currentTarget.value });
        }}
      >
        {field === undefined ? <option value={item.field}>{name}</option> : null}
        {fields
          .filter((candidate) => candidate.id === item.field || !used.has(candidate.id))
          .map((candidate) => {
            // A field being converted (T414, decision #8): not offered meanwhile.
            const locked = isFieldConverting(candidate) && candidate.id !== item.field;
            return (
              <option key={candidate.id} value={candidate.id} disabled={locked}>
                {locked ? t('converting', { name: candidate.name }) : candidate.name}
              </option>
            );
          })}
      </Select>
      {kind === 'group' ? (
        // Lark-style segmented toggle with labels by type ("A → Z | Z → A", T320a).
        <div
          role="radiogroup"
          aria-label={t('group.direction', { field: name })}
          // 32 px, 44 px on touch-sized screens (T322a).
          className="grid h-control grid-cols-2 items-center rounded-md border border-line-control bg-surface-sunken p-0.5"
        >
          {DIRECTIONS.map((direction) => (
            <button
              key={direction}
              type="button"
              role="radio"
              aria-checked={item.direction === direction}
              className={cn(
                'h-full rounded-sm px-2 text-label whitespace-nowrap text-fg-muted',
                item.direction === direction && 'bg-surface text-fg shadow-sm',
              )}
              onClick={() => {
                onChange({ ...item, direction });
              }}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                const next = direction === 'asc' ? 'desc' : 'asc';
                onChange({ ...item, direction: next });
                const group = event.currentTarget.parentElement;
                group?.querySelector<HTMLButtonElement>(`[data-direction="${next}"]`)?.focus();
              }}
              tabIndex={item.direction === direction ? 0 : -1}
              data-direction={direction}
            >
              {t(`group.directions.${directionLabels(field)}.${direction}`)}
            </button>
          ))}
        </div>
      ) : (
        <Select
          className="w-36"
          aria-label={t(`${kind}.direction`, { field: name })}
          value={item.direction}
          onChange={(event) => {
            onChange({ ...item, direction: event.currentTarget.value === 'desc' ? 'desc' : 'asc' });
          }}
        >
          <option value="asc">{t(`${kind}.asc`)}</option>
          <option value="desc">{t(`${kind}.desc`)}</option>
        </Select>
      )}
      <Tooltip content={t(`${kind}.moveUp`, { field: name })}>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === 0}
          aria-label={t(`${kind}.moveUp`, { field: name })}
          onClick={() => {
            onMove(index - 1);
          }}
        >
          <ArrowUp aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip content={t(`${kind}.moveDown`, { field: name })}>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={index === count - 1}
          aria-label={t(`${kind}.moveDown`, { field: name })}
          onClick={() => {
            onMove(index + 1);
          }}
        >
          <ArrowDown aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip content={t(`${kind}.remove`, { field: name })}>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t(`${kind}.remove`, { field: name })}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </Button>
      </Tooltip>
    </li>
  );
}

/**
 * The sort keys of a view (T311): at most 10, in priority order, reordered
 * by dragging (pointer) or with the move buttons (keyboard). Only fields the
 * user reads are offered, each at most once.
 */
export function SortPanel({
  sort,
  onChange,
  fields,
  kind = 'sort',
  max = MAX_RECORD_SORT_KEYS,
}: SortPanelProps) {
  const { t } = useTranslation('toolbar');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const used = new Set(sort.map((item) => item.field));
  const free = fields.filter((field) => !used.has(field.id));
  const nameOf = (id: string | number) =>
    fields.find((field) => field.id === id)?.name ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t(`${kind}.dnd.start`, { field: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t(`${kind}.dnd.over`, { field: nameOf(active.id), over: nameOf(over.id) }),
    onDragEnd: ({ active }) => t(`${kind}.dnd.end`, { field: nameOf(active.id) }),
    onDragCancel: ({ active }) => t(`${kind}.dnd.cancel`, { field: nameOf(active.id) }),
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= sort.length || from === to) return;
    onChange(arrayMove([...sort], from, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null) return;
    move(
      sort.findIndex((item) => item.field === active.id),
      sort.findIndex((item) => item.field === over.id),
    );
  };
  const full = sort.length >= max;
  return (
    <div className="flex flex-col gap-2">
      {sort.length === 0 ? <p className="text-body text-fg-muted">{t(`${kind}.empty`)}</p> : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t(`${kind}.dnd.instructions`) },
        }}
      >
        <SortableContext
          items={sort.map((item) => item.field)}
          strategy={verticalListSortingStrategy}
        >
          <ol
            className="flex flex-col gap-1 md:grid md:grid-cols-[repeat(7,auto)] md:gap-x-1"
            aria-label={t(`${kind}.list`)}
          >
            {sort.map((item, index) => (
              <SortRow
                kind={kind}
                key={item.field}
                item={item}
                index={index}
                count={sort.length}
                fields={fields}
                used={used}
                onChange={(next) => {
                  onChange(sort.map((current, at) => (at === index ? next : current)));
                }}
                onMove={(to) => {
                  move(index, to);
                }}
                onRemove={() => {
                  onChange(sort.filter((_, at) => at !== index));
                }}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <Select
        className="w-64"
        aria-label={t(`${kind}.add`)}
        value=""
        disabled={full || free.length === 0}
        onChange={(event) => {
          const field = event.currentTarget.value;
          if (field === '') return;
          onChange([...sort, { field, direction: 'asc' }]);
        }}
      >
        <option value="">{full ? t(`${kind}.full`, { max }) : t(`${kind}.add`)}</option>
        {free.map((field) => (
          <option key={field.id} value={field.id} disabled={isFieldConverting(field)}>
            {isFieldConverting(field) ? t('converting', { name: field.name }) : field.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
