import { Button, Checkbox, cn, Input, Tooltip } from '@cellhive/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { QuestionSettings } from './QuestionSettings';

import type { FormQuestion } from '../model/questions';
import type { StoredFormField } from '@cellhive/contracts';

export interface QuestionCardProps {
  readonly question: FormQuestion;
  /** The stored entry (own label and help, possibly empty). */
  readonly entry: StoredFormField;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<Pick<StoredFormField, 'label' | 'help' | 'required'>>) => void;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
  /** Name of the table a link question points to (T419); `null` when unreadable. */
  readonly linkTableName?: string | null | undefined;
}

const textareaClasses =
  'min-h-16 w-full min-w-0 rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-sunken';

/**
 * One question of the builder (T315): drag handle (pointer), the question's
 * own label and help (the field name when empty), required, move up/down
 * (the keyboard path of dragging) and remove. Questions on fields the table
 * requires stay required and cannot be removed (CONTRACTS §15).
 */
export function QuestionCard({
  question,
  entry,
  index,
  count,
  disabled,
  onChange,
  onMove,
  onRemove,
  linkTableName,
}: QuestionCardProps) {
  const { t } = useTranslation('form');
  const id = useId();
  const fieldId = question.field.id;
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: fieldId,
    disabled,
  });
  const name = question.field.name;
  const removeLabel = question.tableRequired
    ? t('builder.removeRequired', { name })
    : t('builder.remove', { name });
  return (
    <li
      ref={setNodeRef}
      data-testid="form-builder-question"
      data-field={fieldId}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'flex gap-2 rounded-lg border border-line bg-surface p-3 sm:p-4',
        isDragging && 'relative z-10 shadow-popover',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        // Dragging is for pointers; the move buttons are the keyboard path.
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        className="mt-1 hidden h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken sm:inline-flex"
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </button>
      <div
        role="group"
        aria-labelledby={`${id}-name`}
        className="flex min-w-0 flex-1 flex-col gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label font-normal text-fg-muted">
            {t('builder.question', { number: index + 1 })}
          </span>
          <h3 id={`${id}-name`} className="min-w-0 flex-1 truncate text-body font-semibold">
            {name}
          </h3>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip content={t('builder.moveUp', { name })}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('builder.moveUp', { name })}
                disabled={disabled || index === 0}
                onClick={() => {
                  onMove(index - 1);
                }}
              >
                <ArrowUp aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content={t('builder.moveDown', { name })}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('builder.moveDown', { name })}
                disabled={disabled || index === count - 1}
                onClick={() => {
                  onMove(index + 1);
                }}
              >
                <ArrowDown aria-hidden="true" />
              </Button>
            </Tooltip>
            <Tooltip content={removeLabel}>
              <Button
                variant="ghost"
                size="icon"
                aria-label={removeLabel}
                disabled={disabled || question.tableRequired}
                onClick={onRemove}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-label`} className="text-label text-fg">
            {t('builder.label')}
          </label>
          <Input
            id={`${id}-label`}
            value={entry.label ?? ''}
            placeholder={name}
            maxLength={255}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              onChange({ label: value === '' ? null : value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-help`} className="text-label text-fg">
            {t('builder.help')}
          </label>
          <textarea
            id={`${id}-help`}
            rows={2}
            value={entry.help ?? ''}
            maxLength={1000}
            disabled={disabled}
            className={textareaClasses}
            onChange={(event) => {
              const value = event.target.value;
              onChange({ help: value === '' ? null : value });
            }}
          />
        </div>
        <Checkbox
          label={t('builder.required')}
          hint={question.tableRequired ? t('builder.requiredByTable') : undefined}
          checked={question.required}
          disabled={disabled || question.tableRequired}
          onChange={(event) => {
            onChange({ required: event.target.checked });
          }}
        />
        <QuestionSettings question={question} linkTableName={linkTableName} />
        {question.field.type === 'user' || question.field.type === 'link' ? (
          // Public form links leave people and link questions out (CONTRACTS §17, T321, T410).
          <p data-testid="form-builder-user-note" className="text-label font-normal text-fg-muted">
            {t('builder.userQuestionHidden')}
          </p>
        ) : null}
        {question.config === null ? (
          <p className="text-label font-normal text-warning">{t('builder.unsupported')}</p>
        ) : null}
      </div>
    </li>
  );
}
