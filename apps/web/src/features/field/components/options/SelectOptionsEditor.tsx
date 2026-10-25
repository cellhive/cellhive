import {
  Alert,
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  FormField,
  Input,
  Select,
} from '@cellhive/ui';
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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  newOption,
  OPTION_PALETTE_SIZE,
  type DraftIssue,
  type OptionDraft,
  type SelectDraft,
} from '../../draft';
import { issueAt, useIssueText } from '../shared';

const PALETTE = Array.from({ length: OPTION_PALETTE_SIZE }, (_, index) => index);

/** Background + text classes of a palette color (tokens `--option-N-bg/fg`, FRONTEND §9.3). */
export const OPTION_CHIP_CLASSES: readonly string[] = [
  'bg-option-0 text-on-option-0',
  'bg-option-1 text-on-option-1',
  'bg-option-2 text-on-option-2',
  'bg-option-3 text-on-option-3',
  'bg-option-4 text-on-option-4',
  'bg-option-5 text-on-option-5',
  'bg-option-6 text-on-option-6',
  'bg-option-7 text-on-option-7',
];

export function optionChipClass(color: number): string {
  return OPTION_CHIP_CLASSES[color % OPTION_PALETTE_SIZE] ?? '';
}

interface OptionRowProps {
  readonly option: OptionDraft;
  readonly position: number;
  readonly error: string | undefined;
  readonly autoFocus: boolean;
  readonly onChange: (option: OptionDraft) => void;
  readonly onRemove: () => void;
}

function OptionRow({ option, position, error, autoFocus, onChange, onRemove }: OptionRowProps) {
  const { t } = useTranslation('field');
  const errorId = useId();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.key,
    disabled: option.deleted,
  });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  const label = option.name.trim() === '' ? t('select.unnamed', { position }) : option.name;
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        'flex flex-col gap-1 rounded-md bg-surface',
        isDragging && 'relative z-10 shadow-popover',
      )}
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 cursor-grab touch-none text-fg-muted"
          aria-label={t('select.reorder', { name: label })}
          disabled={option.deleted}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              disabled={option.deleted}
              aria-label={t('select.color', {
                name: label,
                color: t(`colors.${String(option.color % OPTION_PALETTE_SIZE)}`),
              })}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-4 rounded-sm border border-line',
                  optionChipClass(option.color),
                )}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuLabel>{t('select.colorHeading')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={String(option.color % OPTION_PALETTE_SIZE)}
              onValueChange={(value) => {
                onChange({ ...option, color: Number(value) });
              }}
            >
              {PALETTE.map((color) => (
                <DropdownMenuRadioItem key={color} value={String(color)}>
                  <span
                    aria-hidden="true"
                    className={cn('size-3 rounded-sm', optionChipClass(color))}
                  />
                  {t(`colors.${String(color)}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          ref={input}
          aria-label={t('select.optionName', { position })}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          autoComplete="off"
          maxLength={255}
          disabled={option.deleted}
          className={cn(option.deleted && 'text-fg-muted line-through')}
          value={option.name}
          onChange={(event) => {
            onChange({ ...option, name: event.target.value });
          }}
        />
        {option.deleted ? (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={t('select.restore', { name: label })}
            onClick={() => {
              onChange({ ...option, deleted: false });
            }}
          >
            <Undo2 aria-hidden="true" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label={t('select.remove', { name: label })}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="pl-20 text-label font-normal text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export interface SelectOptionsEditorProps {
  readonly value: SelectDraft;
  readonly onChange: (value: SelectDraft) => void;
  readonly issues: readonly DraftIssue[];
}

/**
 * Options of a `select` field (T207): add, rename, recolor, drag to reorder
 * (pointer or keyboard, dnd-kit), delete. Deleting a saved option only
 * marks it: on save the server removes its values from every record in a
 * background job (CONTRACTS §13).
 */
export function SelectOptionsEditor({ value, onChange, issues }: SelectOptionsEditorProps) {
  const { t } = useTranslation('field');
  const issueText = useIssueText();
  const headingId = useId();
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const options = value.options;
  const setOptions = (next: readonly OptionDraft[]) => {
    onChange({ ...value, options: next });
  };
  const nameOf = (key: string | number) => {
    const index = options.findIndex((option) => option.key === key);
    const option = options[index];
    if (option === undefined) return '';
    return option.name.trim() === '' ? t('select.unnamed', { position: index + 1 }) : option.name;
  };
  const positionOf = (key: string | number) =>
    options.findIndex((option) => option.key === key) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('select.dnd.start', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('select.dnd.over', { name: nameOf(active.id), position: positionOf(over.id) }),
    onDragEnd: ({ active, over }) =>
      over === null
        ? t('select.dnd.cancel', { name: nameOf(active.id) })
        : t('select.dnd.end', { name: nameOf(active.id), position: positionOf(over.id) }),
    onDragCancel: ({ active }) => t('select.dnd.cancel', { name: nameOf(active.id) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    const from = options.findIndex((option) => option.key === active.id);
    const to = options.findIndex((option) => option.key === over.id);
    if (from < 0 || to < 0) return;
    setOptions(arrayMove([...options], from, to));
  };
  const deleted = options.filter((option) => option.deleted);
  const saved = useMemo(
    () => options.filter((option) => option.id !== null && !option.deleted),
    [options],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <Checkbox
        label={t('select.multiple')}
        checked={value.multiple}
        onChange={(event) => {
          onChange({ ...value, multiple: event.target.checked });
        }}
      />
      <h3 id={headingId} className="text-label text-fg">
        {t('select.options')}
      </h3>
      {options.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('select.empty')}</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('select.dnd.instructions') },
          }}
        >
          <SortableContext
            items={options.map((option) => option.key)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto py-1">
              {options.map((option, index) => (
                <OptionRow
                  key={option.key}
                  option={option}
                  position={index + 1}
                  autoFocus={option.key === focusKey}
                  error={issueText(issueAt(issues, `option.${option.key}.name`))}
                  onChange={(next) => {
                    setOptions(
                      options.map((current) => (current.key === next.key ? next : current)),
                    );
                  }}
                  onRemove={() => {
                    // A new option simply goes; a saved one is marked (values go on save).
                    setOptions(
                      option.id === null
                        ? options.filter((current) => current.key !== option.key)
                        : options.map((current) =>
                            current.key === option.key ? { ...current, deleted: true } : current,
                          ),
                    );
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const option = newOption('', options.length % OPTION_PALETTE_SIZE);
            setFocusKey(option.key);
            setOptions([...options, option]);
          }}
        >
          <Plus aria-hidden="true" />
          {t('select.add')}
        </Button>
      </div>
      {deleted.length > 0 ? (
        <Alert variant="danger" role="status">
          <p>{t('select.deleteWarning', { count: deleted.length })}</p>
        </Alert>
      ) : null}
      {value.multiple ? null : (
        <FormField label={t('defaultValue')} hint={t('select.defaultHint')}>
          {(control) => (
            <Select
              {...control}
              value={
                value.defaultOptionId !== null &&
                saved.some((option) => option.id === value.defaultOptionId)
                  ? value.defaultOptionId
                  : ''
              }
              onChange={(event) => {
                onChange({
                  ...value,
                  defaultOptionId: event.target.value === '' ? null : event.target.value,
                });
              }}
            >
              <option value="">{t('select.noDefault')}</option>
              {saved.map((option) => (
                <option key={option.key} value={option.id ?? ''}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
    </section>
  );
}
