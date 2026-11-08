import { Module } from '@nestjs/common';

import { AutomationModule } from '../automation/automation.module.js';
import { BaseModule } from '../base/base.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { FieldModule } from '../field/field.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { RecordModule } from '../record/record.module.js';
import { TableModule } from '../table/table.module.js';
import { ViewModule } from '../view/view.module.js';
import { WorkspaceModule } from '../workspace/workspace.module.js';

import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

/**
 * Built-in MCP server (CONTRACTS §30, ADR-40): `POST /api/v1/mcp` for API
 * tokens, tools over the services of the REST routes; `aggregate_records`
 * runs in the dashboards' widget query line; `draft_automation` keeps its
 * drafts with the automation module's.
 */
@Module({
  imports: [
    MetricsModule,
    WorkspaceModule,
    BaseModule,
    TableModule,
    FieldModule,
    ViewModule,
    RecordModule,
    DashboardModule,
    // `draft_automation` (T1015): the digest and check of automation drafts.
    AutomationModule,
  ],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
