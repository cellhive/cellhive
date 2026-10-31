import {
  createRecordsInputSchema,
  MCP_WRITE_RECORDS_MAX,
  updateRecordsInputSchema,
  type RecordsResponse,
  type WriteRecordsResult,
} from '@cellhive/contracts';

import { shapeRecords } from '../shape.js';
import { defineTool, type McpTool } from '../tool-context.js';

import { DATA_NOTE } from './records.js';

import type { RecordService } from '../../record/record.service.js';

/** Writes of every MCP tool: field names, values as given — no option is ever created (CONTRACTS §30.5). */
const WRITE_PARAMS = { field_key_type: 'name', typecast: false } as const;

const WRITE_NOTE =
  'Use the field names and select options of describe_table; values are not converted and ' +
  'options are never created. On an error, nothing is written and each error names its ' +
  'records[i] path.';

/** The written records the caller still reads, cut like a read (CONTRACTS §30.3). */
function writeResultOf(response: RecordsResponse): WriteRecordsResult {
  const records = response.records.map((record) => ({ id: record.id, fields: record.fields }));
  const ids = records.map((record) => record.id);
  const shaped = shapeRecords(records, { record_ids: ids });
  return {
    record_ids: ids,
    records: shaped.records,
    truncated: shaped.dropped > 0,
    truncated_cells: shaped.truncated_cells,
  };
}

/**
 * `create_records` (CONTRACTS §30.5): `POST /tables/:id/records` through
 * `RecordService` — the same permissions, field rules and constraints;
 * the audit and events carry `via = { api_token_id, mcp: true }`.
 */
export function createRecordsTool(records: RecordService): McpTool {
  return defineTool({
    name: 'create_records',
    title: 'Create records',
    description:
      `Creates 1–${String(MCP_WRITE_RECORDS_MAX)} records in a table, all or none. ${WRITE_NOTE} ` +
      `Returns the new records. ${DATA_NOTE}`,
    scope: 'records:write',
    writes: true,
    input: createRecordsInputSchema,
    // A write can start automations that send email or call out.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    resource: (input) => ({ tableId: input.table_id }),
    async run(input, context) {
      const created = await records.createRecords(
        context.principal,
        input.table_id,
        WRITE_PARAMS,
        { records: input.records },
        context.meta,
      );
      return writeResultOf(created as RecordsResponse);
    },
  });
}

/** `update_records` (CONTRACTS §30.5): `PATCH /tables/:id/records`, only the given fields change. */
export function updateRecordsTool(records: RecordService): McpTool {
  return defineTool({
    name: 'update_records',
    title: 'Update records',
    description:
      `Changes the given fields of 1–${String(MCP_WRITE_RECORDS_MAX)} records of a table by ` +
      `id, all or none; other fields keep their value. ${WRITE_NOTE} Returns the records ` +
      `as they are now. ${DATA_NOTE}`,
    scope: 'records:write',
    writes: true,
    input: updateRecordsInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    resource: (input) => ({ tableId: input.table_id }),
    async run(input, context) {
      const updated = await records.updateRecords(
        context.principal,
        input.table_id,
        WRITE_PARAMS,
        { records: input.records },
        context.meta,
      );
      return writeResultOf(updated);
    },
  });
}
