import { listBasesTool } from './bases.js';
import { getRecordsTool, queryRecordsTool } from './records.js';
import { describeTableTool, listTablesTool } from './tables.js';

import type { AccessService } from '../../../common/access/access.service.js';
import type { BaseService } from '../../base/base.service.js';
import type { FieldService } from '../../field/field.service.js';
import type { RecordService } from '../../record/record.service.js';
import type { TableService } from '../../table/table.service.js';
import type { ViewService } from '../../view/view.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { McpTool } from '../tool-context.js';
import type { Db } from '@cellhive/server-core';

/** Services the tools read through (the same as the REST routes). */
export interface McpToolServices {
  readonly db: Db;
  readonly access: AccessService;
  readonly workspaces: WorkspaceService;
  readonly bases: BaseService;
  readonly tables: TableService;
  readonly fields: FieldService;
  readonly views: ViewService;
  readonly records: RecordService;
}

/**
 * Every MCP tool, in `tools/list` order (CONTRACTS §30). A new tool declares
 * its scope, `writes` and resource in its definition and gets a row in the
 * tool × scope lock (`test/unit/mcp-tools.test.ts`).
 */
export function mcpTools(services: McpToolServices): McpTool[] {
  const { db, access, tables, records } = services;
  return [
    listBasesTool(services.workspaces, services.bases),
    listTablesTool(access, tables),
    describeTableTool(access, tables, services.fields, services.views),
    queryRecordsTool(records, db),
    getRecordsTool(records, db),
  ];
}
