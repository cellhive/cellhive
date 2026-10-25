import { Checkbox, cn, FormField, Input } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConversionSettingsDraft, SettingsKind } from './model';

export interface ConversionSettingsFormProps {
  readonly kind: SettingsKind;
  readonly value: ConversionSettingsDraft;
  readonly onChange: (value: ConversionSettingsDraft) => void;
}

function RadioCard({
  name,
  checked,
  title,
  hint,
  onSelect,
}: {
  name: string;
  checked: boolean;
  title: string;
  hint: string;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-md border p-2.5 leading-snug',
        checked ? 'border-accent bg-accent-soft/60' : 'border-line',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 size-4 shrink-0"
        onChange={onSelect}
      />
      <span className="flex flex-col gap-0.5">
        <span id={`${id}-title`} className="font-medium text-fg">
          {title}
        </span>
        <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {hint}
        </span>
      </span>
    </label>
  );
}

/**
 * Settings of a conversion pair (CONTRACTS §4.1, §4.3; board "Đổi kiểu
 * field"): what becomes of the existing values of a select ← text/number,
 * the values read as checked for a checkbox, member emails for a user
 * field. Changing them previews again.
 */
export function ConversionSettingsForm({ kind, value, onChange }: ConversionSettingsFormProps) {
  const { t } = useTranslation('field');
  const group = useId();
  switch (kind) {
    case 'selectMatch':
      return (
        <fieldset className="flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 p-0 text-label text-fg">{t('convert.settings.existing')}</legend>
          <RadioCard
            name={group}
            checked={!value.matchExistingOnly}
            title={t('convert.settings.createOptions')}
            hint={t('convert.settings.createOptionsHint')}
            onSelect={() => {
              onChange({ ...value, matchExistingOnly: false });
            }}
          />
          <RadioCard
            name={group}
            checked={value.matchExistingOnly}
            title={t('convert.settings.matchOnly')}
            hint={t('convert.settings.matchOnlyHint')}
            onSelect={() => {
              onChange({ ...value, matchExistingOnly: true });
            }}
          />
        </fieldset>
      );
    case 'truthyValues':
      return (
        <FormField label={t('convert.settings.truthy')} hint={t('convert.settings.truthyHint')}>
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              value={value.truthyValues}
              placeholder={t('convert.settings.truthyPlaceholder')}
              onChange={(event) => {
                onChange({ ...value, truthyValues: event.target.value });
              }}
            />
          )}
        </FormField>
      );
    case 'matchEmail':
      return (
        <Checkbox
          label={t('convert.settings.matchEmail')}
          hint={t('convert.settings.matchEmailHint')}
          checked={value.matchEmail}
          onChange={(event) => {
            onChange({ ...value, matchEmail: event.target.checked });
          }}
        />
      );
    case null:
      return null;
  }
}
