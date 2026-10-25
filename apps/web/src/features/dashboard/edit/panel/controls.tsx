import { Checkbox, FormField, Input, Select } from '@cellhive/ui';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { translateDetail } from '../../../../lib/errors/translate';
import { issuesUnder, type ConfigIssues } from '../config-issues';

import { getIn, pathKey, type Config, type ConfigPath } from './config-paths';

/** What every control of the settings panel reads and writes (T812). */
export interface PanelContextValue {
  readonly config: Config;
  readonly issues: ConfigIssues;
  readonly update: (path: ConfigPath, value: unknown) => void;
}

/** The color a picker starts from when the widget has none. */
const PICKER_COLOR = '#2a78d6';

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (value === null) throw new Error('usePanel outside the widget panel');
  return value;
}

/** The translated problems at `path` (and below it, with `deep`), or `undefined`. */
export function useIssueText(path: ConfigPath | string, deep = false): string | undefined {
  const { issues } = usePanel();
  const { i18n } = useTranslation();
  const key = typeof path === 'string' ? path : pathKey(path);
  const details = deep ? issuesUnder(issues, key) : (issues.get(key) ?? []);
  if (details.length === 0) return undefined;
  return [...new Set(details.map((detail) => translateDetail(i18n, detail)))].join(' ');
}

/** A titled group of settings. */
export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 id={id} className="text-label font-semibold text-fg">
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
}

/** A `<select>` bound to `path` (the empty value is `null` when `nullable`). */
export function SelectSetting({
  path,
  label,
  options,
  nullLabel,
  hint,
  onChange,
  testId,
}: {
  readonly path: ConfigPath;
  readonly label: string;
  readonly options: readonly ChoiceOption[];
  /** Offers "none" first (stored as `null`). */
  readonly nullLabel?: string;
  readonly hint?: string;
  /** Instead of writing `path`: the caller applies the change (several keys at once). */
  readonly onChange?: (value: string | null) => void;
  readonly testId?: string | undefined;
}) {
  const { config, update } = usePanel();
  const error = useIssueText(path, true);
  const raw = getIn(config, path);
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
  const known = value === '' || options.some((option) => option.value === value);
  return (
    <FormField label={label} error={error} hint={hint}>
      {(control) => (
        <Select
          {...control}
          value={value}
          data-testid={testId}
          onChange={(event) => {
            const next = event.currentTarget.value === '' ? null : event.currentTarget.value;
            if (onChange === undefined) update(path, next);
            else onChange(next);
          }}
        >
          {nullLabel === undefined ? null : <option value="">{nullLabel}</option>}
          {known ? null : <option value={value}>{value}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

/** A text box bound to `path` (`''` is stored as `null` when `nullable`). */
export function TextSetting({
  path,
  label,
  placeholder,
  nullable = true,
  maxLength,
  testId,
}: {
  readonly path: ConfigPath;
  readonly label: string;
  readonly placeholder?: string;
  readonly nullable?: boolean;
  readonly maxLength?: number;
  readonly testId?: string;
}) {
  const { config, update } = usePanel();
  const error = useIssueText(path);
  const raw = getIn(config, path);
  return (
    <FormField label={label} error={error}>
      {(control) => (
        <Input
          {...control}
          value={typeof raw === 'string' ? raw : ''}
          placeholder={placeholder}
          maxLength={maxLength}
          data-testid={testId}
          onChange={(event) => {
            const next = event.currentTarget.value;
            update(path, next === '' && nullable ? null : next);
          }}
        />
      )}
    </FormField>
  );
}

/** A number box bound to `path` (empty is `null`). */
export function NumberSetting({
  path,
  label,
  min,
  max,
  step,
  hint,
  testId,
}: {
  readonly path: ConfigPath;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number | 'any';
  readonly hint?: string;
  readonly testId?: string;
}) {
  const { config, update } = usePanel();
  const error = useIssueText(path);
  const raw = getIn(config, path);
  return (
    <FormField label={label} error={error} hint={hint}>
      {(control) => (
        <Input
          {...control}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={typeof raw === 'number' ? String(raw) : ''}
          data-testid={testId}
          onChange={(event) => {
            const text = event.currentTarget.value;
            const number = Number(text);
            update(path, text === '' || !Number.isFinite(number) ? null : number);
          }}
        />
      )}
    </FormField>
  );
}

/** A check box bound to `path`. */
export function CheckSetting({
  path,
  label,
  fallback = false,
  testId,
}: {
  readonly path: ConfigPath;
  readonly label: string;
  readonly fallback?: boolean;
  readonly testId?: string;
}) {
  const { config, update } = usePanel();
  const raw = getIn(config, path);
  return (
    <Checkbox
      label={label}
      checked={typeof raw === 'boolean' ? raw : fallback}
      data-testid={testId}
      onChange={(event) => {
        update(path, event.currentTarget.checked);
      }}
    />
  );
}

/** A color (`#rrggbb`) bound to `path`, or automatic (`null`). */
export function ColorSetting({
  path,
  label,
}: {
  readonly path: ConfigPath;
  readonly label: string;
}) {
  const { t } = useTranslation('dashboard');
  const { config, update } = usePanel();
  const raw = getIn(config, path);
  const color = typeof raw === 'string' ? raw : null;
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-fg">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={color ?? PICKER_COLOR}
          className="h-control w-12 cursor-pointer rounded-md border border-line-control bg-surface p-0.5"
          onChange={(event) => {
            update(path, event.currentTarget.value.toLowerCase());
          }}
        />
        <Checkbox
          label={t('edit.panel.autoColor')}
          checked={color === null}
          onChange={(event) => {
            update(path, event.currentTarget.checked ? null : PICKER_COLOR);
          }}
        />
      </div>
    </div>
  );
}
