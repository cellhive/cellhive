import { Input, Select } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { orgMembersQuery } from '../../../../../lib/query/queries';
import { useBuilderEnv } from '../env';

import type { FieldDto } from '@cellhive/contracts';

const ANY_STEP = 'any';

/** Field types whose literal is typed or chosen here (others take a source from "+"). */
export const LITERAL_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'select',
  'checkbox',
  'datetime',
  'user',
]);

interface SelectOption {
  readonly id: string;
  readonly name: string;
}

function selectOptionsOf(field: FieldDto): { multiple: boolean; options: SelectOption[] } {
  const options = field.options as { multiple?: boolean; options?: SelectOption[] } | undefined;
  return { multiple: options?.multiple === true, options: options?.options ?? [] };
}

function isDateOnly(field: FieldDto): boolean {
  const format = (field.options as { style?: { format?: string } } | undefined)?.style?.format;
  return format === undefined || !format.includes('HH');
}

export interface LiteralEditorProps {
  readonly field: FieldDto | null;
  /** The literal (`{ literal }` of SPEC §11.4) in the write shape of CONTRACTS §2. */
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly label: string;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  /** Without a field: a date and time (`YYYY-MM-DDTHH:mm`, the organization zone — `delay.until`). */
  readonly kind?: 'datetime' | undefined;
}

/**
 * A constant for a field, in the write shape of its type (CONTRACTS §2;
 * the run writes with `typecast`): number, option ids, checkbox, date
 * (`YYYY-MM-DD`, or `YYYY-MM-DD HH:mm` read in the field's zone), people.
 * Without a field (an `if` comparison): text, a number when it reads as one.
 */
export function LiteralEditor({
  field,
  value,
  onChange,
  label,
  invalid,
  describedBy,
  kind,
}: LiteralEditorProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const members = useQuery({ ...orgMembersQuery(env.orgId), enabled: field?.type === 'user' });
  const common = {
    'aria-label': label,
    'aria-invalid': invalid === true || undefined,
    'aria-describedby': describedBy,
  };

  if (field === null && kind === 'datetime') {
    return (
      <Input
        {...common}
        type="datetime-local"
        value={typeof value === 'string' ? value.slice(0, 16) : ''}
        onChange={(event) => {
          onChange(event.target.value === '' ? undefined : event.target.value);
        }}
      />
    );
  }

  if (field === null) {
    return (
      <Input
        {...common}
        value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
        onChange={(event) => {
          const text = event.target.value;
          if (text === '') onChange(undefined);
          else onChange(/^-?\d+(?:\.\d+)?$/u.test(text.trim()) ? Number(text.trim()) : text);
        }}
      />
    );
  }

  switch (field.type) {
    case 'number':
      return (
        <Input
          {...common}
          type="number"
          step={ANY_STEP}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(event) => {
            const number = event.target.valueAsNumber;
            onChange(Number.isFinite(number) ? number : undefined);
          }}
        />
      );
    case 'checkbox':
      return (
        <Select
          {...common}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === '' ? undefined : next === 'true');
          }}
        >
          <option value="">{t('values.choose')}</option>
          <option value="true">{t('values.checked')}</option>
          <option value="false">{t('values.unchecked')}</option>
        </Select>
      );
    case 'select': {
      const { multiple, options } = selectOptionsOf(field);
      if (!multiple) {
        return (
          <Select
            {...common}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => {
              onChange(event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">{t('values.choose')}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        );
      }
      const chosen = Array.isArray(value) ? (value as unknown[]) : [];
      return (
        <fieldset
          className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 rounded-md border border-line-control px-2 py-1.5"
          aria-describedby={describedBy}
        >
          <legend className="sr-only">{label}</legend>
          {options.map((option) => (
            <label key={option.id} className="flex min-h-8 items-center gap-1.5 text-body">
              <input
                type="checkbox"
                checked={chosen.includes(option.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...chosen, option.id]
                    : chosen.filter((item) => item !== option.id);
                  onChange(next.length === 0 ? undefined : next);
                }}
              />
              {option.name}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'datetime': {
      const dateOnly = isDateOnly(field);
      const text = typeof value === 'string' ? value : '';
      return (
        <Input
          {...common}
          type={dateOnly ? 'date' : 'datetime-local'}
          value={dateOnly ? text.slice(0, 10) : text.replace(' ', 'T').slice(0, 16)}
          onChange={(event) => {
            const next = event.target.value;
            if (next === '') onChange(undefined);
            else onChange(dateOnly ? next : next.replace('T', ' '));
          }}
        />
      );
    }
    case 'user': {
      const multiple = (field.options as { multiple?: boolean } | undefined)?.multiple !== false;
      const people = members.data?.items ?? [];
      const chosen = Array.isArray(value)
        ? (value as { id?: string }[]).map((item) => item.id ?? '')
        : [];
      if (!multiple) {
        return (
          <Select
            {...common}
            value={chosen[0] ?? ''}
            onChange={(event) => {
              const id = event.target.value;
              onChange(id === '' ? undefined : [{ id }]);
            }}
          >
            <option value="">{t('values.choose')}</option>
            {people.map((member) => (
              <option key={member.user.id} value={member.user.id}>
                {member.user.display_name}
              </option>
            ))}
          </Select>
        );
      }
      return (
        <fieldset
          className="flex max-h-40 min-w-0 flex-col gap-1 overflow-y-auto rounded-md border border-line-control px-2 py-1.5"
          aria-describedby={describedBy}
        >
          <legend className="sr-only">{label}</legend>
          {people.map((member) => (
            <label key={member.user.id} className="flex min-h-8 items-center gap-1.5 text-body">
              <input
                type="checkbox"
                checked={chosen.includes(member.user.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...chosen, member.user.id]
                    : chosen.filter((item) => item !== member.user.id);
                  onChange(next.length === 0 ? undefined : next.map((id) => ({ id })));
                }}
              />
              {member.user.display_name}
            </label>
          ))}
        </fieldset>
      );
    }
    default:
      return (
        <p className="flex min-h-control items-center text-label font-normal text-fg-muted">
          {t('values.sourceOnly')}
        </p>
      );
  }
}
