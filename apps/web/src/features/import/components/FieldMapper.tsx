/*! Lucian UX/UI Prompt #130 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#130 */
import '../../../styles/lucian.css';
import './FieldMapper.css';

import { foldText } from '@cellhive/filter-dsl';
import { buttonVariants, cn, Input } from '@cellhive/ui';
import { ArrowRight, Check, ChevronDown, CircleAlert, CircleSlash } from 'lucide-react';
import {
  createElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { typeIconOf } from '../../../lib/schema/field-icons';

/**
 * Lucian UX/UI #130 "CSV field mapper" (element a0a6df398c, catalog
 * 34c4b3e61d) for the column step of the import wizard (FRONTEND §4.4,
 * §9.3 "Lucian UX/UI"): one row per column of the file — its name and sample
 * values, an arrow, and what it becomes — and one warning line under the
 * rows. The pattern's script (open a list under the target button, pick,
 * close, give the focus back, nudge the arrow 4 px for 220 ms) runs here as
 * React state; the mapping itself stays in `mapping.ts`.
 */

/** More choices than this and the list gets a search box (a table may have 500 fields). */
export const SEARCH_THRESHOLD = 8;

/** Phones: rows stack and the arrow points down (FieldMapper.css). */
const STACKED = '(max-width: 639.98px)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** Tallest list, and the gap to the button and the window edge (4 px grid). */
const LIST_MAX_HEIGHT = 320;
const LIST_MIN_WIDTH = 240;
const GAP = 4;
const EDGE = 8;

function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * The pattern's `motion()`: the arrow gives way 4 px and comes back in
 * 220 ms (its own duration; the curve is `--ux-ease`, Cellhive's ease-out).
 * Not with reduced motion. `element.animate` is allowed by the CSP.
 */
export function nudgeArrow(node: HTMLElement | null): void {
  if (node === null || typeof node.animate !== 'function' || matches(REDUCED_MOTION)) return;
  const easing =
    window.getComputedStyle(node).getPropertyValue('--ux-ease').trim() ||
    'cubic-bezier(.2,.8,.2,1)';
  const away = matches(STACKED) ? 'translateY(-4px)' : 'translateX(-4px)';
  node.animate([{ transform: away }, { transform: 'none' }], { duration: 220, easing });
}

// --- The mapper and its rows ------------------------------------------------

export interface FieldMapperProps {
  /** Accessible name of the scrolling list of rows. */
  readonly label: string;
  /** The one-line warning under the rows (`role=status`), `null` when all is well. */
  readonly warning: string | null;
  readonly children: ReactNode;
}

export function FieldMapper({ label, warning, children }: FieldMapperProps) {
  return (
    <div className="ux u130" data-testid="field-mapper">
      <div className="scroll" role="region" aria-label={label} tabIndex={0}>
        <ul className="list">{children}</ul>
      </div>
      {/* Always in the page, so a new warning is announced. */}
      <p className="error" role="status" data-testid="field-mapper-warning">
        {warning === null ? null : (
          <>
            <CircleAlert aria-hidden="true" />
            {warning}
          </>
        )}
      </p>
    </div>
  );
}

export type FieldMapperRowState = 'mapped' | 'skipped' | 'invalid';

export interface FieldMapperRowProps {
  /** Column name in the file. */
  readonly name: string;
  /** A few values of the column, already formatted; `[]` when its first rows are empty. */
  readonly samples: readonly string[];
  /** Before the name (the "import this column" check box of a new table). */
  readonly leading?: ReactNode;
  /** After the name ("Primary field"). */
  readonly badge?: ReactNode;
  readonly state: FieldMapperRowState;
  /** Changes when the target changes: the arrow nudges. */
  readonly target: string;
  readonly children: ReactNode;
}

export function FieldMapperRow({
  name,
  samples,
  leading,
  badge,
  state,
  target,
  children,
}: FieldMapperRowProps) {
  const { t } = useTranslation('import');
  const arrow = useRef<HTMLSpanElement>(null);
  const shown = useRef(target);
  useEffect(() => {
    if (shown.current === target) return;
    shown.current = target;
    nudgeArrow(arrow.current);
  }, [target]);
  const sampleText = samples.join(' · ');
  return (
    <li className="map" data-state={state} data-testid="import-column-row">
      <div className="source">
        {leading}
        <div className="source-text">
          <div className="source-name">
            <span title={name}>{name}</span>
            {badge}
          </div>
          {samples.length === 0 ? (
            <small data-empty="">{t('mapping.noSample')}</small>
          ) : (
            <small title={sampleText}>
              <span className="sr-only">{t('mapping.samples')} </span>
              {sampleText}
            </small>
          )}
        </div>
      </div>
      <span ref={arrow} className="link" aria-hidden="true">
        <ArrowRight />
      </span>
      <div className="target">{children}</div>
    </li>
  );
}

// --- The target: a combobox of fields ----------------------------------------

export interface TargetOption {
  readonly id: string;
  /** Text of the option (and of the button once chosen). */
  readonly label: string;
  /** Field type, for its icon. */
  readonly type: string;
  /** Listed with its reason, never chosen (files, T419). */
  readonly disabled?: boolean;
}

export interface TargetGroup {
  readonly key: string;
  /** Heading of the group; the first group has none. */
  readonly label?: string;
  readonly options: readonly TargetOption[];
}

export interface TargetComboboxProps {
  /** Accessible name ("Field for column …"). */
  readonly label: string;
  /** Chosen field, `null`: not imported. */
  readonly value: string | null;
  readonly skipLabel: string;
  readonly groups: readonly TargetGroup[];
  readonly onChange: (value: string | null) => void;
  readonly invalid?: boolean;
  /** Id of the status line under the button. */
  readonly describedBy?: string;
}

interface Entry {
  readonly key: string;
  readonly id: string | null;
  readonly label: string;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly group: string;
}

const SKIP_KEY = '__skip';

function entriesOf(skipLabel: string, groups: readonly TargetGroup[]): Entry[] {
  return [
    { key: SKIP_KEY, id: null, label: skipLabel, type: null, disabled: false, group: '' },
    ...groups.flatMap((group) =>
      group.options.map((option) => ({
        key: option.id,
        id: option.id,
        label: option.label,
        type: option.type,
        disabled: option.disabled === true,
        group: group.key,
      })),
    ),
  ];
}

/** Choices whose text contains `text` (accents and case ignored); "Not imported" always. */
function filterEntries(entries: readonly Entry[], text: string): readonly Entry[] {
  const needle = foldText(text.trim());
  if (needle === '') return entries;
  return entries.filter((entry) => entry.id === null || foldText(entry.label).includes(needle));
}

/** Where a search starts: the first field it finds (-1: none); "Not imported" without one. */
function firstMatch(entries: readonly Entry[], text: string): number {
  if (text.trim() === '') return 0;
  return filterEntries(entries, text).findIndex((entry) => entry.id !== null && !entry.disabled);
}

function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

type CloseReason = 'select' | 'escape' | 'away';

/** The icon of a field's type; "Not imported" has a crossed circle. */
function TargetIcon({ type }: { type: string | null }) {
  return createElement(type === null ? CircleSlash : typeIconOf(type), { 'aria-hidden': true });
}

/**
 * The target button of a row and its list (the pattern's `[data-col]` and
 * `.choices`), as a WAI-ARIA combobox: the button holds the focus and
 * `aria-activedescendant` while the list is open; with more than
 * {@link SEARCH_THRESHOLD} choices the focus moves to a search box above the
 * list (accents and case ignored). ↑/↓, Home/End, letters (typeahead),
 * Enter/Space to pick, Escape to close, Tab to leave without a change.
 * "Not imported" is always the first choice; disabled choices are listed
 * and skipped. `@cellhive/ui` has no combobox, and its Radix menu would
 * portal behind the modal wizard (FRONTEND §10.5): the list is inline,
 * fixed to the viewport so the scrolling rows cannot cut it off.
 */
export function TargetCombobox({
  label,
  value,
  skipLabel,
  groups,
  onChange,
  invalid = false,
  describedBy,
}: TargetComboboxProps) {
  const { t } = useTranslation('import');
  const id = useId();
  const listId = `${id}-list`;
  const trigger = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', timer: 0 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [side, setSide] = useState<'top' | 'bottom'>('bottom');

  const entries = useMemo(() => entriesOf(skipLabel, groups), [skipLabel, groups]);
  const searchable = entries.length - 1 > SEARCH_THRESHOLD;
  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);
  const current = entries.find((entry) => entry.id === value) ?? entries[0];
  const optionId = (index: number) => `${id}-option-${String(index)}`;

  const close = (reason: CloseReason) => {
    setOpen(false);
    setQuery('');
    setActive(-1);
    if (reason !== 'away') trigger.current?.focus();
  };

  const show = (initialQuery = '') => {
    setQuery(initialQuery);
    const index = entries.findIndex((entry) => entry.id === value);
    setActive(initialQuery === '' ? Math.max(0, index) : firstMatch(entries, initialQuery));
    setSide('bottom');
    setOpen(true);
  };

  const choose = (entry: Entry | undefined) => {
    if (entry === undefined || entry.disabled) return;
    close('select');
    if (entry.id !== value) onChange(entry.id);
  };

  /** Next enabled option from `from` in `step` direction; stays put at the ends. */
  const step = (from: number, delta: 1 | -1): number => {
    for (let index = from + delta; index >= 0 && index < visible.length; index += delta) {
      if (visible[index]?.disabled === false) return index;
    }
    return from;
  };
  const edge = (last: boolean): number => {
    const indexes = visible.map((_, index) => index).filter((i) => !visible[i]?.disabled);
    return (last ? indexes.at(-1) : indexes[0]) ?? -1;
  };

  /** Typeahead of the list without search: letters typed within 500 ms. */
  const typeahead = (key: string) => {
    window.clearTimeout(typed.current.timer);
    typed.current.text += key;
    typed.current.timer = window.setTimeout(() => {
      typed.current.text = '';
    }, 500);
    const needle = foldText(typed.current.text);
    const start = typed.current.text.length === 1 ? active + 1 : Math.max(active, 0);
    const order = [...visible.keys()].map((offset) => (start + offset) % visible.length);
    const found = order.find(
      (index) =>
        visible[index]?.disabled === false && foldText(visible[index].label).startsWith(needle),
    );
    if (found !== undefined) setActive(found);
  };

  /** Keys of the open list, from the button (no search) or the search box. */
  const onListKey = (event: KeyboardEvent, fromSearch: boolean): boolean => {
    // Any key but a letter starts a new typeahead.
    if (!isPrintable(event)) typed.current.text = '';
    switch (event.key) {
      case 'ArrowDown':
        setActive(active < 0 ? edge(false) : step(active, 1));
        return true;
      case 'ArrowUp':
        setActive(active < 0 ? edge(true) : step(active, -1));
        return true;
      case 'Home':
      case 'End':
        // In the search box they move the caret.
        if (fromSearch) return false;
        setActive(edge(event.key === 'End'));
        return true;
      case 'Enter':
        choose(visible[active]);
        return true;
      case ' ':
        if (fromSearch) return false;
        choose(visible[active]);
        return true;
      case 'Escape':
        event.stopPropagation();
        close('escape');
        return true;
      case 'Tab':
        // Back from the search box: to the button, list closed.
        if (fromSearch && event.shiftKey) {
          close('escape');
          return true;
        }
        // Onwards: the search box's blur closes the list once the focus has moved.
        if (!fromSearch) close('away');
        return false;
      default:
        return false;
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        show();
      } else if (isPrintable(event)) {
        event.preventDefault();
        if (searchable) show(event.key);
        else {
          show();
          typeahead(event.key);
        }
      }
      return;
    }
    if (onListKey(event, false)) event.preventDefault();
    else if (isPrintable(event)) {
      event.preventDefault();
      typeahead(event.key);
    }
  };

  // Open: the search box takes the focus; the list is placed under (or over) the button.
  useEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const place = () => {
      const button = trigger.current;
      const list = popup.current;
      if (button === null || list === null) return;
      const rect = button.getBoundingClientRect();
      // Scrolled out of its region: the list goes with it.
      const region = button.closest('.scroll')?.getBoundingClientRect();
      if (region !== undefined && (rect.bottom < region.top || rect.top > region.bottom)) {
        close('away');
        return;
      }
      const height = window.visualViewport?.height ?? window.innerHeight;
      const below = height - rect.bottom - GAP - EDGE;
      const above = rect.top - GAP - EDGE;
      list.style.maxHeight = '';
      const natural = Math.min(list.scrollHeight, LIST_MAX_HEIGHT);
      const under = natural <= below || below >= above;
      const width = Math.max(rect.width, LIST_MIN_WIDTH);
      const left = Math.min(Math.max(rect.left, EDGE), window.innerWidth - width - EDGE);
      list.style.width = `${String(width)}px`;
      list.style.left = `${String(Math.max(EDGE, left))}px`;
      list.style.maxHeight = `${String(Math.max(120, Math.min(LIST_MAX_HEIGHT, under ? below : above)))}px`;
      list.style.top = under ? `${String(rect.bottom + GAP)}px` : '';
      list.style.bottom = under ? '' : `${String(height - rect.top + GAP)}px`;
      setSide(under ? 'bottom' : 'top');
    };
    place();
    const later = (event: Event) => {
      // The list's own scrolling moves nothing.
      if (event.target instanceof Node && popup.current?.contains(event.target) === true) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target) === true || popup.current?.contains(target) === true)
        return;
      close('away');
    };
    document.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  // The active option stays in view.
  useEffect(() => {
    if (!open || active < 0) return;
    const option = document.getElementById(optionId(active));
    // jsdom has no scrollIntoView.
    if (option !== null && 'scrollIntoView' in option) option.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  useEffect(() => {
    const state = typed.current;
    return () => {
      window.clearTimeout(state.timer);
    };
  }, []);

  const activeId = open && active >= 0 && active < visible.length ? optionId(active) : undefined;

  const renderOption = (entry: Entry, index: number) => {
    const chosen = entry.id === value;
    return (
      <div
        key={entry.key}
        id={optionId(index)}
        role="option"
        aria-selected={index === active}
        aria-disabled={entry.disabled ? true : undefined}
        data-current={chosen ? '' : undefined}
        onMouseDown={(event) => {
          // The focus stays on the button or in the search box.
          event.preventDefault();
        }}
        onPointerMove={() => {
          if (!entry.disabled && index !== active) setActive(index);
        }}
        onClick={() => {
          choose(entry);
        }}
      >
        <TargetIcon type={entry.type} />
        <span>{entry.label}</span>
        {chosen ? <Check aria-hidden="true" className="check" /> : null}
      </div>
    );
  };

  const firstGroup = visible.filter((entry) => entry.group === groups[0]?.key || entry.id === null);
  const laterGroups = groups.slice(1).map((group) => ({
    group,
    entries: visible.filter((entry) => entry.group === group.key),
  }));
  const indexOf = new Map(visible.map((entry, index) => [entry.key, index]));
  const noMatch = query.trim() !== '' && visible.every((entry) => entry.id === null);

  return (
    <div className="field">
      <div
        ref={trigger}
        role="combobox"
        tabIndex={0}
        data-col=""
        data-empty={value === null ? '' : undefined}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={searchable ? undefined : activeId}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className={cn(buttonVariants({ variant: 'secondary' }), 'w-full')}
        onClick={() => {
          if (open) close('select');
          else show();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="value">
          <TargetIcon type={current?.type ?? null} />
          <span>{current?.label}</span>
        </span>
        <ChevronDown aria-hidden="true" className="chevron" />
      </div>
      {open ? (
        <div ref={popup} className="choices animate-pop-in" data-side={side}>
          {searchable ? (
            <div className="search">
              <Input
                ref={search}
                role="combobox"
                aria-label={t('mapping.searchFields')}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeId}
                autoComplete="off"
                placeholder={t('mapping.searchFields')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(firstMatch(entries, event.target.value));
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (onListKey(event, true)) event.preventDefault();
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && trigger.current?.contains(next) === true) return;
                  if (next instanceof Node && popup.current?.contains(next) === true) return;
                  close('away');
                }}
              />
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label={label}>
            {firstGroup.map((entry) => renderOption(entry, indexOf.get(entry.key) ?? 0))}
            {noMatch ? (
              <div role="presentation" className="empty">
                {t('mapping.noFieldMatch')}
              </div>
            ) : null}
            {laterGroups.map(({ group, entries: inGroup }) =>
              inGroup.length === 0 ? null : (
                <div key={group.key} role="group" aria-label={group.label}>
                  <div className="group-label" aria-hidden="true">
                    {group.label}
                  </div>
                  {inGroup.map((entry) => renderOption(entry, indexOf.get(entry.key) ?? 0))}
                </div>
              ),
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
