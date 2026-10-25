import { cn, Input, Select } from '@cellhive/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isPercentStyle } from '../../../grid/editors/parse';

import { FileQuestion } from './FileQuestion';
import { LinkQuestion } from './LinkQuestion';

import type { UploadStore, UploadTarget } from '../../../lib/attachments/uploads';
import type { FormLinkSource, FormMember } from '../../../lib/forms/renderer';
import type { FormQuestion } from '../model/questions';
import type { InputValue } from '../model/values';

/** Choices shown as radio buttons / check boxes up to this many; a select list beyond. */
export const MAX_INLINE_CHOICES = 6;
/** A search box above the member check boxes from this many members. */
const MEMBER_SEARCH_FROM = 8;

/**
 * Whether a question's input is a group of choices (labelled by the question
 * label through `aria-labelledby`, not a `<label for>`).
 */
export function isChoiceGroup(question: FormQuestion): boolean {
  const config = question.config;
  if (config === null) return false;
  // Picked records and files: a group of controls (T410).
  if (config.type === 'link' || config.type === 'attachment') return true;
  if (config.type === 'select') {
    return config.options.multiple || config.options.options.length <= MAX_INLINE_CHOICES;
  }
  return config.type === 'user' && config.options.multiple;
}

/** ARIA wiring of a question's control (label, help, error). */
export interface ControlProps {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
}

export interface QuestionInputProps {
  readonly question: FormQuestion;
  readonly value: InputValue;
  readonly onChange: (value: InputValue) => void;
  readonly control: ControlProps;
  /** Id of the question's visible label (groups of choices are labelled by it). */
  readonly labelId: string;
  readonly members: readonly FormMember[] | undefined;
  /** Records link questions offer (T410). */
  readonly links?: FormLinkSource | undefined;
  /** Uploads of file questions (T410): the form's store and this question's slot in it. */
  readonly files?:
    | {
        readonly store: UploadStore | null;
        readonly target: UploadTarget;
        /** Most files on top of the field's `max_files` (form links: 10). */
        readonly maxFiles: number | undefined;
        /** Most bytes of all files of a submission (form links: 100 MB). */
        readonly maxTotalBytes?: number | undefined;
      }
    | undefined;
  /** Changes the value from the one it holds when the change lands (uploads). */
  readonly update?: ((change: (current: InputValue) => InputValue) => void) | undefined;
}

const choiceRow =
  'flex min-h-11 items-center gap-2 rounded-md px-2 text-body sm:min-h-8 hover:bg-surface-sunken';
/** One choice of a single-choice question: a pill (design "Form công khai"). */
const choicePill =
  'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-line-control bg-surface px-3.5 text-body sm:min-h-9 ' +
  'hover:bg-surface-sunken has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:font-medium ' +
  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent';

function asList(value: InputValue): readonly string[] {
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function toggle(list: readonly string[], item: string, on: boolean): string[] {
  return on ? [...new Set([...list, item])] : list.filter((entry) => entry !== item);
}

interface Choice {
  readonly value: string;
  readonly label: string;
  readonly detail?: string | undefined;
}

/** Radio buttons (one) or check boxes (several) in a labelled group. */
function ChoiceGroup({
  choices,
  multiple,
  value,
  onChange,
  control,
  labelId,
}: {
  choices: readonly Choice[];
  multiple: boolean;
  value: InputValue;
  onChange: (value: InputValue) => void;
  control: ControlProps;
  labelId: string;
}) {
  const name = useId();
  const selected = multiple ? asList(value) : [typeof value === 'string' ? value : ''];
  return (
    <div
      id={control.id}
      role={multiple ? 'group' : 'radiogroup'}
      aria-labelledby={labelId}
      aria-describedby={control.describedBy}
      aria-invalid={multiple ? undefined : control.invalid}
      aria-required={multiple ? undefined : control.required}
      className={multiple ? 'flex flex-col gap-0.5' : 'flex flex-wrap gap-2'}
    >
      {choices.map((choice) => (
        <label key={choice.value} className={multiple ? choiceRow : choicePill}>
          <input
            type={multiple ? 'checkbox' : 'radio'}
            name={name}
            value={choice.value}
            checked={selected.includes(choice.value)}
            disabled={control.disabled}
            className="size-4 shrink-0 accent-accent"
            onChange={(event) => {
              if (multiple) onChange(toggle(asList(value), choice.value, event.target.checked));
              else onChange(choice.value);
            }}
          />
          <span className="flex min-w-0 flex-col">
            <span className="break-words">{choice.label}</span>
            {choice.detail === undefined ? null : (
              <span className="truncate text-label font-normal text-fg-muted">{choice.detail}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

/** A native select list with an empty choice (one value). */
function ChoiceSelect({
  choices,
  value,
  onChange,
  control,
  placeholder,
}: {
  choices: readonly Choice[];
  value: InputValue;
  onChange: (value: InputValue) => void;
  control: ControlProps;
  placeholder: string;
}) {
  return (
    <Select
      id={control.id}
      value={typeof value === 'string' ? value : ''}
      disabled={control.disabled}
      aria-describedby={control.describedBy}
      aria-invalid={control.invalid}
      aria-required={control.required}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">{placeholder}</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.detail === undefined ? choice.label : `${choice.label} (${choice.detail})`}
        </option>
      ))}
    </Select>
  );
}

function MemberChoices({
  members,
  multiple,
  value,
  onChange,
  control,
  labelId,
}: {
  members: readonly FormMember[];
  multiple: boolean;
  value: InputValue;
  onChange: (value: InputValue) => void;
  control: ControlProps;
  labelId: string;
}) {
  const { t } = useTranslation('form');
  const [search, setSearch] = useState('');
  const choices = memberChoices(members);
  if (!multiple) {
    return (
      <ChoiceSelect
        choices={choices}
        value={value}
        onChange={onChange}
        control={control}
        placeholder={t('fill.choose')}
      />
    );
  }
  const needle = search.trim().toLowerCase();
  const selected = asList(value);
  const shown =
    needle === ''
      ? choices
      : choices.filter(
          (choice) =>
            selected.includes(choice.value) ||
            choice.label.toLowerCase().includes(needle) ||
            (choice.detail ?? '').toLowerCase().includes(needle),
        );
  return (
    <div className="flex flex-col gap-1">
      {members.length >= MEMBER_SEARCH_FROM ? (
        <Input
          type="search"
          value={search}
          aria-label={t('fill.searchPeople')}
          placeholder={t('fill.searchPeople')}
          disabled={control.disabled}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      ) : null}
      <div className="max-h-64 overflow-y-auto">
        <ChoiceGroup
          choices={shown}
          multiple
          value={value}
          onChange={onChange}
          control={control}
          labelId={labelId}
        />
      </div>
    </div>
  );
}

/**
 * Choices of a user question: the name of each person, their email only
 * when needed — no name, or another person with the same name.
 */
export function memberChoices(members: readonly FormMember[]): Choice[] {
  const names = new Map<string, number>();
  for (const member of members) {
    const key = member.name.trim().toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  return members.map((member) => {
    const name = member.name.trim();
    if (name === '') return { value: member.id, label: member.email ?? member.id };
    // Through a form link there is no email: people with the same name stay alike.
    const detail = (names.get(name.toLowerCase()) ?? 0) > 1 ? member.email : null;
    return { value: member.id, label: name, ...(detail === null ? {} : { detail }) };
  });
}

/**
 * The input of one question by field type (CONTRACTS §2): native controls
 * (keyboard, screen readers and mobile pickers work as users expect),
 * checked with the grid editors' parsing when the form is sent.
 */
export function QuestionInput({
  question,
  value,
  onChange,
  control,
  labelId,
  members,
  links,
  files,
  update,
}: QuestionInputProps) {
  const { t } = useTranslation('form');
  const config = question.config;
  const common = {
    id: control.id,
    disabled: control.disabled,
    'aria-describedby': control.describedBy,
    'aria-invalid': control.invalid,
    'aria-required': control.required,
  };
  const text = typeof value === 'string' ? value : '';
  const onText = (next: string) => {
    onChange(next);
  };

  if (config === null) {
    return (
      <p id={control.id} className="text-fg-muted">
        {t('fill.unsupported')}
      </p>
    );
  }

  switch (config.type) {
    case 'text': {
      // Plain text is written on several lines, except the primary field (a title).
      const style = config.options.style.type;
      if (style === 'plain' && question.field.is_primary !== true) {
        return (
          <textarea
            {...common}
            rows={3}
            value={text}
            className={cn(
              'min-h-20 w-full min-w-0 rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg',
              'disabled:cursor-not-allowed disabled:bg-surface-sunken aria-invalid:border-danger',
            )}
            onChange={(event) => {
              onText(event.target.value);
            }}
          />
        );
      }
      const type =
        style === 'email' ? 'email' : style === 'url' ? 'url' : style === 'phone' ? 'tel' : 'text';
      return (
        <Input
          {...common}
          type={type}
          value={text}
          autoComplete={style === 'email' ? 'email' : style === 'phone' ? 'tel' : 'off'}
          onChange={(event) => {
            onText(event.target.value);
          }}
        />
      );
    }
    case 'number': {
      const percent = isPercentStyle(config.options);
      return (
        <div className="flex items-center gap-2">
          <Input
            {...common}
            inputMode="decimal"
            value={text}
            className={percent ? 'max-w-48' : 'max-w-72'}
            onChange={(event) => {
              onText(event.target.value);
            }}
          />
          {percent ? (
            <span aria-hidden="true" className="text-fg-muted">
              %
            </span>
          ) : null}
        </div>
      );
    }
    case 'datetime': {
      // Typed in the field's format (dd/MM/yyyy…), read like the grid editor reads it:
      // the browser's own picker follows the browser locale (mm/dd/yyyy) instead.
      const format = config.options.style.format;
      return (
        <Input
          {...common}
          type="text"
          autoComplete="off"
          value={text}
          placeholder={format.toLowerCase()}
          title={t('fill.dateFormat', { format: format.toLowerCase() })}
          className="max-w-72 tabular-nums"
          onChange={(event) => {
            onText(event.target.value);
          }}
        />
      );
    }
    case 'checkbox':
      return (
        <label className={cn(choiceRow, 'w-fit')}>
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            aria-labelledby={labelId}
            className="size-4 shrink-0 accent-accent"
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          <span>{t('fill.checked')}</span>
        </label>
      );
    case 'select': {
      const choices = config.options.options.map((option) => ({
        value: option.name,
        label: option.name,
      }));
      if (config.options.multiple || choices.length <= MAX_INLINE_CHOICES) {
        return (
          <ChoiceGroup
            choices={choices}
            multiple={config.options.multiple}
            value={value}
            onChange={onChange}
            control={control}
            labelId={labelId}
          />
        );
      }
      return (
        <ChoiceSelect
          choices={choices}
          value={value}
          onChange={onChange}
          control={control}
          placeholder={t('fill.choose')}
        />
      );
    }
    case 'user':
      if (members === undefined) {
        return (
          <p id={control.id} className="text-fg-muted">
            {t('fill.unsupported')}
          </p>
        );
      }
      return (
        <MemberChoices
          members={members}
          multiple={config.options.multiple}
          value={value}
          onChange={onChange}
          control={control}
          labelId={labelId}
        />
      );
    case 'link':
      if (links === undefined) break;
      return (
        <LinkQuestion
          fieldId={question.field.id}
          multiple={config.options.allow_multiple}
          value={value}
          onChange={onChange}
          control={control}
          labelId={labelId}
          source={links}
        />
      );
    case 'attachment': {
      if (files === undefined) break;
      const maxFiles = Math.min(
        config.options.max_files,
        files.maxFiles ?? config.options.max_files,
      );
      return (
        <FileQuestion
          target={files.target}
          options={{ ...config.options, max_files: maxFiles }}
          value={value}
          update={
            update ??
            ((change) => {
              onChange(change(value));
            })
          }
          control={control}
          labelId={labelId}
          store={files.store}
          maxTotalBytes={files.maxTotalBytes}
        />
      );
    }
    default:
      break;
  }
  return (
    <p id={control.id} className="text-fg-muted">
      {t('fill.unsupported')}
    </p>
  );
}
