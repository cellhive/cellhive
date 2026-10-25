import { RATING_ICONS, type NumberOptions, type NumberStyle } from '@cellhive/field-types';
import { Checkbox, FormField, Input, Select } from '@cellhive/ui';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { defaultNumberStyle, type DraftIssue } from '../../draft';
import { issueAt, useIssueText } from '../shared';

const STYLE_TYPES: readonly NumberStyle['type'][] = ['plain', 'currency', 'progress', 'rating'];
const PRECISIONS = [0, 1, 2, 3, 4] as const;
const RATING_MAX = Array.from({ length: 10 }, (_, index) => index + 1);
/** Any decimal is allowed in the default value. */
const ANY_STEP = 'any';

/** The currency style without an explicit precision (the currency's own minor units). */
function withoutPrecision(style: NumberStyle & { type: 'currency' }): NumberStyle {
  const next = { ...style };
  delete next.precision;
  return next;
}

/** ISO 4217 codes known to this browser, with their names in the UI language. */
function useCurrencies(locale: string): readonly { code: string; label: string }[] {
  return useMemo(() => {
    const names = new Intl.DisplayNames([locale], { type: 'currency' });
    return Intl.supportedValuesOf('currency').map((code) => ({
      code,
      label: `${code} · ${names.of(code) ?? code}`,
    }));
  }, [locale]);
}

export interface NumberOptionsFormProps {
  readonly value: NumberOptions;
  readonly onChange: (value: NumberOptions) => void;
  readonly issues: readonly DraftIssue[];
  /** Currency proposed when switching to the currency style. */
  readonly defaultCurrency: string;
}

/** `number` options: style (plain, currency, progress, rating) and default value. */
export function NumberOptionsForm({
  value,
  onChange,
  issues,
  defaultCurrency,
}: NumberOptionsFormProps) {
  const { t, i18n } = useTranslation('field');
  const issueText = useIssueText();
  const currencies = useCurrencies(i18n.language);
  const style = value.style;
  const currencyIssue = issueAt(issues, 'options.style.currency_code');
  const defaultIssue = issueAt(issues, 'options.default_value');
  const setStyle = (next: NumberStyle) => {
    onChange({ ...value, style: next });
  };
  return (
    <>
      <FormField label={t('number.style')}>
        {(control) => (
          <Select
            {...control}
            value={style.type}
            onChange={(event) => {
              setStyle(
                defaultNumberStyle(event.target.value as NumberStyle['type'], defaultCurrency),
              );
            }}
          >
            {STYLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`number.styles.${type}`)}
              </option>
            ))}
          </Select>
        )}
      </FormField>

      {style.type === 'plain' ? (
        <>
          <FormField label={t('number.precision')}>
            {(control) => (
              <Select
                {...control}
                value={String(style.precision)}
                onChange={(event) => {
                  setStyle({ ...style, precision: Number(event.target.value) });
                }}
              >
                {PRECISIONS.map((precision) => (
                  <option key={precision} value={precision}>
                    {t('number.decimals', { count: precision })}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <Checkbox
            label={t('number.percentage')}
            hint={t('number.percentageHint')}
            checked={style.percentage}
            onChange={(event) => {
              setStyle({ ...style, percentage: event.target.checked });
            }}
          />
          <Checkbox
            label={t('number.thousands')}
            checked={style.thousands_separator}
            onChange={(event) => {
              setStyle({ ...style, thousands_separator: event.target.checked });
            }}
          />
        </>
      ) : null}

      {style.type === 'currency' ? (
        <>
          <FormField label={t('number.currency')} error={issueText(currencyIssue)}>
            {(control) => (
              <Select
                {...control}
                value={style.currency_code}
                onChange={(event) => {
                  setStyle({ ...style, currency_code: event.target.value });
                }}
              >
                {currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={t('number.precision')}>
            {(control) => (
              <Select
                {...control}
                value={style.precision === undefined ? '' : String(style.precision)}
                onChange={(event) => {
                  setStyle(
                    event.target.value === ''
                      ? withoutPrecision(style)
                      : { ...style, precision: Number(event.target.value) },
                  );
                }}
              >
                <option value="">{t('number.currencyPrecision')}</option>
                {PRECISIONS.map((precision) => (
                  <option key={precision} value={precision}>
                    {t('number.decimals', { count: precision })}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </>
      ) : null}

      {style.type === 'progress' ? (
        <Checkbox
          label={t('number.progressPercentage')}
          hint={t('number.progressHint')}
          checked={style.percentage}
          onChange={(event) => {
            setStyle({ ...style, percentage: event.target.checked });
          }}
        />
      ) : null}

      {style.type === 'rating' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label={t('number.ratingIcon')}>
            {(control) => (
              <Select
                {...control}
                value={style.icon}
                onChange={(event) => {
                  setStyle({
                    ...style,
                    icon: event.target.value as (typeof RATING_ICONS)[number],
                  });
                }}
              >
                {RATING_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {t(`number.ratingIcons.${icon}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={t('number.ratingMin')}>
            {(control) => (
              <Select
                {...control}
                value={String(style.min)}
                onChange={(event) => {
                  setStyle({ ...style, min: event.target.value === '0' ? 0 : 1 });
                }}
              >
                <option value="0">0</option>
                <option value="1">1</option>
              </Select>
            )}
          </FormField>
          <FormField label={t('number.ratingMax')}>
            {(control) => (
              <Select
                {...control}
                value={String(style.max)}
                onChange={(event) => {
                  setStyle({ ...style, max: Number(event.target.value) });
                }}
              >
                {RATING_MAX.map((max) => (
                  <option key={max} value={max}>
                    {max}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      ) : null}

      <FormField
        label={t('defaultValue')}
        hint={t('number.defaultHint')}
        error={issueText(defaultIssue)}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            step={ANY_STEP}
            inputMode="decimal"
            value={value.default_value ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              const number = raw === '' ? null : Number(raw);
              onChange({
                ...value,
                default_value: number !== null && Number.isFinite(number) ? number : null,
              });
            }}
          />
        )}
      </FormField>
    </>
  );
}
