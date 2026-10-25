import { DATETIME_FORMATS, formatComputedText, type ComputedStyle } from '@cellhive/field-types';
import { cn, Select, Switch } from '@cellhive/ui';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ComputedResultTypeDto } from '@cellhive/contracts';

/**
 * Format of the result (board "S4b · Trình soạn công thức - dialog", right
 * column; CONTRACTS §13 `style`): chosen by the inferred result type — a
 * number style (number, currency, percentage; decimals; thousands) for
 * numbers, a date format for dates, nothing for other results (the API has
 * no style for them).
 */

type Style = Readonly<Record<string, unknown>> | null;

export interface StylePanelProps {
  readonly resultType: ComputedResultTypeDto;
  /** The style in effect (chosen, or the default of the carried field). */
  readonly style: Style;
  readonly onChange: (style: Style) => void;
  readonly sample: unknown;
  readonly locale: string;
  readonly timeZone: string;
  readonly defaultCurrency: string;
}

type NumberKind = 'plain' | 'currency' | 'percentage';
const NUMBER_KINDS: readonly NumberKind[] = ['plain', 'currency', 'percentage'];
const PRECISIONS = [0, 1, 2] as const;

function numberKind(style: Style): NumberKind {
  if (style?.['type'] === 'currency') return 'currency';
  if (style?.['type'] === 'plain' && style['percentage'] === true) return 'percentage';
  return 'plain';
}

/** The number style of `kind`, keeping what was chosen so far (precision, grouping, currency). */
function numberStyle(
  current: Style,
  kind: NumberKind,
  fallbackCurrency: string,
  patch: { precision?: number; thousands?: boolean; currency?: string } = {},
): Style {
  const precision =
    patch.precision ??
    (typeof current?.['precision'] === 'number' ? current['precision'] : undefined);
  if (kind === 'currency') {
    const code =
      patch.currency ??
      (typeof current?.['currency_code'] === 'string'
        ? current['currency_code']
        : fallbackCurrency);
    return {
      type: 'currency',
      currency_code: code,
      ...(precision === undefined ? {} : { precision }),
    };
  }
  return {
    type: 'plain',
    precision: precision ?? 0,
    percentage: kind === 'percentage',
    thousands_separator:
      patch.thousands ??
      (current?.['thousands_separator'] === true || numberKind(current) === 'currency'),
  };
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  text,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  text: (option: T) => string;
  onChange: (option: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-control items-center gap-0.5 self-start rounded-md border border-line bg-surface-sunken p-[3px]"
    >
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          aria-pressed={option === value}
          onClick={() => {
            onChange(option);
          }}
          className={cn(
            'h-full rounded-[5px] px-2.5 text-label whitespace-nowrap',
            'focus-visible:outline-2 focus-visible:outline-accent',
            option === value
              ? 'bg-surface font-medium text-fg shadow-popover'
              : 'font-normal text-fg-muted',
          )}
        >
          {text(option)}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-label font-normal text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

export function StylePanel({
  resultType,
  style,
  onChange,
  sample,
  locale,
  timeZone,
  defaultCurrency,
}: StylePanelProps) {
  const { t } = useTranslation('formula');
  const currencyId = useId();
  const formatId = useId();
  const thousandsId = useId();
  const currencies = useMemo(() => Intl.supportedValuesOf('currency'), []);
  const shown = formatComputedText(
    sample ?? (resultType.kind === 'number' ? 1234567.891 : new Date().toISOString().slice(0, 10)),
    { kind: resultType.kind, list: false },
    style as ComputedStyle | null,
    { locale, timeZone },
  );

  if (resultType.kind === 'number') {
    const kind = numberKind(style);
    const precision = typeof style?.['precision'] === 'number' ? style['precision'] : undefined;
    const setKind = (next: NumberKind) => {
      onChange(numberStyle(style, next, defaultCurrency));
    };
    return (
      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
        <span className="text-label font-semibold text-fg">{t('style.number')}</span>
        <Segmented
          label={t('style.number')}
          value={kind}
          options={NUMBER_KINDS}
          text={(option) => t(`style.kinds.${option}`)}
          onChange={setKind}
        />
        {kind === 'currency' ? (
          <Row label={t('style.currency')}>
            <Select
              id={currencyId}
              aria-label={t('style.currency')}
              className="w-36"
              value={
                typeof style?.['currency_code'] === 'string'
                  ? style['currency_code']
                  : defaultCurrency
              }
              onChange={(event) => {
                onChange(
                  numberStyle(style, 'currency', defaultCurrency, { currency: event.target.value }),
                );
              }}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Row>
        ) : null}
        <Row label={t('style.precision')}>
          <Segmented
            label={t('style.precision')}
            value={precision}
            options={PRECISIONS}
            text={(option) => String(option)}
            onChange={(next) => {
              onChange(numberStyle(style, kind, defaultCurrency, { precision: next }));
            }}
          />
        </Row>
        {kind === 'currency' ? null : (
          <Row label={t('style.thousands')}>
            <Switch
              id={thousandsId}
              aria-label={t('style.thousands')}
              checked={style?.['thousands_separator'] === true}
              onChange={(event) => {
                onChange(
                  numberStyle(style, kind, defaultCurrency, { thousands: event.target.checked }),
                );
              }}
            />
          </Row>
        )}
        <div className="flex items-baseline gap-2 border-t border-line pt-2">
          <span className="text-label font-normal text-fg-muted">{t('style.shown')}</span>
          <span
            className="ml-auto font-semibold text-fg tabular-nums"
            data-testid="formula-style-sample"
          >
            {shown}
          </span>
        </div>
      </div>
    );
  }

  if (resultType.kind === 'date' || resultType.kind === 'datetime') {
    const format = typeof style?.['format'] === 'string' ? style['format'] : '';
    return (
      <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
        <span className="text-label font-semibold text-fg">{t('style.date')}</span>
        <Row label={t('style.format')}>
          <Select
            id={formatId}
            aria-label={t('style.format')}
            className="w-44"
            value={format}
            onChange={(event) => {
              onChange(event.target.value === '' ? null : { format: event.target.value });
            }}
          >
            <option value="">{t('style.defaultFormat')}</option>
            {DATETIME_FORMATS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Row>
        <p className="text-label font-normal text-fg-muted">
          {t('style.timeZone', { zone: timeZone })}
        </p>
        <div className="flex items-baseline gap-2 border-t border-line pt-2">
          <span className="text-label font-normal text-fg-muted">{t('style.shown')}</span>
          <span className="ml-auto font-semibold text-fg tabular-nums">{shown}</span>
        </div>
      </div>
    );
  }

  return <p className="text-label font-normal text-fg-muted">{t('style.none')}</p>;
}
