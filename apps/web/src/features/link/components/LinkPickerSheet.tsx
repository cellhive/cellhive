import { Button, cn } from '@cellhive/ui';
import { Lock, Plus, Search, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import * as model from '../model/selection';

import { CandidateList, handleListKey } from './CandidateList';
import { CreateRecordForm } from './CreateRecordForm';
import { FilterNote } from './parts';
import { SelectedList } from './SelectedList';

import type { LinkPickerProps } from '../../../lib/links/picker';
import type { PickerState } from '../use-picker';

/** Chips of the chosen records shown before "+N" (board: four). */
const CHIPS_SHOWN = 4;

export interface LinkPickerSheetProps {
  readonly props: LinkPickerProps;
  readonly state: PickerState;
}

/**
 * The picker on phones (board "Chọn bản ghi liên kết" 390 px): the whole
 * screen, "Save (N)" at the top right, 44 px search, the chosen records as
 * chips ("Reorder" lists them with handles), 56 px rows, "+ Create …" at the
 * bottom. One record: choosing it saves at once. A native modal `<dialog>`.
 */
export function LinkPickerSheet({ props, state }: LinkPickerSheetProps) {
  const { t } = state;
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const [reordering, setReordering] = useState(false);
  const { onClose } = props;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (!element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    searchBox.current?.focus();
    return () => {
      if (element.open && typeof element.close === 'function') element.close();
    };
  }, []);

  const refs = state.selection.refs;
  const count = refs.length;
  const createLabel =
    state.search.trim() === ''
      ? t('picker.createNew', { table: state.tableName })
      : t('picker.createNamed', { table: state.tableName, name: state.search.trim() });

  return (
    <dialog
      ref={dialog}
      data-motion="sheet"
      aria-labelledby={titleId}
      data-testid="link-picker-sheet"
      className="m-0 h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden border-0 bg-surface p-0 text-body text-fg open:flex"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t('picker.close')}
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-[18px]" />
        </Button>
        <div className="flex min-w-0 flex-col">
          <h2 id={titleId} className="truncate text-heading">
            {t('picker.title', { table: state.tableName })}
          </h2>
          <p className="truncate text-label font-normal text-fg-muted">{props.recordLabel}</p>
        </div>
        {state.multiple ? (
          <Button
            className="ml-auto h-9 min-h-0"
            data-testid="link-save"
            onClick={() => {
              state.finish(refs);
            }}
          >
            {t('picker.saveShort', { count })}
          </Button>
        ) : null}
      </header>
      {state.creating === null ? (
        <>
          <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-2">
            <label className="flex h-11 items-center gap-2 rounded-lg border border-line-strong px-3 text-fg-muted focus-within:border-accent">
              <Search aria-hidden="true" className="size-4 shrink-0" />
              <span className="sr-only">{t('picker.search', { table: state.tableName })}</span>
              <input
                ref={searchBox}
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls={state.listId}
                aria-autocomplete="list"
                aria-activedescendant={state.activeOption?.id}
                autoComplete="off"
                data-testid="link-search"
                placeholder={t('picker.search', { table: state.tableName })}
                className="min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-fg-subtle"
                value={state.search}
                onChange={(event) => {
                  state.setSearch(event.target.value);
                }}
                onKeyDown={(event) => {
                  handleListKey(event, state, { space: false });
                }}
              />
            </label>
            {state.hasFilter ? (
              <FilterNote>{t('picker.filterNoteShort', { table: state.tableName })}</FilterNote>
            ) : null}
          </div>
          {state.multiple && count > 0 ? (
            <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 pt-1 pb-3">
              <div className="flex items-center">
                <span className="text-label text-fg">{t('picker.selected')}</span>
                <span className="ml-1.5 text-label font-normal text-fg-muted tabular-nums">
                  {t('picker.selectedCount', { count, limit: state.limit })}
                </span>
                <Button
                  variant="link"
                  className="ml-auto min-h-11 text-label"
                  aria-expanded={reordering}
                  onClick={() => {
                    setReordering((value) => !value);
                  }}
                >
                  {reordering ? t('picker.reorderDone') : t('picker.reorder')}
                </Button>
              </div>
              {reordering ? (
                <div className="-mx-2 flex max-h-[40dvh] min-h-0 flex-col">
                  <SelectedList
                    touch
                    refs={refs}
                    onRemove={(id) => {
                      state.setSelection(model.remove(state.selection, id));
                    }}
                    onMove={(from, to) => {
                      state.setSelection(model.move(state.selection, from, to));
                    }}
                  />
                </div>
              ) : (
                <ul className="flex flex-wrap gap-1.5" aria-label={t('picker.selected')}>
                  {refs.slice(0, CHIPS_SHOWN).map((ref) => (
                    <li
                      key={ref.id}
                      className={cn(
                        'inline-flex h-7 max-w-[150px] items-center gap-1 rounded-sm border border-line bg-surface-sunken px-2 text-label font-normal',
                        ref.title === null && 'text-fg-muted',
                      )}
                    >
                      {ref.title === null ? <Lock aria-hidden="true" className="size-3" /> : null}
                      <span className="truncate">{ref.title ?? t('picker.noAccess')}</span>
                    </li>
                  ))}
                  {count > CHIPS_SHOWN ? (
                    <li className="inline-flex h-7 items-center rounded-sm bg-surface-sunken px-1.5 text-label text-fg-muted tabular-nums">
                      +{count - CHIPS_SHOWN}
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
            <CandidateList state={state} size="sheet" label={state.tableName} focusable={false} />
          </div>
          {state.createError === null ? null : (
            <p role="alert" className="shrink-0 px-4 pb-2 text-label font-normal text-danger">
              {state.createError}
            </p>
          )}
          {state.canCreate ? (
            <div className="shrink-0 border-t border-line bg-surface px-4 pt-2 pb-4">
              <button
                type="button"
                data-testid="link-create"
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong text-heading font-medium text-accent"
                onClick={state.create}
              >
                <Plus aria-hidden="true" className="size-4" />
                <span className="truncate">{createLabel}</span>
              </button>
            </div>
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
          }}
        />
      )}
      <p className="sr-only" aria-live="polite">
        {state.announcement}
      </p>
    </dialog>
  );
}
