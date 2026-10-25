import { foldText } from '@cellhive/filter-dsl';
import { cn, Input } from '@cellhive/ui';
import { Braces } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CHIP_TONE_CLASS } from './chips';

import type { PickedValue } from './sections';
import type { ChipTone } from '../../model/scope';

export interface PickerItem {
  readonly key: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly tone: ChipTone;
  /** What choosing it gives (a chip of a template, or a whole value). */
  readonly pick: PickedValue;
}

export interface PickerSection {
  readonly key: string;
  readonly title: string;
  readonly items: readonly PickerItem[];
}

export interface ValuePickerProps {
  readonly sections: readonly PickerSection[];
  readonly onPick: (picked: PickedValue) => void;
  readonly onClose: (reason: 'escape' | 'select' | 'outside') => void;
  /** "Formula expression…" (templates only). */
  readonly onExpression?: (() => void) | undefined;
  readonly label: string;
}

/**
 * The shared "+" menu of values (board "S5 · Automation builder - trigger
 * và điều kiện"): fields of the trigger record, trigger data, outputs of
 * earlier steps, a formula expression. A search box drives a listbox
 * (`aria-activedescendant`): ↑/↓ move, Enter picks, Escape closes; the
 * search ignores accents and case.
 */
export function ValuePicker({ sections, onPick, onClose, onExpression, label }: ValuePickerProps) {
  const { t } = useTranslation('automationBuilder');
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const needle = foldText(query.trim());
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => needle === '' || foldText(`${item.label} ${item.hint ?? ''}`).includes(needle),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [sections, query]);
  const flat = filtered.flatMap((section) => section.items);
  const expressionIndex = onExpression === undefined ? -1 : flat.length;
  const total = flat.length + (onExpression === undefined ? 0 : 1);
  const current = Math.min(active, Math.max(0, total - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (panel.current?.contains(event.target as Node) === true) return;
      onClose('outside');
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose]);
  useEffect(() => {
    const option = panel.current?.querySelector(`[data-index="${String(current)}"]`);
    // jsdom has no scrollIntoView.
    if (option !== null && option !== undefined && 'scrollIntoView' in option) {
      option.scrollIntoView({ block: 'nearest' });
    }
  }, [current]);

  const choose = (index: number) => {
    if (index === expressionIndex) {
      onClose('select');
      onExpression?.();
      return;
    }
    const item = flat[index];
    if (item === undefined) return;
    onClose('select');
    onPick(item.pick);
  };

  const positions = new Map(flat.map((item, position) => [item.key, position]));
  return (
    <div
      ref={panel}
      className="absolute top-full right-0 z-30 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-line bg-surface shadow-popover"
      data-testid="value-picker"
    >
      <div className="p-2">
        <Input
          ref={input}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={total === 0 ? undefined : `${id}-${String(current)}`}
          aria-label={label}
          placeholder={t('picker.search')}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (total === 0) return;
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + total) % total);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(current);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose('escape');
            } else if (event.key === 'Tab') {
              onClose('outside');
            }
          }}
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        className="max-h-72 overflow-y-auto border-t border-line py-1"
      >
        {total === 0 ? (
          <p className="px-3 py-2 text-label font-normal text-fg-muted">{t('picker.empty')}</p>
        ) : null}
        {filtered.map((section) => (
          <div key={section.key} role="group" aria-label={section.title}>
            <div className="px-3 pt-2 pb-1 text-label text-fg-muted" aria-hidden="true">
              {section.title}
            </div>
            {section.items.map((item) => {
              const itemIndex = positions.get(item.key) ?? 0;
              return (
                <div
                  key={item.key}
                  id={`${id}-${String(itemIndex)}`}
                  role="option"
                  aria-selected={itemIndex === current}
                  data-index={itemIndex}
                  className={cn(
                    'flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 text-body max-lg:min-h-control',
                    itemIndex === current && 'bg-accent-soft',
                  )}
                  onPointerMove={() => {
                    setActive(itemIndex);
                  }}
                  onClick={() => {
                    choose(itemIndex);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2.5 shrink-0 rounded-full border',
                      CHIP_TONE_CLASS[item.tone],
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint === undefined ? null : (
                    <span className="shrink-0 text-label font-normal text-fg-muted">
                      {item.hint}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {onExpression === undefined ? null : (
          <div
            id={`${id}-${String(expressionIndex)}`}
            role="option"
            aria-selected={expressionIndex === current}
            data-index={expressionIndex}
            className={cn(
              'mt-1 flex min-h-8 cursor-pointer items-center gap-2 border-t border-line px-3 py-1 text-body max-lg:min-h-control',
              expressionIndex === current && 'bg-accent-soft',
            )}
            onPointerMove={() => {
              setActive(expressionIndex);
            }}
            onClick={() => {
              choose(expressionIndex);
            }}
          >
            <Braces aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
            {t('picker.expression')}
          </div>
        )}
      </div>
    </div>
  );
}
