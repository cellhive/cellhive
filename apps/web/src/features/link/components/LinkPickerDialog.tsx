import { Button, cn, Tooltip } from '@cellhive/ui';
import { Link2, Search, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import * as model from '../model/selection';

import { CandidateList, handleListKey } from './CandidateList';
import { CreateRecordForm } from './CreateRecordForm';
import { CreateButton, FilterNote, KeyHints, modKey } from './parts';
import { SelectedList } from './SelectedList';

import type { LinkPickerProps } from '../../../lib/links/picker';
import type { PickerScope, PickerState } from '../use-picker';

/** Printable keys typed in the list go on in the search box. */
function isTyping(event: KeyboardEvent): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    /^.$/su.test(event.key) &&
    event.key !== ' '
  );
}

const SCOPES: readonly PickerScope[] = ['all', 'selected'];

export interface LinkPickerDialogProps {
  readonly props: LinkPickerProps;
  readonly state: PickerState;
}

/**
 * The multi-link dialog (board "S4 · Chọn bản ghi liên kết", BACKLOG S4
 * design decision #1): ~880 px, search with "All | Selected N", the
 * records with check boxes on the left, the chosen ones in cell order on
 * the right (drag to reorder, "N / 500"), saved once with "Save N links".
 * A native modal `<dialog>`: the page is inert, Escape closes, the focus
 * starts in the search box and goes back to the cell (the caller).
 */
export function LinkPickerDialog({ props, state }: LinkPickerDialogProps) {
  const { t } = state;
  const titleId = useId();
  const subtitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const { onClose } = props;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (!element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    searchBox.current?.focus();
    const searchLength = searchBox.current?.value.length ?? 0;
    searchBox.current?.setSelectionRange(searchLength, searchLength);
    return () => {
      if (element.open && typeof element.close === 'function') element.close();
    };
  }, []);

  const count = state.selection.refs.length;
  const save = () => {
    state.finish(state.selection.refs);
  };
  const subtitle = t(state.multiple ? 'picker.subtitleMultiple' : 'picker.subtitleSingle', {
    record: props.recordLabel,
    field: props.field.name,
  });
  const listLabel = state.tableName;
  const createLabel =
    state.search.trim() === ''
      ? t('picker.createNew', { table: state.tableName })
      : t('picker.createNamed', { table: state.tableName, name: state.search.trim() });

  const onDialogKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };
  const mainSection = state.sections.find((section) => section.key === 'main');
  const heading = state.sections.length === 1 ? (mainSection?.heading ?? null) : null;

  return (
    <dialog
      ref={dialog}
      data-motion="center"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
      data-testid="link-picker-dialog"
      className={cn(
        'm-auto h-[min(680px,calc(100dvh-2rem))] open:flex w-[min(880px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-lg border border-line bg-surface p-0 text-body text-fg shadow-popover',
        'backdrop:bg-overlay',
      )}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onDialogKeyDown}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-line py-3 pr-4 pl-5">
        <Link2 aria-hidden="true" className="size-[18px] shrink-0 text-accent" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={titleId} className="truncate text-heading">
            {t('picker.title', { table: state.tableName })}
          </h2>
          <p id={subtitleId} className="truncate text-label font-normal text-fg-muted">
            {subtitle}
          </p>
        </div>
        <Tooltip content={t('picker.close')}>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 max-lg:size-control"
            aria-label={t('picker.close')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </header>
      <div className="flex shrink-0 items-center gap-2.5 px-5 pt-3 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line-control bg-surface px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft max-lg:h-control">
          <Search aria-hidden="true" className="size-[15px] shrink-0 text-fg-muted" />
          <span className="sr-only">{t('picker.search', { table: state.tableName })}</span>
          <input
            ref={searchBox}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={state.listId}
            aria-autocomplete="list"
            aria-activedescendant={state.activeOption?.id}
            autoComplete="off"
            spellCheck={false}
            data-testid="link-search"
            placeholder={t('picker.searchPlaceholder', {
              field: state.primary?.name ?? state.tableName,
            })}
            className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
            value={state.search}
            onChange={(event) => {
              state.setSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              handleListKey(event, state, { space: false });
            }}
          />
        </label>
        <div
          role="group"
          aria-label={t('picker.scope')}
          className="flex h-8 shrink-0 rounded-md bg-surface-sunken p-0.5 max-lg:h-control"
        >
          {SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              aria-pressed={state.scope === scope}
              data-testid={`link-scope-${scope}`}
              className={cn(
                'rounded-sm px-3 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                state.scope === scope
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'font-normal text-fg-muted hover:text-fg',
              )}
              onClick={() => {
                state.setScope(scope);
              }}
            >
              {scope === 'all' ? t('picker.all') : t('picker.selectedTab', { count })}
            </button>
          ))}
        </div>
      </div>
      {state.hasFilter ? (
        <FilterNote className="shrink-0 px-5 pb-2.5">
          {t('picker.filterNote', { table: state.tableName })}
        </FilterNote>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_290px] border-t border-line max-md:grid-cols-1">
        <div className="flex min-h-0 flex-col">
          {state.creating === null ? (
            <>
              <CandidateList
                state={state}
                size="dialog"
                label={listLabel}
                focusable
                header={
                  heading === null && !state.canSelectAll ? undefined : (
                    <div className="flex min-h-9 shrink-0 items-center gap-2 px-6 pt-2 text-label font-normal text-fg-muted">
                      <span className="min-w-0 truncate" role="status">
                        {heading}
                      </span>
                      {state.canSelectAll ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="ml-auto text-label"
                          onClick={state.toggleAll}
                        >
                          {state.allChosen
                            ? t('picker.unselectAll', { count: state.selectableCount })
                            : t('picker.selectAll', { count: state.selectableCount })}
                        </Button>
                      ) : null}
                    </div>
                  )
                }
                emptyAction={
                  state.canCreate ? (
                    <Button variant="secondary" size="sm" onClick={state.create}>
                      {createLabel}
                    </Button>
                  ) : undefined
                }
                onKeyDown={(event) => {
                  if (
                    handleListKey(event, state, {
                      space: true,
                      onEdge: () => {
                        searchBox.current?.focus();
                      },
                    })
                  ) {
                    return;
                  }
                  if (isTyping(event) || event.key === 'Backspace') searchBox.current?.focus();
                }}
              />
              {state.createError === null ? null : (
                <p role="alert" className="shrink-0 px-6 pb-2 text-label font-normal text-danger">
                  {state.createError}
                </p>
              )}
              {state.canCreate ? (
                <CreateButton
                  className="border-t border-line px-6"
                  label={createLabel}
                  hint={t('picker.createHint')}
                  onClick={state.create}
                />
              ) : null}
            </>
          ) : (
            <CreateRecordForm
              linkTable={state.linkTable}
              tableName={state.tableName}
              inputs={state.form.inputs}
              unsupported={state.form.unsupported}
              primary={state.primary}
              initialName={state.creating.name}
              locale={props.locale}
              onCreated={state.created}
              onCancel={() => {
                state.setCreating(null);
                searchBox.current?.focus();
              }}
            />
          )}
        </div>
        <aside
          aria-labelledby={`${titleId}-selected`}
          className="flex min-h-0 flex-col border-l border-line bg-canvas max-md:hidden"
        >
          <div className="flex flex-col gap-2 px-3.5 pt-3 pb-2">
            <div className="flex items-baseline gap-2">
              <h3 id={`${titleId}-selected`} className="text-body font-semibold">
                {t('picker.selected')}
              </h3>
              <span
                className="text-label font-normal text-fg-muted tabular-nums"
                data-testid="link-selected-count"
              >
                {t('picker.selectedCount', { count, limit: state.limit })}
              </span>
              {count > 0 ? (
                <Button
                  variant="link"
                  size="sm"
                  className="ml-auto text-label"
                  onClick={() => {
                    state.setSelection(model.clear(state.selection));
                  }}
                >
                  {t('picker.clearAll')}
                </Button>
              ) : null}
            </div>
            <div aria-hidden="true" className="h-1 rounded-full bg-line">
              <div
                className="h-1 min-w-1 rounded-full bg-accent"
                style={{ width: `${String(Math.min(100, (count / state.limit) * 100))}%` }}
              />
            </div>
          </div>
          <SelectedList
            refs={state.selection.refs}
            onRemove={(id) => {
              state.setSelection(model.remove(state.selection, id));
            }}
            onMove={(from, to) => {
              state.setSelection(model.move(state.selection, from, to));
            }}
          />
          <p className="mt-auto border-t border-line px-3.5 py-2.5 text-label font-normal text-fg-muted">
            {t('picker.dragHint')}
          </p>
        </aside>
      </div>
      <footer className="flex min-h-14 shrink-0 items-center gap-2 border-t border-line py-2 pr-4 pl-5">
        <KeyHints
          className="max-md:hidden"
          hints={[
            t('picker.keyMove'),
            t('picker.keyToggle'),
            t('picker.keySave', { mod: modKey() }),
            t('picker.keyClose'),
          ]}
        />
        <span className="ml-auto" />
        <Button variant="secondary" onClick={onClose}>
          {t('picker.cancel')}
        </Button>
        <Button data-testid="link-save" onClick={save}>
          {count === 0 ? t('picker.save') : t('picker.saveCount', { count })}
        </Button>
      </footer>
      <p className="sr-only" aria-live="polite">
        {state.announcement}
      </p>
    </dialog>
  );
}
