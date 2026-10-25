import { SUBMISSION_LIMITS, type StoredFormSettings } from '@cellhive/contracts';
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
} from '@cellhive/ui';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  addableFields,
  addQuestion,
  moveQuestion,
  questionsOf,
  redirectUrlOf,
  removeQuestion,
  updateQuestion,
  withSubmissionRules,
} from '../model/questions';

import { CoverPicker } from './CoverPicker';
import { QuestionCard } from './QuestionCard';

import type { FormRendererField } from '../../../lib/forms/renderer';

const textareaClasses =
  'min-h-20 w-full min-w-0 rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-sunken aria-invalid:border-danger';

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-heading">
          {title}
        </h2>
        {description === undefined ? null : <p className="text-fg-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The name of the table a link field points to; `null` when unknown to the user. */
function linkTableOf(
  options: Readonly<Record<string, unknown>>,
  names: ReadonlyMap<string, string> | undefined,
): string | null {
  const table = options['link_table'];
  return typeof table === 'string' ? (names?.get(table) ?? null) : null;
}

/** Typing pauses this long before a redirect URL is checked. */
export const REDIRECT_CHECK_DELAY_MS = 600;

/**
 * The redirect URL: kept as typed until valid (`http`/`https`), then saved.
 * A value that is not a web address says so while typing (after a pause)
 * and on leaving the box — never dropped silently (T320).
 */
function RedirectUrlInput({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (url: string | null) => void;
}) {
  const { t } = useTranslation('form');
  const id = useId();
  const [text, setText] = useState(value ?? '');
  const [invalid, setInvalid] = useState(false);
  const commit = (next: string) => {
    const url = redirectUrlOf(next);
    setInvalid(url === undefined);
    if (url !== undefined && url !== value) onChange(url);
  };
  // While typing: only checked (saving waits for leaving the box, as the view reloads).
  useEffect(() => {
    const timer = setTimeout(() => {
      setInvalid(redirectUrlOf(text) === undefined);
    }, REDIRECT_CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-fg">
        {t('builder.redirectUrl')}
      </label>
      <Input
        id={id}
        type="url"
        inputMode="url"
        value={text}
        placeholder={t('builder.redirectUrlPlaceholder')}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint${invalid ? ` ${id}-error` : ''}`}
        data-testid="form-redirect-url"
        onChange={(event) => {
          setText(event.target.value);
          if (redirectUrlOf(event.target.value) !== undefined) setInvalid(false);
        }}
        onBlur={(event) => {
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
      />
      <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
        {t('builder.redirectUrlHint')}
      </p>
      <p
        id={`${id}-error`}
        role="alert"
        className="text-label font-normal text-danger empty:hidden"
      >
        {invalid ? t('builder.redirectUrlInvalid') : null}
      </p>
    </div>
  );
}

export interface FormBuilderProps {
  readonly form: StoredFormSettings;
  /** The table's fields the user reads (questions may only name those). */
  readonly fields: readonly FormRendererField[];
  /** Saves (or keeps temporarily) the whole `form` of the view config (T310). */
  readonly onChange: (form: StoredFormSettings) => void;
  readonly disabled?: boolean;
  /**
   * The cover image (T419): the form view it belongs to and whether the user
   * may upload one (changing the view's config, not locked). Omitted = no
   * cover picker.
   */
  readonly cover?: { readonly viewId: string; readonly canUpload: boolean } | undefined;
  /** Names of the tables link questions point to (T419), by table id. */
  readonly tableNames?: ReadonlyMap<string, string> | undefined;
}

/**
 * The builder of a form view (SPEC §8, CONTRACTS §15, T315): title and
 * description, the questions (drag or move to reorder, add writable fields,
 * label, help, required per question), what happens after a submission
 * (message, redirect) and who may submit (sign-in, submission limit).
 * T419: the cover image, and what link and file questions take (their
 * field's settings and the limits of form links).
 */
export function FormBuilder({
  form,
  fields,
  onChange,
  disabled = false,
  cover,
  tableNames,
}: FormBuilderProps) {
  const { t } = useTranslation('form');
  const titleId = useId();
  const descriptionId = useId();
  const successId = useId();
  const limitId = useId();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const questions = questionsOf(form, fields);
  const addable = addableFields(form, fields);
  // A removed question takes its buttons with it: the focus goes to the next question
  // (else the previous one, else "Add a question"), never to the page (FRONTEND §9.2).
  const list = useRef<HTMLOListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  /** Field id of the question to focus once a removal rendered; `''` = the add button. */
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const scope =
      target === '' ? null : list.current?.querySelector(`[data-field="${CSS.escape(target)}"]`);
    const control = scope?.querySelector<HTMLElement>(
      'input:not(:disabled), button:not(:disabled)',
    );
    (control ?? addButton.current)?.focus();
  }, [form.fields]);
  const nameOf = (id: string | number) =>
    fields.find((field) => field.id === id)?.name ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('builder.dnd.start', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) =>
      over === null
        ? undefined
        : t('builder.dnd.over', { name: nameOf(active.id), over: nameOf(over.id) }),
    onDragEnd: ({ active }) => t('builder.dnd.end', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('builder.dnd.cancel', { name: nameOf(active.id) }),
  };
  const indexOf = (fieldId: string | number) =>
    form.fields.findIndex((item) => item.field === fieldId);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null) return;
    onChange(moveQuestion(form, indexOf(active.id), indexOf(over.id)));
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:px-0">
      <Section title={t('builder.header')}>
        <div className="flex flex-col gap-1">
          <label htmlFor={titleId} className="text-label text-fg">
            {t('builder.title')}
          </label>
          <Input
            id={titleId}
            value={form.title}
            maxLength={255}
            placeholder={t('fill.untitled')}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...form, title: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={descriptionId} className="text-label text-fg">
            {t('builder.description')}
          </label>
          <textarea
            id={descriptionId}
            rows={4}
            value={form.description}
            maxLength={5000}
            disabled={disabled}
            aria-describedby={`${descriptionId}-hint`}
            className={textareaClasses}
            onChange={(event) => {
              onChange({ ...form, description: event.target.value });
            }}
          />
          <p id={`${descriptionId}-hint`} className="text-label font-normal text-fg-muted">
            {t('builder.markdownHint')}
          </p>
        </div>
        {cover === undefined ? null : (
          <CoverPicker
            viewId={cover.viewId}
            coverId={form.cover_attachment_id}
            canUpload={cover.canUpload}
            disabled={disabled}
            onChange={(coverId) => {
              onChange({ ...form, cover_attachment_id: coverId });
            }}
          />
        )}
      </Section>

      <Section title={t('builder.questions')} description={t('builder.questionsHint')}>
        {questions.length === 0 ? (
          <p className="text-fg-muted">{t('builder.noQuestions')}</p>
        ) : null}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('builder.dnd.instructions') },
          }}
        >
          <SortableContext
            items={questions.map((question) => question.field.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol ref={list} className="flex flex-col gap-2" aria-label={t('builder.questions')}>
              {questions.map((question, index) => {
                const entry = form.fields.find((item) => item.field === question.field.id);
                if (entry === undefined) return null;
                return (
                  <QuestionCard
                    key={question.field.id}
                    question={question}
                    entry={entry}
                    index={index}
                    count={questions.length}
                    disabled={disabled}
                    onChange={(patch) => {
                      onChange(updateQuestion(form, question.field.id, patch));
                    }}
                    onMove={(to) => {
                      const target = questions[to];
                      if (target === undefined) return;
                      onChange(
                        moveQuestion(form, indexOf(question.field.id), indexOf(target.field.id)),
                      );
                    }}
                    linkTableName={linkTableOf(question.field.options, tableNames)}
                    onRemove={() => {
                      const neighbour = questions[index + 1] ?? questions[index - 1];
                      focusAfter.current = neighbour?.field.id ?? '';
                      onChange(removeQuestion(form, question.field));
                    }}
                  />
                );
              })}
            </ol>
          </SortableContext>
        </DndContext>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={addButton}
              variant="secondary"
              className="self-start"
              disabled={disabled || addable.length === 0}
            >
              <Plus aria-hidden="true" />
              {addable.length === 0 ? t('builder.allAdded') : t('builder.add')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map((field) => (
              <DropdownMenuItem
                key={field.id}
                onSelect={() => {
                  onChange(addQuestion(form, field));
                }}
              >
                {field.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Section>

      <Section title={t('builder.after')}>
        <div className="flex flex-col gap-1">
          <label htmlFor={successId} className="text-label text-fg">
            {t('builder.successMessage')}
          </label>
          <textarea
            id={successId}
            rows={3}
            value={form.success_message}
            maxLength={2000}
            placeholder={t('fill.done.default')}
            disabled={disabled}
            className={textareaClasses}
            onChange={(event) => {
              onChange({ ...form, success_message: event.target.value });
            }}
          />
        </div>
        <RedirectUrlInput
          // A saved value changed elsewhere (another tab, a discarded draft) replaces the text.
          key={form.redirect_url ?? ''}
          value={form.redirect_url}
          disabled={disabled}
          onChange={(url) => {
            onChange({ ...form, redirect_url: url });
          }}
        />
      </Section>

      <Section title={t('builder.access')}>
        <Checkbox
          label={t('builder.requireLogin')}
          hint={t('builder.requireLoginHint')}
          checked={form.require_login}
          disabled={disabled}
          onChange={(event) => {
            onChange(withSubmissionRules(form, { requireLogin: event.target.checked }));
          }}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={limitId} className="text-label text-fg">
            {t('builder.limit')}
          </label>
          <Select
            id={limitId}
            className="sm:max-w-72"
            value={form.submission_limit}
            disabled={disabled || !form.require_login}
            aria-describedby={`${limitId}-hint`}
            onChange={(event) => {
              const limit = SUBMISSION_LIMITS.find((item) => item === event.target.value);
              if (limit !== undefined) onChange(withSubmissionRules(form, { limit }));
            }}
          >
            {SUBMISSION_LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {t(`builder.limits.${limit}`)}
              </option>
            ))}
          </Select>
          <p id={`${limitId}-hint`} className="text-label font-normal text-fg-muted">
            {form.require_login ? t('builder.limitHint') : t('builder.limitNeedsLogin')}
          </p>
        </div>
      </Section>
    </div>
  );
}
