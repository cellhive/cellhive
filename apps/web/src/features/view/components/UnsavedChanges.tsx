import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CircleDot, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { keys } from '../../../lib/query/keys';
import { showErrorToast, showToast } from '../../../lib/toast/toast';
import { useSaveAsPersonal } from '../mutations';
import { uniqueViewName } from '../names';

import type { ViewConfigState } from '../../../lib/views/use-view-config';
import type { ViewDto, ViewList } from '@cellhive/contracts';

export interface UnsavedChangesProps {
  readonly view: ViewDto;
  readonly state: ViewConfigState;
  /** Opens the personal copy made by "Save as personal view". */
  readonly onOpenView: (viewId: string) => void;
  /** Narrow screens: a single button with a menu instead of the pill. */
  readonly compact?: boolean;
}

/** `aria-keyshortcuts` of the button Ctrl/⌘+S presses. */
const SAVE_KEYS = 'Control+S Meta+S';

/** Ctrl/⌘+S (not with Shift or Alt). */
export function isSaveShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 's'
  );
}

/**
 * "Unsaved changes" of the open view (FRONTEND §3.2): temporary changes kept
 * on this device — filter, sort, group and row height (T311, like Lark),
 * and everything of those who may not save the view, a locked view, the
 * migrated T207 layout. T320b: a pill after the view tabs (Lark's
 * "Configured · Save · Clear") — Save (when allowed), save as a personal
 * view (BACKLOG S3 decision 4, named "<view> (personal)"), discard.
 * Ctrl/⌘+S saves into the view when allowed; otherwise it first says why
 * the view cannot be saved and offers the personal view.
 */
export function UnsavedChanges({ view, state, onOpenView, compact = false }: UnsavedChangesProps) {
  const { t } = useTranslation('view');
  const queryClient = useQueryClient();
  const saveAsPersonal = useSaveAsPersonal(view.table_id);
  const [explaining, setExplaining] = useState(false);

  const save = () => {
    void state.save().then((saved) => {
      if (saved)
        showToast({ variant: 'success', message: t('unsaved.saved', { name: view.name }) });
    });
  };
  const savePersonal = () => {
    // "<name> (personal)", unique among the user's personal views (not "… copy copy").
    const personal =
      queryClient
        .getQueryData<ViewList>(keys.views(view.table_id))
        ?.items.filter((item) => item.is_personal)
        .map((item) => item.name) ?? [];
    const name = uniqueViewName(t('unsaved.personalName', { name: view.name }), personal);
    saveAsPersonal.mutate(
      { source: view, name },
      {
        onSuccess: (copy) => {
          setExplaining(false);
          showToast({
            variant: 'success',
            message: t('unsaved.savedAsPersonal', { name: copy.name }),
          });
          onOpenView(copy.id);
        },
        onError: (error) => {
          showErrorToast(error);
        },
      },
    );
  };

  // Ctrl/⌘+S anywhere on the view screen (instead of the browser saving the page).
  const shortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    shortcut.current = () => {
      if (state.unsaved.length === 0 || state.saving || saveAsPersonal.isPending) return;
      if (state.canSave) save();
      // Not into this view (locked, no rights): say why before making a personal view.
      else if (!view.is_personal) setExplaining(true);
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event) || event.defaultPrevented) return;
      event.preventDefault();
      // Dialogs (rename, field settings) have their own buttons.
      if (event.target instanceof Element && event.target.closest('dialog') !== null) return;
      shortcut.current();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  const hint = state.canSave
    ? t('unsaved.hintSave')
    : view.locked
      ? t('unsaved.hintLocked')
      : t('unsaved.hintReadOnly');
  const explanation = (
    <Dialog
      open={explaining}
      onOpenChange={setExplaining}
      title={t('unsaved.explainTitle')}
      description={view.locked ? t('unsaved.explainLocked') : t('unsaved.explainReadOnly')}
      closeLabel={t('unsaved.explainCancel')}
    >
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            setExplaining(false);
          }}
        >
          {t('unsaved.explainCancel')}
        </Button>
        <Button disabled={saveAsPersonal.isPending} onClick={savePersonal}>
          {saveAsPersonal.isPending ? <Spinner /> : null}
          {t('unsaved.saveAsPersonal')}
        </Button>
      </div>
    </Dialog>
  );
  if (state.unsaved.length === 0) return explanation;

  const personalAction = view.is_personal ? null : (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-1.5 text-accent hover:bg-accent-soft"
      disabled={saveAsPersonal.isPending}
      aria-keyshortcuts={state.canSave ? undefined : SAVE_KEYS}
      onClick={savePersonal}
    >
      {saveAsPersonal.isPending ? <Spinner /> : null}
      {t('unsaved.saveAsPersonal')}
    </Button>
  );

  if (compact) {
    return (
      <div role="group" aria-label={t('unsaved.label')} className="flex shrink-0 items-center">
        <DropdownMenu>
          <Tooltip content={hint}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-warning"
                aria-label={t('unsaved.label')}
              >
                <CircleDot aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="max-w-72">
            {state.canSave ? (
              <DropdownMenuItem onSelect={save}>{t('unsaved.save')}</DropdownMenuItem>
            ) : null}
            {view.is_personal ? null : (
              <DropdownMenuItem disabled={saveAsPersonal.isPending} onSelect={savePersonal}>
                {t('unsaved.saveAsPersonal')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={state.discard}>{t('unsaved.discard')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {explanation}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('unsaved.label')}
      data-testid="unsaved-pill"
      className="flex h-7 shrink-0 items-center gap-0.5 self-center rounded-full border border-line-strong bg-surface pr-0.5 pl-2 text-label"
    >
      <span className="inline-flex items-center gap-1 font-medium text-warning" title={hint}>
        <CircleDot aria-hidden="true" className="size-3.5" />
        {t('unsaved.label')}
        <span className="sr-only">{hint}</span>
      </span>
      <span aria-hidden="true" className="px-0.5 text-fg-subtle">
        ·
      </span>
      {state.canSave ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-accent hover:bg-accent-soft"
            aria-keyshortcuts={SAVE_KEYS}
            onClick={save}
          >
            {t('unsaved.save')}
          </Button>
          {view.is_personal ? null : (
            <DropdownMenu>
              <Tooltip content={t('unsaved.more')}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    aria-label={t('unsaved.more')}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={saveAsPersonal.isPending} onSelect={savePersonal}>
                  {t('unsaved.saveAsPersonal')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      ) : (
        personalAction
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-fg-muted"
        onClick={state.discard}
      >
        {t('unsaved.discard')}
      </Button>
      {explanation}
    </div>
  );
}
