import type { RecordCache } from '../../../lib/records/edit-controller';
import type { RecordBlockLoader } from '../blocks/block-loader';
import type { RecordDto } from '@cellhive/contracts';

/**
 * The block cache of a grid as the edit flow sees it (FRONTEND §4.1): cells
 * are written into the cached blocks (every observer redraws), a created
 * record is appended, removed rows leave the blocks without holes.
 */
/**
 * A write's answer has no `meta` (no view, T816): the colors shown stay
 * until the realtime echo (or a refetch) brings the new ones.
 */
function keepMeta(record: RecordDto): (current: RecordDto) => RecordDto {
  return (current) =>
    record.meta === undefined && current.meta !== undefined
      ? { ...record, meta: current.meta }
      : record;
}

export function blockRecordCache(loader: RecordBlockLoader): RecordCache {
  return {
    get: (recordId) => loader.findRecord(recordId),
    patch: (recordId, fields) => {
      loader.updateRecord(recordId, (record) => ({
        ...record,
        fields: { ...record.fields, ...fields },
      }));
    },
    replace: (record) => {
      loader.updateRecord(record.id, keepMeta(record));
    },
    patchMany: (patches) => {
      loader.updateRecords(
        new Map(
          [...patches].map(([recordId, fields]) => [
            recordId,
            (record) => ({ ...record, fields: { ...record.fields, ...fields } }),
          ]),
        ),
      );
    },
    appendMany: (records) => {
      if (records.length === 1 && records[0] !== undefined) loader.insertAtEnd(records[0]);
      else {
        loader.insertManyAtEnd(
          records.length,
          records.map((record) => record.id),
        );
      }
    },
    replaceMany: (records) => {
      loader.updateRecords(new Map(records.map((record) => [record.id, keepMeta(record)])));
    },
    append: (record) => loader.insertAtEnd(record),
    // Rows move up in the loaded blocks (no hole), the count drops (T204).
    remove: (recordIds) => {
      loader.removeRecords(recordIds);
    },
  };
}
