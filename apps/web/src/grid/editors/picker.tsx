import { cn } from '@cellhive/ui';
import { Check, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { CELL_INPUT_CLASS, EditorFrame, handleEditorKey } from './shell';

import type { EditorMove } from './types';
import type { ReactNode } from 'react';

export interface PickerItem {
  readonly key: string;
  /** Text of the item (option name, member name) or of the text to create. */
  readonly label: string;
  readonly kind: 'choice' | 'create';
  readonly selected: boolean;
  /** Drawn in place of the label (chip, avatar + name). */
  readonly content?: ReactNode;
}

export interface PickerChip {
  readonly key: string;
  readonly label: string;
  readonly content: ReactNode;
}

export interface PickerProps {
  /** Accessible name of the search box (the field name). */
  readonly label: string;
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly items: readonly PickerItem[];
  readonly active: number;
  readonly onActive: (index: number) => void;
  readonly onChoose: (item: PickerItem) => void;
  /** Chosen values shown above the search box (multiple values). */
  readonly chips: readonly PickerChip[];
  readonly onRemoveChip: (key: string) => void;
  readonly multiple: boolean;
  readonly cellHeight: number;
  readonly cellWidth: number;
  readonly error: string | null;
  readonly errorId: string;
  /** Shown instead of the list: loading, nothing found… */
  readonly status: string | null;
  /** Enter without an active item, Tab: write the chosen values. */
  readonly onCommit: (move: EditorMove) => void;
  readonly onCancel: () => void;
  /** Backspace in an empty search box: drop the last chosen value. */
  readonly onBackspace: () => void;
}

/**
 * Searchable list of the select and user editors: a combobox on top of a
 * listbox (WAI-ARIA combobox pattern, focus stays in the search box). Arrow
 * keys move through the items, Enter picks the active one (and, for one
 * value, writes it), Tab writes, Escape cancels.
 */
export function Picker(props: PickerProps) {
  const { t } = useTranslation('grid');
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { items, active, onActive } = props;

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${listId}-${String(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  const optionId = (index: number) => `${listId}-${String(index)}`;

  return (
    <EditorFrame
      cellWidth={props.cellWidth}
      cellHeight={props.cellHeight}
      error={props.error}
      errorId={props.errorId}
      className="w-72 max-w-[min(24rem,calc(100vw-2rem))]"
    >
      <div
        className={cn(
          'flex min-w-0 shrink-0 flex-wrap items-center gap-1 rounded-md bg-surface px-1.5 py-1 ring-2 ring-accent ring-inset',
          props.error !== null && 'ring-danger',
        )}
        style={{ minHeight: props.cellHeight }}
      >
        {props.chips.map((chip) => (
          <span key={chip.key} className="inline-flex max-w-full items-center gap-0.5">
            {chip.content}
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('edit.remove', { value: chip.label })}
              className="rounded-sm p-0.5 text-fg-muted hover:bg-surface-sunken hover:text-fg"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                props.onRemoveChip(chip.key);
              }}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-label={props.label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 && active < items.length ? optionId(active) : undefined
          }
          aria-invalid={props.error !== null}
          aria-describedby={props.error === null ? undefined : props.errorId}
          placeholder={t('edit.search')}
          value={props.search}
          className={cn(CELL_INPUT_CLASS, 'h-6 min-w-16 flex-1 px-1 ring-0')}
          onChange={(event) => {
            props.onSearch(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              if (items.length === 0) return;
              const step = event.key === 'ArrowDown' ? 1 : -1;
              onActive(
                active < 0
                  ? step > 0
                    ? 0
                    : items.length - 1
                  : (active + step + items.length) % items.length,
              );
              return;
            }
            if (event.key === 'Backspace' && props.search === '') {
              event.stopPropagation();
              props.onBackspace();
              return;
            }
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              const item = active >= 0 ? items[active] : undefined;
              if (item !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                props.onChoose(item);
                return;
              }
            }
            handleEditorKey(event, { commit: props.onCommit, cancel: props.onCancel });
          }}
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={props.label}
        aria-multiselectable={props.multiple}
        className="max-h-60 min-h-0 overflow-y-auto border-y border-line py-1"
      >
        {props.status !== null ? (
          <li role="presentation" className="px-3 py-2 text-fg-muted">
            {props.status}
          </li>
        ) : null}
        {items.map((item, index) => (
          <li
            key={item.key}
            id={optionId(index)}
            role="option"
            aria-selected={item.selected}
            className={cn(
              'flex cursor-pointer items-center gap-2 px-2 py-1.5',
              index === active && 'bg-surface-sunken',
            )}
            onMouseDown={(event) => {
              // Keep the focus in the search box.
              event.preventDefault();
            }}
            onMouseMove={() => {
              if (index !== active) onActive(index);
            }}
            onClick={() => {
              props.onChoose(item);
            }}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-accent">
              {item.kind === 'create' ? (
                <Plus aria-hidden="true" className="size-4 text-fg-muted" />
              ) : item.selected ? (
                <Check aria-hidden="true" className="size-4" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {item.kind === 'create'
                ? t('edit.createOption', { name: item.label })
                : (item.content ?? item.label)}
            </span>
          </li>
        ))}
      </ul>
    </EditorFrame>
  );
}

/** A select option as a chip in its color (the name is always written, FRONTEND §9.2). */
export function OptionChip({ name, color }: { name: string; color: number }) {
  const index = ((color % 8) + 8) % 8;
  return (
    <span
      className="inline-block max-w-full truncate rounded-sm px-1.5 text-label leading-5"
      style={{
        backgroundColor: `var(--option-${String(index)}-bg)`,
        color: `var(--option-${String(index)}-fg)`,
      }}
    >
      {name}
    </span>
  );
}
