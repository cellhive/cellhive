import { TEXT_STYLES, type TextOptions, type TextStyle } from '@cellhive/field-types';
import { FormField, Input, Select } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

export interface TextOptionsFormProps {
  readonly value: TextOptions;
  readonly onChange: (value: TextOptions) => void;
}

/** `text` options (SPEC §5.5): display style and default value. */
export function TextOptionsForm({ value, onChange }: TextOptionsFormProps) {
  const { t } = useTranslation('field');
  return (
    <>
      <FormField label={t('text.style')} hint={t('text.styleHint')}>
        {(control) => (
          <Select
            {...control}
            value={value.style.type}
            onChange={(event) => {
              onChange({ ...value, style: { type: event.target.value as TextStyle } });
            }}
          >
            {TEXT_STYLES.map((style) => (
              <option key={style} value={style}>
                {t(`text.styles.${style}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={t('defaultValue')} hint={t('defaultValueHint')}>
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            value={value.default_value ?? ''}
            onChange={(event) => {
              onChange({ ...value, default_value: event.target.value });
            }}
          />
        )}
      </FormField>
    </>
  );
}
