import { Button, cn, Tooltip } from '@cellhive/ui';
import { Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ViewSearchProps } from '../../../lib/views/toolbar';

/** Typing pauses this long before the rows are searched again. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Ctrl/⌘+F (not with Shift or Alt). */
export function isFindShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'f'
  );
}

/**
 * The search box of a view (T311, SPEC §7.4): unaccented, case-insensitive
 * substring of the primary field, sent after a short pause. Ctrl/⌘+F
 * focuses it instead of the browser's find bar; Escape empties it, then
 * leaves it. Disabled when the user cannot read the primary field (the
 * server refuses such a search: it would reveal the field).
 */
export function ViewSearch({ fields, search, onSearchChange, onLeaveSearch }: ViewSearchProps) {
  const { t } = useTranslation('toolbar');
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [text, setText] = useState(search);
  const [last, setLast] = useState(search);
  if (last !== search) {
    // Changed from outside (another view, a reset): the box follows.
    setLast(search);
    if (text.trim() !== search) setText(search);
  }
  const primary = fields.find((field) => field.is_primary);
  const disabled = primary === undefined;
  // Says what is searched: the primary field (SPEC §7.4).
  const placeholder =
    primary === undefined
      ? t('search.placeholder')
      : t('search.placeholderField', { field: primary.name });

  const latest = useRef(onSearchChange);
  useEffect(() => {
    latest.current = onSearchChange;
  });
  useEffect(() => {
    const value = text.trim();
    if (value === search) return;
    const timer = setTimeout(() => {
      latest.current(value);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, search]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFindShortcut(event) || event.defaultPrevented) return;
      // Dialogs (record panel, field settings) keep the browser's find.
      if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [disabled]);

  const clear = () => {
    setText('');
    onSearchChange('');
  };

  return (
    <div className="relative flex w-full min-w-0 items-center">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2 size-4 text-fg-muted"
      />
      <input
        ref={input}
        type="search"
        role="searchbox"
        aria-label={t('search.label')}
        aria-describedby={disabled ? hintId : undefined}
        placeholder={placeholder}
        title={disabled ? t('search.disabled') : placeholder}
        disabled={disabled}
        value={text}
        maxLength={10_000}
        className={cn(
          'h-control w-full min-w-0 rounded-md border border-line-control bg-surface pr-7 pl-7 text-body text-fg',
          'placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-sunken',
          '[&::-webkit-search-cancel-button]:hidden',
        )}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Now, without waiting for the pause.
            onSearchChange(text.trim());
            return;
          }
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          if (text !== '') {
            clear();
            return;
          }
          input.current?.blur();
          onLeaveSearch?.();
        }}
      />
      {disabled ? (
        <span id={hintId} className="sr-only">
          {t('search.disabled')}
        </span>
      ) : null}
      {text === '' || disabled ? null : (
        <Tooltip content={t('search.clear')}>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-0.5 size-6"
            aria-label={t('search.clear')}
            onClick={() => {
              clear();
              input.current?.focus();
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}
