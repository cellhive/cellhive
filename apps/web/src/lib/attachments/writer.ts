import { api } from '../api';
import { showToast } from '../toast/toast';

import { cellFilesOf, displayValueOf, writeValueOf, type CellFile } from './value';

import type { UploadHost } from './uploads';
import type { RecordEditController } from '../records/edit-controller';
import type { RecordDto } from '@cellhive/contracts';

export interface CellWriterOptions {
  readonly tableId: string;
  readonly controller: RecordEditController;
  /** The record as the screen holds it now (grid blocks, record query). */
  readonly findRecord: (recordId: string) => RecordDto | undefined;
  /** Toast text when a finished upload could not be written (record gone). */
  readonly attachFailed: () => string;
}

export interface CellWriter {
  readonly write: (recordId: string, fieldId: string, files: readonly CellFile[]) => void;
  readonly host: (recordId: string, fieldId: string) => UploadHost;
}

/**
 * Writes attachment cells through the edit flow (FRONTEND §4.1: optimistic
 * value, `version`, one undo step). A finished upload is appended to the
 * files the cell holds at that moment — not when the upload started, so
 * uploads finishing one after the other all stay. When the record left the
 * screen meanwhile (rows scrolled away) it is read again and written with
 * its version; when the screen itself is gone (the panel was closed while
 * the upload went on) it is written directly, and realtime shows it.
 */
export function createCellWriter(options: CellWriterOptions): CellWriter {
  const { tableId, controller, findRecord } = options;
  const write = (recordId: string, fieldId: string, files: readonly CellFile[]) => {
    void controller.commit({
      recordId,
      fieldId,
      value: writeValueOf(files),
      display: displayValueOf(files),
    });
  };
  const attachLater = async (recordId: string, fieldId: string, file: CellFile) => {
    try {
      const record = await api.records.get(tableId, recordId);
      const before = record.fields[fieldId] ?? null;
      const next = [...cellFilesOf(before), file];
      if (!controller.attached) {
        await api.records.update(tableId, [
          { id: record.id, version: record.version, fields: { [fieldId]: writeValueOf(next) } },
        ]);
        return;
      }
      const result = await controller.writeCells(
        [{ recordId, fieldId, value: writeValueOf(next), display: displayValueOf(next), before }],
        { versions: new Map([[recordId, record.version]]) },
      );
      if (result.failure !== null) throw new Error(result.failure);
    } catch {
      showToast({ variant: 'error', message: options.attachFailed() });
    }
  };
  return {
    write,
    host: (recordId, fieldId) => ({
      attach: (file) => {
        const record = findRecord(recordId);
        if (record === undefined || !controller.attached) {
          void attachLater(recordId, fieldId, file);
          return;
        }
        write(recordId, fieldId, [...cellFilesOf(record.fields[fieldId]), file]);
      },
    }),
  };
}
