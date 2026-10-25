import { linkOptionsSchema, selectOptionsSchema, numberOptionsSchema } from '@cellhive/field-types';
import { Input, Select } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { linksApi } from '../../../lib/api/links';
import { keys } from '../../../lib/query/keys';
import { orgMembersQuery } from '../../../lib/query/queries';

import { valueShapeOf, type OperandKind } from './filter-model';
import {
  DATE_MODES,
  DEFAULT_DAYS,
  dateChoiceOf,
  dateOperand,
  listOf,
  needsAmount,
  pairOf,
  USER_VARIABLES,
  userKey,
  userOperand,
  type DateChoice,
  type DateMode,
} from './values';

import type { FieldDto } from '@cellhive/contracts';
import type { DslOperator } from '@cellhive/filter-dsl';

export interface ValueEditorProps {
  readonly field: FieldDto;
  readonly operator: DslOperator;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly orgId: string;
  /** Accessible name of the value controls ("Value of <field>"). */
  readonly label: string;
  readonly invalid: boolean;
  /**
   * Offer "current user" / "their groups" for user values (default). A
   * lookup condition (T467) compares with fixed users only.
   */
  readonly userVariables?: boolean;
}

const CONTROL = 'h-8 min-w-0';
/** Any decimal is a valid number value. */
const ANY_STEP = 'any';

/** Stored percentages are fractions (0.2 shows as 20 %): the editor works in percent. */
function percentFactor(field: FieldDto): number {
  // A computed number (T468) takes the percentage of its result `style`.
  const computed = field.type === 'formula' || field.type === 'lookup';
  if (field.type !== 'number' && !computed) return 1;
  const parsed = numberOptionsSchema.safeParse(
    computed ? { style: field.options['style'] ?? undefined } : field.options,
  );
  if (!parsed.success) return 1;
  const style = parsed.data.style;
  return (style.type === 'plain' || style.type === 'progress') && style.percentage ? 100 : 1;
}

function NumberInput({
  field,
  value,
  onChange,
  label,
  invalid,
}: {
  field: FieldDto;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  invalid: boolean;
}) {
  const factor = percentFactor(field);
  const shown = typeof value === 'number' ? String(Math.round(value * factor * 1e9) / 1e9) : '';
  // The text typed stays as typed ("1." on the way to "1.5"); a value set elsewhere replaces it.
  const [text, setText] = useState(shown);
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    const typed = Number.parseFloat(text);
    if (!(typeof value === 'number' && typed / factor === value)) setText(shown);
  }
  return (
    <Input
      type="number"
      step={ANY_STEP}
      inputMode="decimal"
      className={`${CONTROL} w-32`}
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(event) => {
        setText(event.currentTarget.value);
        const number = event.currentTarget.valueAsNumber;
        onChange(Number.isFinite(number) ? number / factor : undefined);
      }}
    />
  );
}

function DateInput({
  value,
  onChange,
  label,
  invalid,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  invalid: boolean;
}) {
  const { t } = useTranslation('toolbar');
  const choice = dateChoiceOf(value);
  const set = (next: DateChoice) => {
    onChange(dateOperand(next));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Select
        className={`${CONTROL} w-44`}
        aria-label={t('filter.dateMode', { label })}
        value={choice.mode}
        onChange={(event) => {
          const mode = event.currentTarget.value as DateMode;
          set(
            mode === 'exact'
              ? { mode, date: choice.mode === 'exact' ? choice.date : '' }
              : needsAmount(mode)
                ? {
                    mode,
                    amount: 'amount' in choice ? (choice.amount ?? DEFAULT_DAYS) : DEFAULT_DAYS,
                  }
                : { mode },
          );
        }}
      >
        {DATE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`filter.dates.${mode}`)}
          </option>
        ))}
      </Select>
      {choice.mode === 'exact' ? (
        <Input
          type="date"
          className={`${CONTROL} w-40`}
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={choice.date}
          onChange={(event) => {
            set({ mode: 'exact', date: event.currentTarget.value });
          }}
        />
      ) : null}
      {needsAmount(choice.mode) ? (
        <Input
          type="number"
          min={0}
          max={36_500}
          step={1}
          className={`${CONTROL} w-20`}
          aria-label={t('filter.days', { label })}
          aria-invalid={invalid || undefined}
          value={'amount' in choice ? String(choice.amount ?? DEFAULT_DAYS) : ''}
          onChange={(event) => {
            const amount = event.currentTarget.valueAsNumber;
            if (choice.mode === 'exact') return;
            set({
              mode: choice.mode,
              amount: Number.isInteger(amount) && amount >= 0 ? amount : 0,
            });
          }}
        />
      ) : null}
    </span>
  );
}

function OneValue({ kind, props }: { kind: OperandKind; props: ValueEditorProps }) {
  const { t } = useTranslation('toolbar');
  const { field, value, onChange, label, invalid } = props;
  switch (kind) {
    case 'number':
      return (
        <NumberInput
          field={field}
          value={value}
          onChange={onChange}
          label={label}
          invalid={invalid}
        />
      );
    case 'date':
      return <DateInput value={value} onChange={onChange} label={label} invalid={invalid} />;
    case 'boolean':
      return (
        <Select
          className={`${CONTROL} w-40`}
          aria-label={label}
          value={value === false ? 'false' : 'true'}
          onChange={(event) => {
            onChange(event.currentTarget.value === 'true');
          }}
        >
          <option value="true">{t('filter.checked')}</option>
          <option value="false">{t('filter.unchecked')}</option>
        </Select>
      );
    case 'option': {
      const options = selectOptionsOf(field);
      const selected = listOf(value)[0];
      return (
        <Select
          className={`${CONTROL} w-48`}
          aria-label={label}
          aria-invalid={invalid || undefined}
          value={typeof selected === 'string' ? selected : ''}
          onChange={(event) => {
            onChange(event.currentTarget.value === '' ? undefined : event.currentTarget.value);
          }}
        >
          <option value="">{t('filter.chooseOption')}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      );
    }
    default:
      return (
        <Input
          className={`${CONTROL} w-48`}
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder={t('filter.valuePlaceholder')}
          value={typeof value === 'string' ? value : ''}
          maxLength={10_000}
          onChange={(event) => {
            const text = event.currentTarget.value;
            onChange(text === '' ? undefined : text);
          }}
        />
      );
  }
}

function selectOptionsOf(field: FieldDto) {
  const parsed = selectOptionsSchema.safeParse(field.options);
  return parsed.success ? parsed.data.options : [];
}

/** A checklist of choices (options, users): the value is the list of checked keys. */
function Checklist({
  label,
  choices,
  checked,
  onChange,
  invalid,
}: {
  label: string;
  choices: readonly { key: string; name: string }[];
  checked: readonly string[];
  onChange: (keys: string[]) => void;
  invalid: boolean;
}) {
  const { t } = useTranslation('toolbar');
  const legendId = useId();
  const set = new Set(checked);
  return (
    <fieldset
      aria-labelledby={legendId}
      aria-invalid={invalid || undefined}
      className="flex max-h-40 min-w-48 flex-col gap-1 overflow-y-auto rounded-md border border-line-control px-2 py-1 aria-invalid:border-danger"
    >
      <legend id={legendId} className="sr-only">
        {label}
      </legend>
      {choices.length === 0 ? (
        <span className="text-label text-fg-muted">{t('filter.noChoices')}</span>
      ) : null}
      {choices.map((choice) => (
        <label key={choice.key} className="flex items-center gap-2 text-body">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-accent"
            checked={set.has(choice.key)}
            onChange={(event) => {
              const next = event.currentTarget.checked
                ? [...checked, choice.key]
                : checked.filter((key) => key !== choice.key);
              onChange(next);
            }}
          />
          <span className="truncate">{choice.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Texts of a list operator on a list of texts computed by a formula or
 * lookup (T468; `has_any_of`… compare exact strings): each text is a chip,
 * Enter adds what was typed, Backspace in the empty box removes the last.
 */
function TextListInput({ label, value, onChange, invalid }: ValueEditorProps) {
  const { t } = useTranslation('toolbar');
  const [text, setText] = useState('');
  const items = listOf(value).filter((item): item is string => typeof item === 'string');
  const set = (next: string[]) => {
    onChange(next.length === 0 ? undefined : next);
  };
  const add = () => {
    const typed = text.trim();
    if (typed === '') return;
    if (!items.includes(typed)) set([...items, typed]);
    setText('');
  };
  return (
    <span className="inline-flex min-w-48 flex-wrap items-center gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex h-6 items-center gap-1 rounded-sm bg-surface-sunken pl-2 text-label font-normal"
        >
          {item}
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded-sm text-fg-muted hover:text-fg"
            aria-label={t('filter.removeText', { text: item })}
            onClick={() => {
              set(items.filter((other) => other !== item));
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ))}
      <Input
        className={`${CONTROL} w-40`}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={t('filter.addText')}
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          } else if (event.key === 'Backspace' && text === '' && items.length > 0) {
            set(items.slice(0, -1));
          }
        }}
      />
    </span>
  );
}

function UserChecklist(props: ValueEditorProps) {
  const { t } = useTranslation('toolbar');
  const members = useQuery(orgMembersQuery(props.orgId));
  const choices = useMemo(
    () => [
      ...(props.userVariables === false ? [] : USER_VARIABLES).map((name) => ({
        key: `$var:${name}`,
        name: t(`filter.variables.${name}`),
      })),
      ...(members.data?.items ?? []).map((member) => ({
        key: member.user.id,
        name: member.user.display_name || member.user.email,
      })),
    ],
    [members.data, t, props.userVariables],
  );
  const checked = listOf(props.value)
    .map(userKey)
    .filter((key): key is string => key !== null);
  return (
    <Checklist
      label={props.label}
      choices={choices}
      checked={checked}
      invalid={props.invalid}
      onChange={(keys) => {
        props.onChange(keys.length === 0 ? undefined : keys.map(userOperand));
      }}
    />
  );
}

/** Records offered by the link filter's search (a page; the search narrows it). */
const RECORD_CHOICES = 30;

/**
 * Linked records of a link condition (T413): a search of the linked table
 * (the link picker's candidates, the user's rights, `record_filter` not
 * applied: a filter may name any record the user reads) and a checklist;
 * the chosen records stay listed with their titles. The value is record ids.
 */
function RecordChecklist(props: ValueEditorProps) {
  const { t } = useTranslation('toolbar');
  const parsed = linkOptionsSchema.safeParse(props.field.options);
  const linkTable = parsed.success ? parsed.data.link_table : '';
  const [search, setSearch] = useState('');
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(search.trim());
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search]);
  const checked = listOf(props.value).flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { id?: unknown }).id === 'string'
    ) {
      return [(item as { id: string }).id];
    }
    return [];
  });
  const chosen = useQuery({
    queryKey: keys.linkCandidates(linkTable, props.field.id, { filter: true, ids: checked }),
    queryFn: ({ signal }) =>
      linksApi.candidates(props.field.id, { ids: checked, limit: 100 }, { signal }),
    enabled: checked.length > 0 && linkTable !== '',
    staleTime: 60_000,
  });
  const found = useQuery({
    queryKey: keys.linkCandidates(linkTable, props.field.id, { filter: true, search: settled }),
    queryFn: ({ signal }) =>
      linksApi.candidates(
        props.field.id,
        { search: settled === '' ? null : settled, limit: RECORD_CHOICES },
        { signal },
      ),
    enabled: linkTable !== '',
    staleTime: 30_000,
  });
  const titles = new Map<string, string>();
  for (const item of [...(chosen.data?.items ?? []), ...(found.data?.items ?? [])]) {
    titles.set(item.id, item.title ?? t('filter.noAccessRecord'));
  }
  const choices = [
    ...checked.map((id) => ({ key: id, name: titles.get(id) ?? t('filter.noAccessRecord') })),
    ...(found.data?.items ?? [])
      .filter((item) => !checked.includes(item.id))
      .map((item) => ({ key: item.id, name: item.title ?? t('filter.noAccessRecord') })),
  ];
  return (
    <span className="inline-flex flex-col gap-1">
      <Input
        type="search"
        className={`${CONTROL} w-48`}
        aria-label={t('filter.searchRecords', { label: props.label })}
        placeholder={t('filter.searchRecordsPlaceholder')}
        value={search}
        onChange={(event) => {
          setSearch(event.currentTarget.value);
        }}
      />
      {found.isError ? (
        <span className="text-label text-fg-muted">{t('filter.recordsUnavailable')}</span>
      ) : (
        <Checklist
          label={props.label}
          choices={choices}
          checked={checked}
          invalid={props.invalid}
          onChange={(ids) => {
            props.onChange(ids.length === 0 ? undefined : ids);
          }}
        />
      )}
    </span>
  );
}

/**
 * The value controls of a condition, by field type and operator (T311):
 * text, number (percent fields in percent), date (exact or relative:
 * today, N days ago…), checkbox, options, users with "current user".
 */
export function ValueEditor(props: ValueEditorProps) {
  const { t } = useTranslation('toolbar');
  const shape = valueShapeOf(props.field, props.operator);
  if (shape.shape === 'none') return null;
  if (shape.shape === 'pair') {
    const [from, to] = pairOf(props.value);
    const setPair = (index: 0 | 1, next: unknown) => {
      const pair: [unknown, unknown] = [from, to];
      pair[index] = next;
      props.onChange(pair[0] === undefined && pair[1] === undefined ? undefined : pair);
    };
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <OneValue
          kind={shape.kind}
          props={{
            ...props,
            value: from,
            label: t('filter.from', { label: props.label }),
            onChange: (next) => {
              setPair(0, next);
            },
          }}
        />
        <span className="text-label text-fg-muted">{t('filter.and')}</span>
        <OneValue
          kind={shape.kind}
          props={{
            ...props,
            value: to,
            label: t('filter.to', { label: props.label }),
            onChange: (next) => {
              setPair(1, next);
            },
          }}
        />
      </span>
    );
  }
  if (shape.shape === 'list') {
    if (shape.kind === 'user') return <UserChecklist {...props} />;
    if (shape.kind === 'record') return <RecordChecklist {...props} />;
    if (shape.kind === 'text') return <TextListInput {...props} />;
    if (shape.kind === 'option') {
      const choices = selectOptionsOf(props.field).map((option) => ({
        key: option.id,
        name: option.name,
      }));
      const checked = listOf(props.value).filter((key): key is string => typeof key === 'string');
      return (
        <Checklist
          label={props.label}
          choices={choices}
          checked={checked}
          invalid={props.invalid}
          onChange={(keys) => {
            props.onChange(keys.length === 0 ? undefined : keys);
          }}
        />
      );
    }
    return null;
  }
  return <OneValue kind={shape.kind} props={props} />;
}
