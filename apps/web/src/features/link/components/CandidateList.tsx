import { cn } from '@cellhive/ui';
import { useEffect, type KeyboardEvent, type ReactNode } from 'react';

import * as model from '../model/selection';

import { CandidateRow, EmptyResults, LimitBanner, LoadError, LoadingRows } from './parts';

import type { PickerState } from '../use-picker';

/** Distance from the end of the list at which the next page loads. */
const LOAD_AHEAD_PX = 240;

export interface CandidateListProps {
  readonly state: PickerState;
  readonly size: 'popover' | 'dialog' | 'sheet';
  readonly label: string;
  /** The list takes the keyboard focus (dialog, sheet); the popover keeps it in the search box. */
  readonly focusable: boolean;
  /** Shown when nothing matches (e.g. the create button). */
  readonly emptyAction?: ReactNode;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /**
   * Above the list, outside the listbox (a button may not sit among the
   * options): the results heading and "select all". When given, a single
   * section's heading is not repeated inside the list.
   */
  readonly header?: ReactNode;
  readonly className?: string;
}

/**
 * The records of the picker (`role="listbox"`, `aria-multiselectable` for
 * several records): sections ("Recent", results), the next page loaded
 * when the list scrolls near its end, the loading / empty / error states of
 * the board (outside the listbox, which holds options only), and the limit
 * banner when the cell is full.
 */
export function CandidateList(props: CandidateListProps) {
  const { state } = props;
  const { t, main } = state;
  const activeId = state.activeOption?.id;

  useEffect(() => {
    if (activeId === undefined) return;
    const element = document.getElementById(activeId) as Partial<
      Pick<HTMLElement, 'scrollIntoView'>
    > | null;
    // Not in every environment (jsdom).
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  // The keyboard reached the last loaded records: the next page comes.
  const nearEnd = state.active >= 0 && state.active >= state.options.length - 3;
  const { loadMore } = main;
  useEffect(() => {
    if (nearEnd) loadMore();
  }, [nearEnd, loadMore]);

  const full = model.isFull(state.selection) && state.multiple;
  const empty = main.status === 'success' && state.options.length === 0;
  const loading = main.status === 'pending' && state.options.length === 0;
  const sheet = props.size === 'sheet';

  let status: ReactNode = null;
  if (main.status === 'error' && state.options.length === 0) {
    status = <LoadError detail={state.errorText} onRetry={main.retry} />;
  } else if (loading) {
    status = <LoadingRows multiple={state.multiple} label={t('picker.loading')} />;
  } else if (empty) {
    status =
      state.scope === 'selected' ? (
        <EmptyResults title={t('picker.emptySelected')} />
      ) : state.searching === '' ? (
        <EmptyResults
          title={t('picker.empty', { table: state.tableName })}
          action={props.emptyAction}
        />
      ) : (
        <EmptyResults
          title={t('picker.emptySearch', { table: state.tableName, search: state.searching })}
          hint={state.hasFilter ? t('picker.emptyFiltered', { table: state.tableName }) : undefined}
          action={props.emptyAction}
        />
      );
  }

  const repeatHeading = !(props.header !== undefined && state.sections.length === 1);

  return (
    <>
      {props.header}
      {full || state.blocked ? <LimitBanner limit={state.limit} /> : null}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
          sheet ? '' : 'px-3 py-2',
          props.className,
        )}
        // The search box drives the list (`aria-activedescendant`) and the options take no
        // focus: the box itself scrolls with the keyboard (T421b, axe
        // `scrollable-region-focusable`).
        {...(props.focusable ? {} : { tabIndex: 0, role: 'group', 'aria-label': props.label })}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (element.scrollTop + element.clientHeight >= element.scrollHeight - LOAD_AHEAD_PX) {
            loadMore();
          }
        }}
      >
        <div
          id={state.listId}
          role="listbox"
          aria-label={props.label}
          aria-multiselectable={state.multiple}
          aria-activedescendant={props.focusable ? activeId : undefined}
          aria-busy={main.fetching}
          tabIndex={props.focusable && state.options.length > 0 ? 0 : -1}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onKeyDown={props.onKeyDown}
        >
          {state.sections.map((section, sectionIndex) =>
            section.items.length === 0 ? null : (
              <div
                key={section.key}
                role="group"
                aria-label={section.heading ?? props.label}
                className={cn('flex flex-col', sheet ? '' : 'gap-0.5')}
              >
                {section.heading === null || !repeatHeading ? null : (
                  <div
                    aria-hidden="true"
                    className={cn(
                      'truncate pb-1.5 text-label text-fg-muted',
                      sheet ? 'px-4' : 'px-3',
                      sectionIndex > 0 ? 'pt-3' : 'pt-1',
                    )}
                  >
                    {section.heading}
                  </div>
                )}
                {section.items.map((candidate) => {
                  const index = state.options.findIndex(
                    (option) =>
                      option.section === section.key && option.candidate.id === candidate.id,
                  );
                  const option = state.options[index];
                  if (option === undefined) return null;
                  return (
                    <CandidateRow
                      key={option.id}
                      id={option.id}
                      title={candidate.title}
                      search={state.searching}
                      values={option.values}
                      selected={model.isSelected(state.selection, candidate.id)}
                      multiple={state.multiple}
                      active={index === state.active}
                      disabledReason={option.disabledReason}
                      dimmed={full}
                      size={props.size}
                      onChoose={() => {
                        state.setActive(index);
                        state.choose(option);
                      }}
                      onPointerActive={() => {
                        if (index !== state.active) state.setActive(index);
                      }}
                    />
                  );
                })}
              </div>
            ),
          )}
        </div>
        {status}
        {main.loadingMore ? (
          <LoadingRows multiple={state.multiple} label={t('picker.loadingMore')} />
        ) : null}
      </div>
    </>
  );
}

/**
 * Keys of the list and the search box (FRONTEND §6.2, board footers): ↑/↓
 * move, Home/End, Enter (and Space in the list) chooses; returns whether
 * the key was used. `onEdge` = ↑ on the first record (back to the search).
 */
export function handleListKey(
  event: KeyboardEvent,
  state: PickerState,
  options: { readonly space: boolean; readonly onEdge?: () => void },
): boolean {
  if (event.nativeEvent.isComposing) return false;
  const count = state.options.length;
  const move = (index: number) => {
    event.preventDefault();
    event.stopPropagation();
    state.setActive(Math.max(0, Math.min(count - 1, index)));
  };
  switch (event.key) {
    case 'ArrowDown':
      if (count === 0) return false;
      move(state.active < 0 ? 0 : state.active + 1);
      return true;
    case 'ArrowUp':
      if (count === 0) return false;
      if (state.active <= 0 && options.onEdge !== undefined) {
        event.preventDefault();
        options.onEdge();
        return true;
      }
      move(state.active - 1);
      return true;
    case 'Home':
      if (!options.space) return false;
      move(0);
      return true;
    case 'End':
      if (!options.space) return false;
      move(count - 1);
      return true;
    case 'Enter':
    case ' ': {
      if (event.key === ' ' && !options.space) return false;
      if (event.ctrlKey || event.metaKey) return false;
      const option = state.activeOption;
      if (option === undefined) return false;
      event.preventDefault();
      event.stopPropagation();
      state.choose(option);
      return true;
    }
    default:
      return false;
  }
}
