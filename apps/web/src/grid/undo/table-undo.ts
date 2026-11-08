import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { showToast } from '../../lib/toast/toast';
import { UndoHistory, type ReplayOutcome, type UndoSnapshot } from '../commands';

import { replayCommand, type ReplayController, type ReplayProblem } from './replay';

import type { EditCommand } from '../../lib/records/commands';
import type { UndoHooks } from '../hooks';

interface TableUndo {
  readonly history: UndoHistory;
  /** Given to the edit flow (`useGridEditing({ undo })`): every change becomes a step. */
  readonly hooks: UndoHooks;
}

/**
 * Undo stacks of this session, one per table (FRONTEND §6.1): leaving the
 * table and coming back keeps them; signing out reloads the document, which
 * ends the session and the stacks with it. The grid and the kanban board
 * (T314) of a table share its stack.
 */
const tables = new Map<string, TableUndo>();

export function tableUndo(tableId: string): TableUndo {
  let entry = tables.get(tableId);
  if (entry === undefined) {
    const history = new UndoHistory();
    entry = {
      history,
      hooks: {
        push: (command) => {
          history.push(command);
        },
      },
    };
    tables.set(tableId, entry);
  }
  return entry;
}

/** Forgets every stack (tests). */
export function resetUndoHistories(): void {
  tables.clear();
}

export interface GridUndo extends UndoSnapshot {
  readonly undo: () => void;
  readonly redo: () => void;
  /**
   * Undoes one given change of the stack (T1011: "Undo" of the selection
   * dock): `done`, `dropped` (refused or gone, reported), `kept` (failed for
   * now: still on the stack), or `null` when it is no longer there or a
   * replay is running.
   */
  readonly undoCommand: (command: EditCommand) => Promise<ReplayOutcome['status'] | null>;
  /** Whether that change is still on the undo stack (not undone with Ctrl/⌘+Z meanwhile). */
  readonly canUndoCommand: (command: EditCommand) => boolean;
}

/** Undo / redo of a table (grid, kanban): toolbar buttons and Ctrl/⌘+Z, Shift+Ctrl/⌘+Z, Ctrl+Y. */
export function useGridUndo(tableId: string, controller: ReplayController | null): GridUndo {
  const { t } = useTranslation('grid');
  const { history } = tableUndo(tableId);
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot);

  const report = useCallback(
    (problem: ReplayProblem) => {
      switch (problem) {
        case 'conflict':
          showToast({ message: t('undo.conflict') });
          return;
        case 'invalid':
          showToast({ variant: 'error', message: t('undo.invalid') });
          return;
        case 'gone':
          showToast({ message: t('undo.gone') });
          return;
        case 'failed':
          // The controller showed the error; the step stays to be tried again.
          return;
      }
    },
    [t],
  );

  const undo = useCallback(() => {
    if (controller === null) return;
    void history.undo((command) => replayCommand(controller, command, report));
  }, [history, controller, report]);

  const redo = useCallback(() => {
    if (controller === null) return;
    void history.redo((command) => replayCommand(controller, command, report));
  }, [history, controller, report]);

  const undoCommand = useCallback(
    async (command: EditCommand) => {
      if (controller === null) return null;
      const outcome = await history.undoCommand(command, (step) =>
        replayCommand(controller, step, report),
      );
      return outcome?.status ?? null;
    },
    [history, controller, report],
  );

  const canUndoCommand = useCallback(
    (command: EditCommand) => history.undoStack.includes(command),
    [history],
  );

  return { ...snapshot, undo, redo, undoCommand, canUndoCommand };
}
