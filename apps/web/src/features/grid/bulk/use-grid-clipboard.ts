import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClipboardText,
  clipboardContent,
  clipboardKindOf,
  fillSourceRows,
  isEditableField,
  parseTsv,
  pastedDisplay,
  pastedWriteValue,
  pasteArea,
  planWrites,
  type CellEditHooks,
  type ClipboardContent,
  type GridField,
  type GridRecord,
  type GridSelectionRange,
  type PlannedWrite,
  type SelectionHooks,
} from '../../../grid';
import { canCopy } from '../../../lib/permissions/access';
import { toWriteValue } from '../../../lib/records/commands';
import { cellErrorMessage } from '../../../lib/records/notify';
import { showToast } from '../../../lib/toast/toast';

import type { RecordEditController } from '../../../lib/records/edit-controller';
import type { EffectiveAccess, RecordDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/** Rows one copy, paste, fill or clear may cover (larger ones are refused with a message). */
export const MAX_BULK_ROWS = 10_000;

/** The rows of the grid as the clipboard needs them. */
export interface BulkRowSource {
  readonly getRecord: (row: number) => RecordDto | undefined;
  readonly loadRows: (firstRow: number, lastRow: number) => Promise<(RecordDto | undefined)[]>;
}

/** What the last copy put on the clipboard, to paste values back without losing precision. */
interface CopiedCells {
  readonly text: string;
  readonly cells: readonly (readonly { readonly type: string; readonly value: unknown }[])[];
}

/**
 * The last copy of this session. When the pasted text is exactly what it
 * wrote, cells of the same field type take the copied json value (a
 * rating, a currency or a date round-trips even when the text would read
 * differently in the base locale); other cells are pasted as text.
 */
let lastCopy: CopiedCells | null = null;

function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

/** "Add N rows?" of a paste beyond the last row (FRONTEND §4.2). */
export interface AddRowsRequest {
  readonly count: number;
  readonly answer: (add: boolean) => void;
}

/** Records written so far of a bulk write spanning several requests. */
export interface BulkProgress {
  readonly done: number;
  readonly total: number;
}

export interface GridClipboardOptions {
  readonly access: EffectiveAccess | null | undefined;
  readonly fields: readonly GridField[];
  readonly rows: BulkRowSource;
  readonly rowCount: number;
  readonly locale: LocaleContext;
  readonly controller: RecordEditController;
  /** Cell editing of the grid; `undefined` when the user may not write (then paste and fill do nothing). */
  readonly edit: CellEditHooks | undefined;
  readonly canAdd: boolean;
}

export interface GridClipboard {
  readonly hooks: Omit<SelectionHooks, 'onSelectionChange'>;
  readonly addRows: AddRowsRequest | null;
  readonly progress: BulkProgress | null;
}

function rowsOf(range: GridSelectionRange): number {
  return range.lastRow - range.firstRow + 1;
}

/**
 * Copy, cut, paste, fill-down and clearing of the grid (FRONTEND §4.2,
 * §6.3, §6.4). Every change goes through `RecordEditController.writeCells`:
 * one bulk `PATCH` per 1 000 records, each one undo step; cells the user
 * may not write are skipped and counted in a toast.
 */
export function useGridClipboard({
  access,
  fields,
  rows,
  rowCount,
  locale,
  controller,
  edit,
  canAdd,
}: GridClipboardOptions): GridClipboard {
  const { t, i18n } = useTranslation('grid');
  const [addRows, setAddRows] = useState<AddRowsRequest | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const running = useRef(false);

  const fieldById = useMemo(
    () => new Map<string, GridField>(fields.map((field) => [field.field.id, field])),
    [fields],
  );
  const fieldsOf = useCallback(
    (range: GridSelectionRange) =>
      range.fieldIds.flatMap((fieldId) => {
        const field = fieldById.get(fieldId);
        return field === undefined ? [] : [field];
      }),
    [fieldById],
  );

  const canWrite = useCallback(
    (field: GridField, record: GridRecord) =>
      edit !== undefined &&
      isEditableField(field) &&
      edit.canEdit({ recordId: record.id, fieldId: field.field.id }, record),
    [edit],
  );

  /** Records of a range: at once when loaded, else after loading their blocks. */
  const recordsOf = useCallback(
    async (firstRow: number, lastRow: number) => {
      const loaded: (RecordDto | undefined)[] = [];
      for (let row = firstRow; row <= lastRow; row += 1) {
        const record = rows.getRecord(row);
        if (record === undefined) return rows.loadRows(firstRow, lastRow);
        loaded.push(record);
      }
      return loaded;
    },
    [rows],
  );

  /** Runs one bulk change at a time, with progress for changes of several requests. */
  const write = useCallback(
    async (
      writes: readonly PlannedWrite[],
      skipped: number,
      options: { typecast: boolean; records?: ReadonlyMap<string, RecordDto> },
    ) => {
      const total = new Set(writes.map((item) => item.recordId)).size;
      try {
        const result = await controller.writeCells(writes, {
          typecast: options.typecast,
          ...(options.records === undefined ? {} : { records: options.records }),
          onProgress: (done, all) => {
            setProgress(done < all ? { done, total: all } : null);
          },
        });
        if (total > 0 && result.failure === 'invalid') {
          // One reason for every refused cell (e.g. a title shared by two records): say it (T421a).
          const [reason, other] = result.invalidReasons;
          const why =
            reason === undefined || other !== undefined ? '' : cellErrorMessage(i18n, reason);
          const summary = t('clipboard.invalid', { count: result.invalidCells });
          showToast({
            variant: 'error',
            message: why === '' ? summary : `${summary} ${why}`,
          });
        } else if (result.failure === 'conflict') {
          showToast({ message: t('clipboard.conflict') });
        }
      } finally {
        setProgress(null);
      }
      if (skipped > 0) showToast({ message: t('clipboard.skipped', { count: skipped }) });
    },
    [controller, t, i18n],
  );

  /** One bulk operation at a time: the next waits for the previous to answer. */
  const exclusive = useCallback(
    (task: () => Promise<void>) => {
      if (running.current) {
        showToast({ message: t('clipboard.busy') });
        return;
      }
      running.current = true;
      void task().finally(() => {
        running.current = false;
      });
    },
    [t],
  );

  const tooLarge = useCallback(
    (count: number) => {
      if (count <= MAX_BULK_ROWS) return false;
      showToast({
        variant: 'error',
        message: t('clipboard.tooLarge', { max: MAX_BULK_ROWS.toLocaleString(locale.locale) }),
      });
      return true;
    },
    [t, locale.locale],
  );

  const clear = useCallback(
    async (ranges: readonly GridSelectionRange[]) => {
      const writes = new Map<string, PlannedWrite>();
      let skipped = 0;
      for (const range of ranges) {
        const records = await recordsOf(range.firstRow, range.lastRow);
        const plan = planWrites({
          records,
          fields: fieldsOf(range),
          canWrite,
          value: (_row, _column, field) => {
            const empty = field.config?.type === 'checkbox' ? false : null;
            return { value: empty, display: empty };
          },
        });
        skipped += plan.skipped;
        for (const item of plan.writes) writes.set(`${item.recordId} ${item.fieldId}`, item);
      }
      await write([...writes.values()], skipped, { typecast: false });
    },
    [recordsOf, fieldsOf, canWrite, write],
  );

  const onCopy = useCallback(
    (
      range: GridSelectionRange,
      cut: boolean,
    ): ClipboardContent | Promise<ClipboardContent | null> | null => {
      if (!canCopy(access)) {
        // A UX barrier (FRONTEND §6.3): the clipboard is left as it was.
        showToast({ message: t('clipboard.copyBlocked') });
        return null;
      }
      if (tooLarge(rowsOf(range))) return null;
      const columns = fieldsOf(range);
      const build = (records: readonly (RecordDto | undefined)[]) => {
        const cells = records.map((record) =>
          columns.map((field) => ({
            type: clipboardKindOf(field),
            value: record?.fields[field.field.id] ?? null,
          })),
        );
        const texts = records.map((record) =>
          columns.map((field) =>
            cellClipboardText(field, record?.fields[field.field.id] ?? null, locale),
          ),
        );
        const content = clipboardContent(texts);
        lastCopy = { text: content.text, cells };
        if (cut) exclusive(() => clear([range]));
        return content;
      };
      const loaded: RecordDto[] = [];
      for (let row = range.firstRow; row <= range.lastRow; row += 1) {
        const record = rows.getRecord(row);
        if (record === undefined) {
          return rows.loadRows(range.firstRow, range.lastRow).then(build, () => null);
        }
        loaded.push(record);
      }
      return build(loaded);
    },
    [access, t, tooLarge, fieldsOf, locale, rows, exclusive, clear],
  );

  const paste = useCallback(
    async (range: GridSelectionRange, text: string, addNewRows: boolean) => {
      const matrix = parseTsv(text);
      const anchorColumn = fields.findIndex((field) => field.field.id === range.fieldIds[0]);
      if (anchorColumn < 0) return;
      const area = pasteArea(
        matrix,
        { firstRow: range.firstRow, rows: rowsOf(range), columns: range.fieldIds.length },
        anchorColumn,
        fields.length,
        rowCount,
      );
      const columns = fields.slice(anchorColumn, anchorColumn + area.width);
      const existing = Math.max(0, Math.min(area.height, rowCount - range.firstRow));
      const records: (RecordDto | undefined)[] =
        existing === 0 ? [] : await recordsOf(range.firstRow, range.firstRow + existing - 1);
      let created: RecordDto[] = [];
      let dropped = 0;
      if (area.extraRows > 0) {
        created = addNewRows ? ((await controller.createRecords(area.extraRows)) ?? []) : [];
        // Rows that could not be added are not pasted.
        dropped = (area.extraRows - created.length) * area.width;
      }
      const copied = lastCopy !== null && sameText(lastCopy.text, text) ? lastCopy : null;
      const plan = planWrites({
        records: [...records, ...created],
        fields: columns,
        canWrite,
        value: (row, column, field, record) => {
          const source =
            copied?.cells[row % copied.cells.length]?.[column % (copied.cells[0]?.length ?? 1)];
          if (source !== undefined && source.type === clipboardKindOf(field)) {
            return { value: toWriteValue(source.value), display: source.value };
          }
          const cellText = area.textAt(row, column);
          const display = pastedDisplay(field, cellText, locale);
          return {
            value: pastedWriteValue(field, cellText),
            display: display === undefined ? (record.fields[field.field.id] ?? null) : display,
          };
        },
      });
      await write(plan.writes, plan.skipped + area.clipped + dropped, {
        typecast: true,
        records: new Map(created.map((record) => [record.id, record])),
      });
    },
    [fields, rowCount, recordsOf, controller, canWrite, locale, write],
  );

  const onPaste = useCallback(
    (range: GridSelectionRange, text: string) => {
      if (edit === undefined) {
        showToast({ message: t('clipboard.readOnly') });
        return;
      }
      const matrix = parseTsv(text);
      if (tooLarge(Math.max(matrix.length, rowsOf(range)))) return;
      const anchorColumn = fields.findIndex((field) => field.field.id === range.fieldIds[0]);
      const extraRows = pasteArea(
        matrix,
        { firstRow: range.firstRow, rows: rowsOf(range), columns: range.fieldIds.length },
        Math.max(0, anchorColumn),
        fields.length,
        rowCount,
      ).extraRows;
      if (extraRows > 0 && canAdd) {
        setAddRows({
          count: extraRows,
          answer: (add) => {
            setAddRows(null);
            exclusive(() => paste(range, text, add));
          },
        });
        return;
      }
      exclusive(() => paste(range, text, false));
    },
    [edit, t, tooLarge, fields, rowCount, canAdd, exclusive, paste],
  );

  const onFill = useCallback(
    (source: GridSelectionRange, destination: GridSelectionRange) => {
      if (edit === undefined) return;
      const firstRow = Math.min(source.firstRow, destination.firstRow);
      const lastRow = Math.max(source.lastRow, destination.lastRow);
      if (tooLarge(lastRow - firstRow + 1)) return;
      exclusive(async () => {
        const records = await recordsOf(firstRow, lastRow);
        const recordAt = (row: number) => records[row - firstRow];
        const sources = fillSourceRows(source, destination);
        const targets = sources.map((_, index) => recordAt(destination.firstRow + index));
        const plan = planWrites({
          records: targets,
          fields: fieldsOf(destination),
          canWrite,
          value: (row, _column, field) => {
            const from = sources[row];
            if (from === null || from === undefined) return undefined;
            const value = recordAt(from)?.fields[field.field.id] ?? null;
            return { value: toWriteValue(value), display: value };
          },
        });
        await write(plan.writes, plan.skipped, { typecast: false });
      });
    },
    [edit, tooLarge, exclusive, recordsOf, fieldsOf, canWrite, write],
  );

  const onClear = useCallback(
    (ranges: readonly GridSelectionRange[]) => {
      if (edit === undefined) return;
      if (tooLarge(ranges.reduce((sum, range) => sum + rowsOf(range), 0))) return;
      exclusive(() => clear(ranges));
    },
    [edit, tooLarge, exclusive, clear],
  );

  const hooks = useMemo(
    () => ({ onCopy, onPaste, onFill, onClear }),
    [onCopy, onPaste, onFill, onClear],
  );
  return { hooks, addRows, progress };
}
