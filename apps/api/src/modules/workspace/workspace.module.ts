import { Module } from '@nestjs/common';

import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
  // The MCP tools (T920) read through the same services.
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
