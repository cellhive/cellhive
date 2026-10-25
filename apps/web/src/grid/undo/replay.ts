import { toWriteValue, type EditCommand, type UpdateCommand } from '../../lib/records/commands';

import type { RecordEditController } from '../../lib/records/edit-controller';
import type { ReplayOutcome, VersionRebase } from '../commands';

/** Why a replay was dropped or kept, for the message the page shows. */
export type ReplayProblem = 'conflict' | 'invalid' | 'gone' | 'failed';

/** The controller calls a replay needs (tests pass a fake). */
export type ReplayController = Pick<
  RecordEditController,
  'writeCells' | 'removeRecords' | 'restore'
>;

/**
 * Replays the inverse of a command (FRONTEND §6.1) and answers what the
 * undo stack does with it:
 * - `update` → bulk `PATCH` of `before` with `version = versionAfter`
 *   (`409` → dropped: the cell changed since); the answer is the inverse
 *   for redo, and the records are back at `versionBefore`'s state (rebase);
 * - `create` → soft delete; `delete` → `restore`.
 * `report` receives the reason of a drop (or of a kept command).
 */
export async function replayCommand(
  controller: ReplayController,
  command: EditCommand,
  report: (problem: ReplayProblem) => void,
): Promise<ReplayOutcome> {
  switch (command.kind) {
    case 'update':
      return replayUpdate(controller, command, report);
    case 'create': {
      const removed = await controller.removeRecords(command.recordIds, { emit: false });
      if (removed === null) {
        report('failed');
        return { status: 'kept' };
      }
      if (removed.recordIds.length === 0) {
        report('gone');
        return { status: 'dropped' };
      }
      return { status: 'done', inverse: removed };
    }
    case 'delete': {
      const restored = await controller.restore(command.recordIds, { emit: false });
      if (restored === null) {
        report('failed');
        return { status: 'kept' };
      }
      if (restored.length === 0) {
        report('gone');
        return { status: 'dropped' };
      }
      const rebases: VersionRebase[] = restored.flatMap((record) => {
        const from = command.versions?.[record.id];
        return from === undefined ? [] : [{ recordId: record.id, from, to: record.version }];
      });
      return {
        status: 'done',
        inverse: {
          kind: 'create',
          tableId: command.tableId,
          recordIds: restored.map((record) => record.id),
        },
        rebases,
      };
    }
  }
}

async function replayUpdate(
  controller: ReplayController,
  command: UpdateCommand,
  report: (problem: ReplayProblem) => void,
): Promise<ReplayOutcome> {
  const versions = new Map(command.changes.map((change) => [change.recordId, change.versionAfter]));
  const result = await controller.writeCells(
    command.changes.map((change) => ({
      recordId: change.recordId,
      fieldId: change.fieldId,
      value: toWriteValue(change.before),
      display: change.before,
      // The value it holds if the row is not on screen.
      before: change.after,
    })),
    { versions, emit: false },
  );
  switch (result.failure) {
    case null:
      break;
    case 'conflict':
      report('conflict');
      return { status: 'dropped' };
    case 'invalid':
      report('invalid');
      return { status: 'dropped' };
    case 'not_found':
    case 'denied':
      // The controller explained it already.
      return { status: 'dropped' };
    case 'schema_locked':
    case 'failed':
      return { status: 'kept' };
  }
  const changes = result.commands.flatMap((inverse) => inverse.changes);
  if (changes.length === 0) return { status: 'done', inverse: null };
  // The records are back where `versionBefore` left them, under a new version.
  const newVersions = new Map(changes.map((change) => [change.recordId, change.versionAfter]));
  const rebases: VersionRebase[] = [];
  const seen = new Set<string>();
  for (const change of command.changes) {
    const to = newVersions.get(change.recordId);
    if (seen.has(change.recordId) || change.versionBefore === undefined || to === undefined) {
      continue;
    }
    seen.add(change.recordId);
    rebases.push({ recordId: change.recordId, from: change.versionBefore, to });
  }
  return {
    status: 'done',
    inverse: { kind: 'update', tableId: command.tableId, changes },
    rebases,
  };
}
