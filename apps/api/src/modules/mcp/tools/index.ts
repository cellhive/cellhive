import { listBasesTool } from './bases.js';

import type { BaseService } from '../../base/base.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { McpTool } from '../tool-context.js';

/** Services the tools read through (the same as the REST routes). */
export interface McpToolServices {
  readonly workspaces: WorkspaceService;
  readonly bases: BaseService;
}

/**
 * Every MCP tool, in `tools/list` order (CONTRACTS §30). A new tool declares
 * its scope, `writes` and resource in its definition and gets a row in the
 * tool × scope lock (`test/unit/mcp-tools.test.ts`).
 */
export function mcpTools(services: McpToolServices): McpTool[] {
  return [listBasesTool(services.workspaces, services.bases)];
}
