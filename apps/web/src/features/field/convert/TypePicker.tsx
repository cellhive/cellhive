import { Button, FormField, Select } from '@cellhive/ui';
import { ArrowRight, Snowflake } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { typeIconOf } from '../../../lib/schema/field-icons';
import { CREATABLE_TYPES, type DraftFieldType } from '../draft';

import {
  canChangeType,
  CHOICE_GROUPS,
  groupOf,
  isComputedType,
  staticTypeOf,
  targetChoices,
} from './model';
import { LockedValue } from './parts';

import type { FieldDto } from '@cellhive/contracts';

export interface TypePickerProps {
  /** The saved field; absent: a new field (every type, no conversion). */
  readonly field?: FieldDto | undefined;
  readonly value: DraftFieldType;
  readonly onChange: (type: DraftFieldType) => void;
  /** A conversion runs: the type cannot change meanwhile. */
  readonly disabled?: boolean;
  /** Types a new field may take (default: every creatable type). */
  readonly creatable?: readonly DraftFieldType[];
}

/**
 * The type of the field (board "Đổi kiểu field"). New field: every type.
 * Saved field (T414): "current → target", the targets grouped by what the
 * conversion does to the values (CONTRACTS §4: kept, cut, lost) and the
 * types it can never become listed disabled with the reason. Link and
 * attachment fields never change type: shown locked.
 */
export function TypePicker({
  field,
  value,
  onChange,
  disabled = false,
  creatable = CREATABLE_TYPES,
}: TypePickerProps) {
  const { t } = useTranslation('field');
  const labelId = useId();
  const hintId = useId();
  const choices = useMemo(() => (field === undefined ? [] : targetChoices(field)), [field]);

  if (field === undefined) {
    return (
      <FormField label={t('type')}>
        {(control) => (
          <Select
            {...control}
            value={value}
            onChange={(event) => {
              onChange(event.target.value as DraftFieldType);
            }}
          >
            {creatable.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
    );
  }

  const CurrentIcon = typeIconOf(field.type);
  const currentName = t(`types.${field.type}`, { defaultValue: field.type });
  if (!canChangeType(field)) {
    return (
      <div className="flex flex-col gap-1">
        <span id={labelId} className="text-label text-fg">
          {t('type')}
        </span>
        <LockedValue
          icon={CurrentIcon}
          labelledBy={labelId}
          describedBy={hintId}
          data-testid="type-locked"
        >
          {currentName}
        </LockedValue>
        <p id={hintId} className="text-label font-normal text-fg-muted">
          {t(field.type === 'link' ? 'convert.picker.linkFixed' : 'convert.picker.typeFixed')}
        </p>
      </div>
    );
  }

  const chosen = choices.find((choice) => choice.type === value);
  const group = chosen === undefined ? 'current' : groupOf(chosen);
  // (T469) A formula/lookup offers its own "static" type in one click (CONTRACTS §4.1).
  const staticType = isComputedType(field.type) ? staticTypeOf(field) : null;
  const picker = (
    <FormField
      label={t('type')}
      hint={group === 'current' ? t('convert.picker.hint') : t(`convert.picker.effect.${group}`)}
    >
      {(control) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="inline-flex h-control shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2.5 text-body text-fg-muted"
            data-testid="type-current"
          >
            <CurrentIcon aria-hidden="true" className="size-3.5" />
            {currentName}
          </span>
          <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
          <Select
            {...control}
            className="w-auto min-w-44 flex-1"
            disabled={disabled}
            value={value}
            data-testid="type-target"
            onChange={(event) => {
              onChange(event.target.value as DraftFieldType);
            }}
          >
            <option value={field.type}>{t('convert.picker.current', { type: currentName })}</option>
            {CHOICE_GROUPS.map((name) => {
              const items = choices.filter((choice) => groupOf(choice) === name);
              if (items.length === 0) return null;
              return (
                <optgroup key={name} label={t(`convert.picker.groups.${name}`)}>
                  {items.map((choice) => (
                    <option
                      key={choice.type}
                      value={choice.type}
                      disabled={choice.kind === 'forbidden'}
                      data-kind={choice.kind}
                    >
                      {choice.refusal === null
                        ? t(`types.${choice.type}`)
                        : t('convert.picker.refused', {
                            type: t(`types.${choice.type}`),
                            reason: t(`convert.reasons.${choice.refusal}`),
                          })}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>
        </div>
      )}
    </FormField>
  );
  if (staticType === null || value !== field.type || disabled) return picker;
  return (
    <div className="flex flex-col gap-2">
      {picker}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          variant="secondary"
          size="sm"
          className="max-lg:h-control"
          data-testid="convert-to-static"
          onClick={() => {
            onChange(staticType);
          }}
        >
          <Snowflake aria-hidden="true" />
          {t('convert.static.action', { type: t(`types.${staticType}`) })}
        </Button>
        <span className="text-label font-normal text-fg-muted">{t('convert.static.hint')}</span>
      </div>
    </div>
  );
}
