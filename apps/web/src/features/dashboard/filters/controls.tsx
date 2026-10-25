import { RELATIVE_DATE_RANGES } from '@cellhive/contracts';
import { Button, cn, Input, Select, Spinner } from '@cellhive/ui';
import { Check, ChevronDown, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { FilterControlValue, WidgetGroupValue } from '@cellhive/contracts';

/**
 * The value pickers of the dashboard filters (T813, CONTRACTS §28.4): one
 * per control kind, shared by the global filters of the filter bar and the
 * `filter_control` widgets. Each is a labelled group of native controls
 * (keyboard and screen readers work as everywhere), never relying on color.
 */

type RelativeRange = (typeof RELATIVE_DATE_RANGES)[number];

export interface ControlProps {
  /** Visible name of the filter. */
  readonly label: string;
  readonly value: FilterControlValue | null;
  readonly onChange: (value: FilterControlValue | null) => void;
  readonly testId?: string | undefined;
  /** Labels on one line with the control (filter bar) or above it (widget). */
  readonly inline?: boolean;
  /** The name is said, not shown (a widget card already shows it as its title). */
  readonly hideLabel?: boolean | undefined;
}

function ControlGroup({
  label,
  labelId,
  inline,
  hideLabel = false,
  testId,
  children,
}: {
  readonly label: string;
  readonly labelId: string;
  readonly inline: boolean;
  readonly hideLabel?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid={testId}
      className={cn('flex min-w-0 gap-1.5', inline ? 'flex-wrap items-center' : 'flex-col')}
    >
      <span
        id={labelId}
        className={hideLabel ? 'sr-only' : 'truncate text-label font-medium text-fg'}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const CUSTOM = 'custom';

/** Date range: "any time", a range relative to today, or two dates (both included). */
export function DateRangeControl({
  label,
  value,
  onChange,
  testId,
  inline = false,
  hideLabel,
}: ControlProps) {
  const { t } = useTranslation('dashboard');
  const id = useId();
  const range = value !== null && 'range' in value ? value.range : null;
  const savedFrom = typeof range?.from === 'string' ? range.from : '';
  const savedTo = typeof range?.to === 'string' ? range.to : '';
  const [custom, setCustom] = useState(range !== null);
  // What is typed: a range whose start is after its end is shown but not applied.
  const [from, setFrom] = useState(savedFrom);
  const [to, setTo] = useState(savedTo);
  // A new value from outside (URL, "Clear filters"): shown as is.
  const [synced, setSynced] = useState(`${savedFrom}|${savedTo}`);
  if (synced !== `${savedFrom}|${savedTo}`) {
    setSynced(`${savedFrom}|${savedTo}`);
    setFrom(savedFrom);
    setTo(savedTo);
    if (savedFrom !== '' || savedTo !== '') setCustom(true);
  }
  const mode = value !== null && 'relative' in value ? value.relative : custom ? CUSTOM : '';
  const invalid = from !== '' && to !== '' && from > to;
  const setBound = (bound: 'from' | 'to', text: string) => {
    const next = {
      from: from === '' ? null : from,
      to: to === '' ? null : to,
      [bound]: text || null,
    };
    if (bound === 'from') setFrom(text);
    else setTo(text);
    if (next.from !== null && next.to !== null && next.from > next.to) return;
    onChange(next.from === null && next.to === null ? null : { range: next });
  };
  return (
    <ControlGroup
      label={label}
      labelId={`${id}-label`}
      inline={inline}
      hideLabel={hideLabel}
      testId={testId}
    >
      <Select
        aria-labelledby={`${id}-label`}
        value={mode}
        className={inline ? 'w-auto min-w-40' : undefined}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(next === '' ? null : { relative: next as RelativeRange });
        }}
      >
        <option value="">{t('filters.anyTime')}</option>
        {RELATIVE_DATE_RANGES.map((relative) => (
          <option key={relative} value={relative}>
            {t(`edit.panel.relative.${relative}`)}
          </option>
        ))}
        <option value={CUSTOM}>{t('filters.custom')}</option>
      </Select>
      {mode === CUSTOM ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Input
            type="date"
            aria-label={t('filters.fromOf', { label })}
            className="w-auto"
            value={from}
            max={to === '' ? undefined : to}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : undefined}
            onChange={(event) => {
              setBound('from', event.target.value);
            }}
          />
          <Input
            type="date"
            aria-label={t('filters.toOf', { label })}
            className="w-auto"
            value={to}
            min={from === '' ? undefined : from}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : undefined}
            onChange={(event) => {
              setBound('to', event.target.value);
            }}
          />
          {invalid ? (
            <p id={`${id}-error`} className="text-label font-normal text-danger">
              {t('filters.rangeInvalid')}
            </p>
          ) : null}
        </div>
      ) : null}
    </ControlGroup>
  );
}

function parseNumber(text: string): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const number = Number(trimmed.replace(',', '.'));
  return Number.isFinite(number) ? number : 'invalid';
}

/** Number range: a minimum and a maximum (either may be empty), applied on blur or Enter. */
export function NumberRangeControl({
  label,
  value,
  onChange,
  testId,
  inline = false,
  hideLabel,
}: ControlProps) {
  const { t } = useTranslation('dashboard');
  const id = useId();
  const range = value !== null && 'range' in value ? value.range : null;
  const shown = (bound: unknown) => (typeof bound === 'number' ? String(bound) : '');
  const [from, setFrom] = useState(shown(range?.from));
  const [to, setTo] = useState(shown(range?.to));
  const saved = `${shown(range?.from)}|${shown(range?.to)}`;
  const [synced, setSynced] = useState(saved);
  if (synced !== saved) {
    setSynced(saved);
    setFrom(shown(range?.from));
    setTo(shown(range?.to));
  }
  const low = parseNumber(from);
  const high = parseNumber(to);
  const invalid =
    low === 'invalid' ||
    high === 'invalid' ||
    (typeof low === 'number' && typeof high === 'number' && low > high);
  const commit = () => {
    if (invalid) return;
    if (low === (range?.from ?? null) && high === (range?.to ?? null)) return;
    onChange(low === null && high === null ? null : { range: { from: low, to: high } });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
  };
  return (
    <ControlGroup
      label={label}
      labelId={`${id}-label`}
      inline={inline}
      hideLabel={hideLabel}
      testId={testId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Input
          inputMode="decimal"
          aria-label={t('filters.minOf', { label })}
          placeholder={t('filters.min')}
          className="w-28"
          value={from}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => {
            setFrom(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        <span aria-hidden="true" className="text-fg-muted">
          –
        </span>
        <Input
          inputMode="decimal"
          aria-label={t('filters.maxOf', { label })}
          placeholder={t('filters.max')}
          className="w-28"
          value={to}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => {
            setTo(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
      {invalid ? (
        <p id={`${id}-error`} className="text-label font-normal text-danger">
          {t('filters.numberInvalid')}
        </p>
      ) : null}
    </ControlGroup>
  );
}

/** Text search ("contains"), applied 400 ms after typing stops. */
export function TextControl({
  label,
  value,
  onChange,
  testId,
  inline = false,
  hideLabel,
}: ControlProps) {
  const { t } = useTranslation('dashboard');
  const id = useId();
  const current = value !== null && 'values' in value ? String(value.values[0] ?? '') : '';
  const [text, setText] = useState(current);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const [synced, setSynced] = useState(current);
  if (synced !== current) {
    setSynced(current);
    setText(current);
  }
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === current) return;
    const timer = setTimeout(() => {
      latest.current(trimmed === '' ? null : { values: [trimmed] });
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, [text, current]);
  return (
    <ControlGroup
      label={label}
      labelId={`${id}-label`}
      inline={inline}
      hideLabel={hideLabel}
      testId={testId}
    >
      <Input
        type="search"
        aria-labelledby={`${id}-label`}
        placeholder={t('filters.textPlaceholder')}
        className={inline ? 'w-48' : undefined}
        maxLength={1000}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
    </ControlGroup>
  );
}

export interface OptionsSource {
  readonly items: readonly WidgetGroupValue[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  /** Search text (server-side for controls, local for global filters). */
  readonly search: string;
  readonly onSearch: (search: string) => void;
}

export interface OptionsControlProps extends ControlProps {
  readonly source: OptionsSource;
  /** Single choice (a `select` field without multiple choices) or several. */
  readonly multiple: boolean;
}

const POPOVER_WIDTH = 288;

/**
 * Values of a `select` / `user` / `text` filter: a button that says what
 * is picked ("All", one name, "3 selected") opening a list of check boxes
 * with a search box. The list is drawn over the page (a portal: widget
 * cards clip their content), focus moves into it and back on Escape.
 */
export function OptionsControl({
  label,
  value,
  onChange,
  testId,
  inline = false,
  hideLabel,
  source,
  multiple,
}: OptionsControlProps) {
  const { t } = useTranslation('dashboard');
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const picked = value !== null && 'values' in value ? value.values : [];
  // Names of the values listed now, and of those picked (kept while a search hides them).
  const [pickedNames, setPickedNames] = useState<Readonly<Record<string, string>>>({});
  const listed = useMemo(
    () =>
      new Map(
        source.items.flatMap((item) =>
          item.value === null ? [] : [[String(item.value), item.label ?? String(item.value)]],
        ),
      ),
    [source.items],
  );
  const nameOf = (picked: string | number | boolean) =>
    listed.get(String(picked)) ?? pickedNames[String(picked)] ?? String(picked);
  const summary =
    picked.length === 0
      ? t('filters.any')
      : picked.length === 1
        ? nameOf(picked[0] ?? '')
        : t('filters.selected', { count: picked.length });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
      setPlace({ top: rect.bottom + 4, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    searchBox.current?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) === true || button.current?.contains(target) === true) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const toggle = (item: string | number | boolean) => {
    const has = picked.some((value) => value === item);
    const name = listed.get(String(item));
    if (!has && name !== undefined) {
      setPickedNames((current) => ({ ...current, [String(item)]: name }));
    }
    const next = multiple
      ? has
        ? picked.filter((value) => value !== item)
        : [...picked, item]
      : has
        ? []
        : [item];
    onChange(next.length === 0 ? null : { values: next });
    if (!multiple) close(true);
  };

  const listId = `${id}-list`;
  return (
    <ControlGroup
      label={label}
      labelId={`${id}-label`}
      inline={inline}
      hideLabel={hideLabel}
      testId={testId}
    >
      <Button
        ref={button}
        variant="secondary"
        className={cn('justify-between font-normal', inline ? 'max-w-56 min-w-36' : 'w-full')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        aria-labelledby={`${id}-label ${id}-value`}
        data-testid={testId === undefined ? undefined : `${testId}-button`}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span id={`${id}-value`} className="truncate">
          {summary}
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>
      {open && place !== null
        ? createPortal(
            <div
              ref={panel}
              id={`${id}-panel`}
              role="dialog"
              aria-labelledby={`${id}-label`}
              data-testid={testId === undefined ? undefined : `${testId}-panel`}
              className="fixed z-[70] flex max-h-80 w-72 flex-col gap-2 rounded-lg border border-line bg-surface p-2 text-fg shadow-popover"
              style={{ top: place.top, left: place.left }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  close(true);
                }
              }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next === null) return;
                if (panel.current?.contains(next) === true || button.current === next) return;
                setOpen(false);
              }}
            >
              <Input
                ref={searchBox}
                type="search"
                aria-label={t('filters.search', { label })}
                aria-controls={listId}
                placeholder={t('filters.searchPlaceholder')}
                maxLength={100}
                value={source.search}
                onChange={(event) => {
                  source.onSearch(event.target.value);
                }}
              />
              <div
                className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                aria-busy={source.loading}
              >
                {source.loading && source.items.length === 0 ? (
                  <p className="flex items-center gap-2 p-2 text-label text-fg-muted" role="status">
                    <Spinner aria-hidden="true" />
                    {t('filters.loadingOptions')}
                  </p>
                ) : source.failed ? (
                  <p className="p-2 text-label text-danger" role="alert">
                    {t('filters.optionsFailed')}
                  </p>
                ) : source.items.length === 0 ? (
                  <p className="p-2 text-label text-fg-muted">{t('filters.noOptions')}</p>
                ) : (
                  <ul id={listId} className="flex flex-col" aria-label={label}>
                    {source.items.map((item) => {
                      if (item.value === null) return null;
                      const itemValue = item.value;
                      const checked = picked.some((value) => value === itemValue);
                      return (
                        <li key={String(itemValue)}>
                          <label className="flex min-h-control cursor-pointer items-center gap-2 rounded-md px-2 text-body hover:bg-surface-sunken">
                            <input
                              type={multiple ? 'checkbox' : 'radio'}
                              name={multiple ? undefined : `${id}-choice`}
                              className="size-4 shrink-0 accent-accent"
                              checked={checked}
                              onChange={() => {
                                toggle(itemValue);
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {item.label ?? String(itemValue)}
                            </span>
                            {checked ? (
                              <Check aria-hidden="true" className="size-4 shrink-0 text-accent" />
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {source.hasMore ? (
                  <p className="p-2 text-label text-fg-muted">{t('filters.moreOptions')}</p>
                ) : null}
              </div>
              {picked.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start max-lg:h-control"
                  onClick={() => {
                    onChange(null);
                    close(true);
                  }}
                >
                  <X aria-hidden="true" />
                  {t('filters.clearControl')}
                </Button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </ControlGroup>
  );
}
