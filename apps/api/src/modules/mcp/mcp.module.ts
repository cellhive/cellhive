import { Module } from '@nestjs/common';

import { BaseModule } from '../base/base.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

/**
 * Built-in MCP server (CONTRACTS §30, ADR-40): `POST /api/v1/mcp` for API
 * tokens, tools over the services of the REST routes.
 */
@Module({
  imports: [MetricsModule, WorkspaceModule, BaseModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
