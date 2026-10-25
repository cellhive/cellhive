import { Button, cn, Input, Spinner } from '@cellhive/ui';
import { Check, X } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { itemsOf, type InputItem, type InputValue } from '../model/values';

import type { ControlProps } from './QuestionInput';
import type { FormLinkOption, FormLinkSource } from '../../../lib/forms/renderer';

/** Wait after the last key before searching. */
const SEARCH_DELAY_MS = 250;

interface Page {
  readonly items: readonly FormLinkOption[];
  readonly hasMore: boolean;
}

type Load =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly page: Page | null }
  | { readonly kind: 'ready'; readonly page: Page }
  | { readonly kind: 'error' };

export interface LinkQuestionProps {
  readonly fieldId: string;
  readonly multiple: boolean;
  readonly value: InputValue;
  readonly onChange: (value: InputValue) => void;
  readonly control: ControlProps;
  readonly labelId: string;
  readonly source: FormLinkSource;
}

/**
 * The input of a link question (T410, BACKLOG S4 open question #4): the
 * picked records as chips, a search combobox (ARIA 1.2, T421a) and the
 * records the source offers (members see what the link picker of T402
 * offers them, with its display values; `org` form links `{ id, title }`
 * of what the link's creator reads). One record replaces the pick; several
 * toggle.
 */
export function LinkQuestion({
  fieldId,
  multiple,
  value,
  onChange,
  control,
  labelId,
  source,
}: LinkQuestionProps) {
  const { t } = useTranslation('form');
  const listId = useId();
  const picked = itemsOf(value);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [more, setMore] = useState(0);
  // The active option (`aria-activedescendant`); none until the user moves or searches.
  const [active, setActive] = useState(-1);
  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  // Loading states are set by the events that start a load (typing, opening, "Show more");
  // the effect only fetches.
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const offset = more;
    const timer = setTimeout(
      () => {
        source
          .search(fieldId, { search: search.trim(), offset }, controller.signal)
          .then((page) => {
            setLoad((current) => {
              const before = offset > 0 && current.kind === 'loading' ? current.page : null;
              return {
                kind: 'ready',
                page: {
                  items: [...(before?.items ?? []), ...page.items],
                  hasMore: page.hasMore,
                },
              };
            });
          })
          .catch(() => {
            if (!controller.signal.aborted) setLoad({ kind: 'error' });
          });
      },
      offset > 0 ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, more, fieldId, source]);

  const nameOf = (item: { readonly name?: string | null; readonly title?: string | null }) =>
    (item.name ?? item.title ?? '').trim() || t('fill.link.noTitle');
  const isPicked = (id: string) => picked.some((item) => item.id === id);
  const pick = (option: FormLinkOption) => {
    const item: InputItem = { id: option.id, name: option.title };
    if (!multiple) {
      onChange([item]);
      close();
      return;
    }
    onChange(
      isPicked(option.id) ? picked.filter((entry) => entry.id !== option.id) : [...picked, item],
    );
  };

  const page = load.kind === 'ready' ? load.page : load.kind === 'loading' ? load.page : null;
  const options = page?.items ?? [];
  const activeOption = open && load.kind === 'ready' && active >= 0 ? options[active] : undefined;
  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  const activeId = activeOption === undefined ? undefined : optionId(active);
  useEffect(() => {
    if (activeId === undefined) return;
    const element = document.getElementById(activeId) as Partial<
      Pick<HTMLElement, 'scrollIntoView'>
    > | null;
    // Not in every environment (jsdom).
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const start = () => {
    if (open) return;
    setLoad({ kind: 'loading', page: null });
    setActive(-1);
    setOpen(true);
  };
  const move = (step: 1 | -1) => {
    if (!open) {
      start();
      return;
    }
    if (options.length === 0) return;
    setActive((current) =>
      current < 0
        ? step === 1
          ? 0
          : options.length - 1
        : Math.max(0, Math.min(options.length - 1, current + step)),
    );
  };

  /**
   * The combobox keys (ARIA 1.2 APG "list autocomplete"): ↓/↑ open the list
   * and move the active option, Enter picks it (and never submits the form,
   * T421a), Escape closes the list; Alt+↑ closes too.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (event.altKey) start();
        else move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) close();
        else move(-1);
        return;
      case 'Enter':
        // Inside the question Enter only picks: the form is sent with its button.
        event.preventDefault();
        if (activeOption !== undefined) pick(activeOption);
        return;
      case 'Escape':
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      default:
    }
  };

  return (
    <div
      id={control.id}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={control.describedBy}
      data-testid="form-link-question"
      className="flex flex-col gap-2"
      onBlur={(event) => {
        // The list closes when the focus leaves the question.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        close();
      }}
    >
      {picked.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('fill.link.picked')}>
          {picked.map((item) => (
            <li
              key={item.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-soft py-0.5 pr-0.5 pl-2 text-body"
            >
              <span className="truncate">{nameOf(item)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 sm:size-6"
                disabled={control.disabled}
                aria-label={t('fill.link.remove', { name: nameOf(item) })}
                onClick={() => {
                  onChange(picked.filter((entry) => entry.id !== item.id));
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Input
        type="text"
        role="combobox"
        value={search}
        disabled={control.disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={control.invalid}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={t('fill.link.search')}
        placeholder={t(multiple ? 'fill.link.placeholderMany' : 'fill.link.placeholderOne')}
        onFocus={start}
        onClick={start}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setSearch(event.target.value);
          setMore(0);
          setLoad({ kind: 'loading', page: null });
          // A search makes its first result active (typing it is the choice).
          setActive(event.target.value.trim() === '' ? -1 : 0);
          setOpen(true);
        }}
      />
      <div
        className={cn(
          'max-h-64 overflow-y-auto rounded-md border border-line bg-surface p-1',
          !open && 'hidden',
        )}
      >
        <ul
          id={listId}
          role="listbox"
          aria-label={t('fill.link.options')}
          aria-multiselectable={multiple || undefined}
          data-testid="form-link-options"
          className="flex flex-col"
        >
          {open
            ? options.map((option, index) => {
                const selected = isPicked(option.id);
                const details = (option.details ?? []).filter((text) => text !== '');
                return (
                  <li
                    key={option.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={control.disabled || undefined}
                    className={cn(
                      'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-body sm:min-h-8',
                      'hover:bg-surface-sunken',
                      index === active && activeOption !== undefined && 'bg-accent-soft',
                      selected && 'font-medium',
                    )}
                    // The focus stays in the search box.
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseMove={() => {
                      if (index !== active) setActive(index);
                    }}
                    onClick={() => {
                      if (control.disabled) return;
                      setActive(index);
                      pick(option);
                    }}
                  >
                    <Check
                      aria-hidden="true"
                      className={cn('size-4 shrink-0 text-accent', !selected && 'invisible')}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{nameOf(option)}</span>
                      {details.length === 0 ? null : (
                        <span className="truncate text-label font-normal text-fg-muted">
                          {details.join(' · ')}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })
            : null}
        </ul>
        {!open ? null : load.kind === 'error' ? (
          <p role="alert" className="px-2 py-1.5 text-label font-normal text-danger">
            {t('fill.link.error')}
          </p>
        ) : page === null ? (
          <p role="status" className="flex items-center gap-2 px-2 py-1.5 text-fg-muted">
            <Spinner /> {t('fill.link.loading')}
          </p>
        ) : page.items.length === 0 ? (
          <p role="status" className="px-2 py-1.5 text-fg-muted">
            {t('fill.link.empty')}
          </p>
        ) : null}
        {open && page?.hasMore === true ? (
          <Button
            variant="link"
            className="px-2 py-1.5"
            disabled={load.kind === 'loading'}
            onClick={() => {
              setLoad({ kind: 'loading', page });
              setMore(page.items.length);
            }}
          >
            {t('fill.link.more')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
